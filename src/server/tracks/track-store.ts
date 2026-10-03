import { AsyncLocalStorage } from 'node:async_hooks';
import { redis, type TxClientLike } from '@devvit/redis';
import { context } from '@devvit/web/server';
import { validateTrackQuality } from '../../../game/track/authoring/track-quality.js';
import { getMedalRowError, normalizeMedalRow } from '../../../game/track/authoring/medal-rules.js';
import { normalizeMedalRow as normalizeGameMedalRow } from '../../../game/medals/medal-timing.js';
import { isBuiltInTrack } from '../../../game/track/catalog.js';
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { isLiveGround } from '../../../game/track/live-grounds.js';
import { getTrackGround } from '../../../game/track/grounds.js';
import { setStoredTrackResolver } from '../../../game/track/stored-tracks.js';
import { createTrackFingerprint } from '../competition/pb-ghost-trace.js';
import {
    TrackInputError,
    normalizeDraftLoop,
    normalizeTrackShape,
    type Point,
    type TrackShape,
} from './track-shape.js';

import { acquireRedisLock, releaseRedisLock, type RedisLock } from '../redis/redis-lock.js';
import { TrackPlacementRetryError, withTrackPlacementLock, commitTrackPlacement } from './track-placement-lock.js';
import { getTrackCompletenessError } from './track-readiness.js';
import { isTrackInDailySchedule } from '../daily/daily-schedule-store.js';
import { findSeriesUsingTrack, readSeriesGround } from '../campaign/series-usage.js';

// Tracks made in the Creator, and copies of built-in tracks that nobody has
// raced. Each subreddit install has its own Redis, so each has its own list.

// A copy of a built-in track keeps the app row, which can have no author time.
export type AuthoredMedalRow = { author: number | null; gold: number; silver: number; bronze: number };
export type StoredTrackOrigin = 'creator' | 'migrated';
export type StoredTrackLockReason = 'daily' | 'series';

export type StoredTrackRecord = {
    version: 1;
    key: string;
    track: TrackShape;
    draftLoop: Point[];
    medalRow: AuthoredMedalRow | null;
    checksPassed: boolean;
    checkError: string | null;
    fingerprint: string;
    origin: StoredTrackOrigin;
    revision: number;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
    lockedAt: string | null;
    lockReason: StoredTrackLockReason | null;
};

export type StoredTrackSummary = Pick<StoredTrackRecord,
    'key' | 'checksPassed' | 'checkError' | 'origin' | 'revision' | 'updatedAt' | 'updatedBy'
    | 'lockedAt' | 'lockReason' | 'medalRow'> & { name: string; ground: string; ready: boolean };

// The form that the game uses to look up a track (game/track/stored-tracks.js).
// `placed` is true once players can race the track.
export type StoredTrackEntry = {
    key: string;
    name: string;
    ground: string;
    medalRow: ReturnType<typeof normalizeGameMedalRow>;
    track: Readonly<TrackShape>;
    placed: boolean;
};

// A save that started from an older revision of the track.
export class TrackConflictError extends Error {}

export const TRACK_KEY_RE = /^[a-z][A-Za-z0-9]{2,39}$/;
export const MAX_TRACK_NAME_LENGTH = 40;
const TRACK_KEY_PREFIX = 'dailygp:tracks:v1';
const INDEX_KEY = `${TRACK_KEY_PREFIX}:index`;
const REVISION_KEY = `${TRACK_KEY_PREFIX}:revision`;
const WRITE_LOCK_TTL_MS = 10_000;
const LOAD_BATCH_SIZE = 25;

// The index keeps one value per track: its revision and the time the record
// was made. A track that is deleted and made again starts at revision 1, but
// with a new time, so its value never repeats and a cache of the old track
// never answers for the new one. An older value holds only the revision.
export function storedTrackIndexValue(record: Pick<StoredTrackRecord, 'revision' | 'createdAt'>): string {
    return `${record.revision}:${record.createdAt}`;
}

export function recordMatchesIndexValue(
    record: Pick<StoredTrackRecord, 'revision' | 'createdAt'>,
    value: string | null | undefined,
): boolean {
    if (typeof value !== 'string' || !value) return false;
    return value.includes(':')
        ? value === storedTrackIndexValue(record)
        : value === String(record.revision);
}

function recordKey(trackKey: string): string {
    return `${TRACK_KEY_PREFIX}:track:${trackKey}`;
}

function writeLockKey(trackKey: string): string {
    return `${TRACK_KEY_PREFIX}:write-lock:${trackKey}`;
}

export function assertTrackKey(trackKey: unknown): string {
    if (typeof trackKey !== 'string' || !TRACK_KEY_RE.test(trackKey)) {
        throw new TrackInputError('A track key has 3 to 40 letters and digits and starts with a small letter.');
    }
    return trackKey;
}

function parseRecord(raw: string | null | undefined): StoredTrackRecord | null {
    if (!raw) return null;
    try {
        const record = JSON.parse(raw);
        return record?.version === 1 && typeof record.key === 'string' && record.track
            && typeof record.track === 'object' ? record as StoredTrackRecord : null;
    } catch {
        return null;
    }
}

function toEntry(record: StoredTrackRecord): StoredTrackEntry {
    const track = Object.freeze({ ...record.track });
    return Object.freeze({
        key: record.key,
        name: record.track.name,
        ground: getTrackGround(record.track).key,
        medalRow: normalizeGameMedalRow(record.medalRow),
        track,
        placed: Boolean(record.lockedAt),
    });
}

export function summarizeStoredTrack(record: StoredTrackRecord): StoredTrackSummary {
    return {
        key: record.key,
        name: record.track.name,
        ground: getTrackGround(record.track).key,
        checksPassed: record.checksPassed,
        checkError: record.checkError,
        origin: record.origin,
        revision: record.revision,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        lockedAt: record.lockedAt,
        lockReason: record.lockReason,
        medalRow: record.medalRow,
        ready: !getTrackCompletenessError(record.track, record.draftLoop, record.medalRow),
    };
}

// ---- The per-install cache that the game's track lookup reads ----
//
// A request loads only the tracks that it names. For each install the server
// keeps the track list (key -> index value), read again only when the list's
// revision changes, and the tracks that requests loaded, keyed by key and
// index value. Each request pins one list. Its lookups read that list and the
// loaded tracks. A listed track that the request did not load is an error that
// answers "retry": the lookup never falls back to the app layout.

export type StoredTrackIndex = {
    revision: string;
    values: ReadonlyMap<string, string>;
};

export class StoredTrackNotLoadedError extends TrackPlacementRetryError {
    readonly trackKey: string;

    constructor(trackKey: string) {
        super('The tracks could not load. Try again.');
        this.name = 'StoredTrackNotLoadedError';
        this.trackKey = trackKey;
    }
}

export const STORED_TRACKS_REVISION_KEY = REVISION_KEY;
// The list of saved tracks: one field per track key.
export const STORED_TRACKS_INDEX_KEY = INDEX_KEY;
export const storedTrackRecordKey = recordKey;

const MAX_LOADED_TRACKS_PER_INSTALL = 500;
const indexByInstall = new Map<string, StoredTrackIndex>();
const loadedByInstall = new Map<string, Map<string, StoredTrackEntry>>();
const pinnedIndex = new AsyncLocalStorage<{ index: StoredTrackIndex | null }>();

export function readStoredTrackInstallScope(): string | null {
    try {
        const id = (context as { subredditId?: unknown }).subredditId;
        if (typeof id === 'string' && id) return id;
        const name = (context as { subredditName?: unknown }).subredditName;
        return typeof name === 'string' && name ? name.toLowerCase() : null;
    } catch {
        // Outside a request there is no install, so there are no stored tracks.
        return null;
    }
}

function loadedKey(trackKey: string, indexValue: string): string {
    return `${trackKey}\n${indexValue}`;
}

function loadedTracks(scope: string): Map<string, StoredTrackEntry> {
    let loaded = loadedByInstall.get(scope);
    if (!loaded) {
        loaded = new Map();
        loadedByInstall.set(scope, loaded);
    }
    return loaded;
}

function keepLoadedTrack(scope: string, trackKey: string, indexValue: string, entry: StoredTrackEntry): void {
    const loaded = loadedTracks(scope);
    const key = loadedKey(trackKey, indexValue);
    loaded.delete(key);
    loaded.set(key, entry);
    if (loaded.size > MAX_LOADED_TRACKS_PER_INSTALL) {
        loaded.delete(loaded.keys().next().value as string);
    }
}

// The track list that this request reads: its pinned list, or else the
// install's newest list.
export function currentStoredTrackIndex(scope = readStoredTrackInstallScope()): StoredTrackIndex | null {
    if (!scope) return null;
    return pinnedIndex.getStore()?.index ?? indexByInstall.get(scope) ?? null;
}

// Every call makes its own holder, so two requests never share one.
export function runWithPinnedStoredTracks<T>(run: () => T): T {
    const scope = readStoredTrackInstallScope();
    return pinnedIndex.run({ index: scope ? indexByInstall.get(scope) ?? null : null }, run);
}

// Takes the install's newest list as this request's list from now on.
export function repinStoredTracks(): void {
    const pinned = pinnedIndex.getStore();
    const scope = readStoredTrackInstallScope();
    if (pinned && scope) pinned.index = indexByInstall.get(scope) ?? null;
}

export function resolveStoredTrackForRequest(trackKey: string): StoredTrackEntry | null {
    const scope = readStoredTrackInstallScope();
    const indexValue = currentStoredTrackIndex(scope)?.values.get(trackKey);
    if (!scope || indexValue === undefined) return null;
    const entry = loadedByInstall.get(scope)?.get(loadedKey(trackKey, indexValue));
    if (!entry) throw new StoredTrackNotLoadedError(trackKey);
    return entry;
}

// A track's place in the list needs no load.
export function storedTrackExistsForRequest(trackKey: string): boolean {
    return currentStoredTrackIndex()?.values.has(trackKey) === true;
}

// The placed stored tracks among these keys. The request must have loaded
// them: a listed track that is not loaded is never described as absent.
export function describePlacedStoredTracks(trackKeys: string[]): StoredTrackEntry[] {
    return [...new Set(trackKeys)].flatMap((trackKey) => {
        if (typeof trackKey !== 'string') return [];
        const entry = resolveStoredTrackForRequest(trackKey);
        return entry?.placed ? [entry] : [];
    });
}

export function installStoredTrackResolver(): void {
    setStoredTrackResolver(resolveStoredTrackForRequest, { exists: storedTrackExistsForRequest });
}

// The raw record of each key, in the order of the keys. The batches go out
// at the same time.
async function readRecordValues(trackKeys: string[]): Promise<(string | null)[]> {
    const batches: string[][] = [];
    for (let index = 0; index < trackKeys.length; index += LOAD_BATCH_SIZE) {
        batches.push(trackKeys.slice(index, index + LOAD_BATCH_SIZE));
    }
    const values = await Promise.all(batches.map(async (batch) => {
        const batchValues = await redis.mGet(batch.map(recordKey));
        if (!Array.isArray(batchValues) || batchValues.length !== batch.length) {
            throw new Error('The stored tracks could not be read.');
        }
        return batchValues;
    }));
    return values.flat().map((value) => value ?? null);
}

async function readRecords(trackKeys: string[]): Promise<Map<string, StoredTrackRecord>> {
    const records = new Map<string, StoredTrackRecord>();
    const values = await readRecordValues(trackKeys);
    trackKeys.forEach((trackKey, index) => {
        const record = parseRecord(values[index]);
        if (record?.key === trackKey) records.set(trackKey, record);
    });
    return records;
}

export function readStoredTrackCacheRevision(scope: string): string | null {
    return indexByInstall.get(scope)?.revision ?? null;
}

// Reads the track list for this revision. It does not publish it: the stored
// catalog publishes a list only when the revision did not change during the
// reads.
export async function readStoredTrackIndex(revision: string): Promise<StoredTrackIndex> {
    if (revision === '0') return { revision, values: new Map() };
    const index = (await redis.hGetAll(INDEX_KEY)) ?? {};
    if (typeof index !== 'object') throw new Error('The stored track list could not be read.');
    return { revision, values: new Map(Object.entries(index)) };
}

// Only a newer list replaces the cache. An equal one adds nothing.
export function publishStoredTrackIndex(scope: string, index: StoredTrackIndex): boolean {
    const current = indexByInstall.get(scope);
    if (current && Number(current.revision) >= Number(index.revision)) return false;
    indexByInstall.set(scope, index);
    return true;
}

// Loads the listed tracks among these keys that this request's list names and
// the cache does not hold yet, in one read. False when a record does not match
// the list: a write landed after the list was read.
export async function loadStoredTrackEntries(trackKeys: string[]): Promise<boolean> {
    const scope = readStoredTrackInstallScope();
    const index = currentStoredTrackIndex(scope);
    if (!scope || !index) return true;
    const loaded = loadedTracks(scope);
    const missing = [...new Set(trackKeys)].filter((trackKey) => {
        const indexValue = typeof trackKey === 'string' ? index.values.get(trackKey) : undefined;
        return indexValue !== undefined && !loaded.has(loadedKey(trackKey, indexValue));
    });
    if (!missing.length) return true;
    const values = await readRecordValues(missing);
    let matched = true;
    missing.forEach((trackKey, offset) => {
        const indexValue = index.values.get(trackKey) as string;
        const record = parseRecord(values[offset]);
        if (record?.key === trackKey && recordMatchesIndexValue(record, indexValue)) {
            keepLoadedTrack(scope, trackKey, indexValue, toEntry(record));
        } else {
            matched = false;
        }
    });
    return matched;
}

export function clearStoredTrackCacheForTests(): void {
    indexByInstall.clear();
    loadedByInstall.clear();
}

// ---- Reads ----

export async function readStoredTrack(trackKey: string): Promise<StoredTrackRecord | null> {
    if (!TRACK_KEY_RE.test(trackKey)) return null;
    return parseRecord(await redis.get(recordKey(trackKey)));
}

// The keys of every stored track, in one read.
export async function readStoredTrackKeys(): Promise<Set<string>> {
    return new Set(Object.keys((await redis.hGetAll(INDEX_KEY)) ?? {}));
}

// Every stored track with its shape, newest change first. Only the Creator
// reads this list.
export async function listStoredTrackRecords(): Promise<StoredTrackRecord[]> {
    const index = (await redis.hGetAll(INDEX_KEY)) ?? {};
    const records = await readRecords(Object.keys(index));
    return [...records.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function listStoredTracks(): Promise<StoredTrackSummary[]> {
    const index = (await redis.hGetAll(INDEX_KEY)) ?? {};
    const records = await readRecords(Object.keys(index));
    return [...records.values()]
        .map(summarizeStoredTrack)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// Players see a stored track only after it is placed: a Daily or a published
// series locks it. A track that is still being made stays private.
// The placed stored tracks among these keys. The index and the records are
// read at the same time, so the two reads must agree. A key is absent, and
// the app track is valid, only when it has no index field and no record.
// A field without a matching record, or a record without a field, is a write
// between the reads or a broken record. The reads run once more, and then the
// answer is "retry", never "absent".
export async function readPlacedStoredTracks(trackKeys: string[]): Promise<StoredTrackEntry[]> {
    const keys = [...new Set(trackKeys.filter((trackKey) => TRACK_KEY_RE.test(trackKey)))];
    if (!keys.length) return [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const [revisions, values] = await Promise.all([
            redis.hMGet(INDEX_KEY, keys),
            readRecordValues(keys),
        ]);
        const entries = agreeingPlacedEntries(keys, revisions, values);
        if (entries) return entries;
    }
    throw new TrackPlacementRetryError('The tracks could not load. Try again.');
}

function agreeingPlacedEntries(
    keys: string[],
    revisions: (string | null | undefined)[] | null | undefined,
    values: (string | null)[],
): StoredTrackEntry[] | null {
    if (!Array.isArray(revisions) || revisions.length !== keys.length) return null;
    const entries: StoredTrackEntry[] = [];
    for (const [index, trackKey] of keys.entries()) {
        const revision = revisions[index] ?? null;
        const raw = values[index];
        if (revision === null && raw === null) continue;
        const record = parseRecord(raw);
        if (revision === null || record?.key !== trackKey || !recordMatchesIndexValue(record, revision)) return null;
        if (record.lockedAt) entries.push(toEntry(record));
    }
    return entries;
}

// ---- Writes ----

async function withTrackWriteLock<T>(trackKey: string, work: (lock: RedisLock) => Promise<T>): Promise<T> {
    const lock = await acquireRedisLock(writeLockKey(trackKey), WRITE_LOCK_TTL_MS);
    if (!lock) throw new TrackConflictError('Someone else is saving this track. Try again.');
    try {
        return await work(lock);
    } finally {
        try {
            await releaseRedisLock(lock);
        } catch (error) {
            console.error(`Failed to release the write lock of track ${trackKey}:`, error);
        }
    }
}

export async function queueStoredTrackRecord(transaction: TxClientLike, record: StoredTrackRecord): Promise<void> {
    await transaction.set(recordKey(record.key), JSON.stringify(record));
    await transaction.hSet(INDEX_KEY, { [record.key]: storedTrackIndexValue(record) });
    await transaction.incrBy(REVISION_KEY, 1);
}

export async function queueStoredTrackRemoval(transaction: TxClientLike, trackKey: string): Promise<void> {
    await transaction.del(recordKey(trackKey));
    await transaction.hDel(INDEX_KEY, [trackKey]);
    await transaction.incrBy(REVISION_KEY, 1);
}

export async function isStoredTrackRemoved(trackKey: string): Promise<boolean> {
    return !await redis.get(recordKey(trackKey)) && !await redis.hGet(INDEX_KEY, trackKey);
}

export function freezeStoredTrack(record: StoredTrackRecord, reason: StoredTrackLockReason, now: Date): StoredTrackRecord {
    return record.lockedAt ? record : { ...record, revision: record.revision + 1, lockedAt: now.toISOString(), lockReason: reason };
}

export async function readStoredTracksRevision(): Promise<number> {
    return Number(await redis.get(REVISION_KEY) ?? 0);
}

export async function matchesStoredTrack(record: StoredTrackRecord, expectedRevision: number): Promise<boolean> {
    return await redis.get(recordKey(record.key)) === JSON.stringify(record)
        && await redis.hGet(INDEX_KEY, record.key) === storedTrackIndexValue(record)
        && await readStoredTracksRevision() === expectedRevision;
}

function runTrackChecks(track: TrackShape, draftLoop: Point[]): { checksPassed: boolean; checkError: string | null } {
    if (draftLoop.length || track.outer.length < 3 || track.inner.length < 3) {
        return { checksPassed: false, checkError: 'Finish the road.' };
    }
    const quality = validateTrackQuality(track);
    if (!quality.hasErrors) return { checksPassed: true, checkError: null };
    const problem = quality.issues.find((entry: { severity: string }) => entry.severity === 'error');
    return { checksPassed: false, checkError: problem?.message ?? 'The track did not pass the checks.' };
}

export type SaveStoredTrackOptions = {
    username: string;
    baseRevision?: unknown;
    origin?: StoredTrackOrigin;
    // Only for an exact copy of a built-in track: the app already approved
    // its shape and its medal times, so the checks do not run again.
    trusted?: boolean;
    now?: Date;
    assertUnplayed?: (trackKey: string) => Promise<void>;
};

// Creates a track, or saves a new revision of an unlocked one. A save must
// start from the current revision, so two devices cannot overwrite each other.
export async function saveStoredTrack(
    trackKeyInput: unknown,
    input: unknown,
    { username, baseRevision = 0, origin = 'creator', trusted = false, now = new Date(), assertUnplayed }: SaveStoredTrackOptions,
): Promise<StoredTrackRecord> {
    const trackKey = assertTrackKey(trackKeyInput);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TrackInputError('Track data must be an object.');
    }
    const payload = input as Record<string, unknown>;
    const track = normalizeTrackShape(payload.track, { maxNameLength: MAX_TRACK_NAME_LENGTH });
    if (!track.name) throw new TrackInputError('Give the track a name.');
    const draftLoop = normalizeDraftLoop(payload.draftLoop);
    let medalRow: AuthoredMedalRow | null = null;
    if (payload.medalRow !== null && payload.medalRow !== undefined) {
        if (trusted) {
            medalRow = normalizeGameMedalRow(payload.medalRow);
        } else {
            const error = getMedalRowError(payload.medalRow);
            if (error) throw new TrackInputError(error);
            medalRow = normalizeMedalRow(payload.medalRow) as AuthoredMedalRow;
        }
    }
    const { checksPassed, checkError } = trusted && !draftLoop.length
        ? { checksPassed: true, checkError: null }
        : runTrackChecks(track, draftLoop);

    return withTrackPlacementLock((placementLock) => withTrackWriteLock(trackKey, (trackLock) =>
        commitTrackPlacement([placementLock, trackLock], [], async () => {
            const existing = await readStoredTrack(trackKey);
            const expected = Number(baseRevision ?? 0);
            if ((existing?.revision ?? 0) !== expected) {
                throw new TrackConflictError('This track changed on another device.');
            }
            if (existing?.lockedAt) {
                throw new TrackInputError('This track is locked, because players have raced it.');
            }
            if (!existing && origin === 'creator' && isBuiltInTrack(trackKey)) {
                throw new TrackInputError('A track in the game already uses this key. Choose another name.');
            }
            if (assertUnplayed) await assertUnplayed(trackKey);
            const seriesId = await findSeriesUsingTrack(trackKey);
            const inDaily = await isTrackInDailySchedule(trackKey);
            const assigned = inDaily || Boolean(seriesId);
            const groundKey = getTrackGround(track).key;
            const previousGround = getTrackGround(existing?.track ?? BUILT_IN_TRACKS[trackKey as keyof typeof BUILT_IN_TRACKS]).key;
            if (inDaily && !isLiveGround(groundKey) && previousGround !== groundKey) {
                throw new TrackInputError('Take this track out of the Daily list before changing to a ground that is not live.');
            }
            if (assigned && getTrackCompletenessError(track, draftLoop, medalRow)) {
                throw new TrackInputError('Take this track out of the Daily list and the Campaign series before saving unfinished work.');
            }
            if (seriesId) {
                const ground = await readSeriesGround(seriesId);
                if (ground && groundKey !== ground) {
                    throw new TrackInputError('Take this track out of its Campaign series before changing its ground.');
                }
            }
            const stamp = now.toISOString();
            const record: StoredTrackRecord = {
                version: 1,
                key: trackKey,
                track,
                draftLoop,
                medalRow,
                checksPassed,
                checkError,
                fingerprint: createTrackFingerprint(track),
                origin: existing?.origin ?? origin,
                revision: (existing?.revision ?? 0) + 1,
                createdAt: existing?.createdAt ?? stamp,
                createdBy: existing?.createdBy ?? username,
                updatedAt: stamp,
                updatedBy: username,
                lockedAt: null,
                lockReason: null,
            };
            const cacheRevision = await readStoredTracksRevision() + 1;
            return { result: record, reconcile: () => matchesStoredTrack(record, cacheRevision),
                mutate: (transaction) => queueStoredTrackRecord(transaction, record) };
        })));
}

const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_MS = 150;

// Locks a stored track. It does nothing to a built-in track or to a track
// that is locked already. A save that holds the track at the same moment
// makes it wait and try again. Only tests call it, to set up a locked track:
// the game locks a track in the Daily or series placement (freezeStoredTrack).
export async function lockStoredTrack(
    trackKey: string,
    reason: StoredTrackLockReason,
    now = new Date(),
): Promise<boolean> {
    if (!TRACK_KEY_RE.test(trackKey)) return false;
    const current = await readStoredTrack(trackKey);
    if (!current || current.lockedAt) return false;
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await withTrackPlacementLock((placementLock) => withTrackWriteLock(trackKey, (trackLock) =>
                commitTrackPlacement([placementLock, trackLock], [], async () => {
                    const existing = await readStoredTrack(trackKey);
                    if (!existing || existing.lockedAt) return { result: false };
                    const frozen = freezeStoredTrack(existing, reason, now);
                    const cacheRevision = await readStoredTracksRevision() + 1;
                    return { result: true, reconcile: () => matchesStoredTrack(frozen, cacheRevision),
                        mutate: (transaction) => queueStoredTrackRecord(transaction, frozen) };
                })));
        } catch (error) {
            if (!(error instanceof TrackConflictError) || attempt >= LOCK_ATTEMPTS) throw error;
            await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS * attempt));
        }
    }
}

// Writes a locked copy of a played app track (track-copy.ts). It never
// replaces a track that Redis holds already, and answers whether it wrote.
export async function saveLockedTrackCopy(record: StoredTrackRecord): Promise<boolean> {
    return withTrackPlacementLock((placementLock) => withTrackWriteLock(record.key, (trackLock) =>
        commitTrackPlacement([placementLock, trackLock], [], async () => {
            if (await readStoredTrack(record.key)) return { result: false };
            const cacheRevision = await readStoredTracksRevision() + 1;
            return { result: true, reconcile: () => matchesStoredTrack(record, cacheRevision),
                mutate: (transaction) => queueStoredTrackRecord(transaction, record) };
        })));
}

export type DeleteStoredTrackOptions = {
    baseRevision?: unknown;
    isPlaced?: (trackKey: string) => Promise<boolean>;
};

// Removes an unlocked track that no list uses. For a copy of a built-in
// track, the game then uses the app copy again.
export async function deleteStoredTrack(
    trackKeyInput: unknown,
    { baseRevision, isPlaced }: DeleteStoredTrackOptions = {},
): Promise<boolean> {
    const trackKey = assertTrackKey(trackKeyInput);
    return withTrackPlacementLock((placementLock) => withTrackWriteLock(trackKey, (trackLock) =>
        commitTrackPlacement([placementLock, trackLock], [], async () => {
            const existing = await readStoredTrack(trackKey);
            if (!existing) return { result: false };
            if (baseRevision !== undefined && Number(baseRevision) !== existing.revision) {
                throw new TrackConflictError('This track changed on another device.');
            }
            if (existing.lockedAt) {
                throw new TrackInputError('This track is locked, because players have raced it.');
            }
            if (await isTrackInDailySchedule(trackKey) || await findSeriesUsingTrack(trackKey)
                || isPlaced && await isPlaced(trackKey)) {
                throw new TrackInputError('Take this track out of the Daily list and the Campaign series first.');
            }
            const cacheRevision = await readStoredTracksRevision() + 1;
            return { result: true, reconcile: async () => await isStoredTrackRemoved(trackKey)
                && await readStoredTracksRevision() === cacheRevision,
                mutate: (transaction) => queueStoredTrackRemoval(transaction, trackKey) };
        })));
}

// Removes a copy of an app track when `canRemove` accepts it. The game then
// reads the app track. Only the undo of a copy uses this. It is the one way
// a locked track goes, so the undo accepts only a copy that is exactly the
// app track: players race the same track as before.
export async function removeTrackCopy(
    trackKey: string,
    canRemove: (record: StoredTrackRecord) => boolean,
): Promise<'removed' | 'missing' | 'kept'> {
    assertTrackKey(trackKey);
    return withTrackPlacementLock((placementLock) => withTrackWriteLock(trackKey, (trackLock) =>
        commitTrackPlacement<'removed' | 'missing' | 'kept'>([placementLock, trackLock], [], async () => {
            const existing = await readStoredTrack(trackKey);
            if (!existing) return { result: 'missing' };
            if (existing.origin !== 'migrated' || !canRemove(existing)) return { result: 'kept' };
            const cacheRevision = await readStoredTracksRevision() + 1;
            return { result: 'removed', reconcile: async () => await isStoredTrackRemoved(trackKey)
                && await readStoredTracksRevision() === cacheRevision,
                mutate: (transaction) => queueStoredTrackRemoval(transaction, trackKey) };
        })));
}
