import { context, redis } from '@devvit/web/server';
import { validateTrackQuality } from '../../../game/track/authoring/track-quality.js';
import { getMedalRowError, normalizeMedalRow } from '../../../game/track/authoring/medal-rules.js';
import { normalizeMedalRow as normalizeGameMedalRow } from '../../../game/medals/medal-timing.js';
import { isBuiltInTrack } from '../../../game/track/catalog.js';
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

// Tracks made in the Creator, and copies of built-in tracks that nobody has
// raced. Each subreddit install has its own Redis, so each has its own list.

export type AuthoredMedalRow = { author: number; gold: number; silver: number; bronze: number };
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
    | 'lockedAt' | 'lockReason' | 'medalRow'> & { name: string; ground: string };

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
    };
}

// ---- The per-install cache that the game's track lookup reads ----

type InstallCache = {
    revision: string;
    revisionsByKey: Map<string, string>;
    entries: Map<string, StoredTrackEntry>;
};

const cacheByInstall = new Map<string, InstallCache>();

function readInstallScope(): string | null {
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

export function resolveStoredTrackForRequest(trackKey: string): StoredTrackEntry | null {
    const scope = readInstallScope();
    return scope ? cacheByInstall.get(scope)?.entries.get(trackKey) ?? null : null;
}

// The placed stored tracks among these keys, from this request's cache. An
// answer that names a track carries them, so the game needs no second request.
export function describePlacedStoredTracks(trackKeys: string[]): StoredTrackEntry[] {
    const scope = readInstallScope();
    const entries = scope ? cacheByInstall.get(scope)?.entries : null;
    if (!entries?.size) return [];
    return [...new Set(trackKeys)].flatMap((trackKey) => {
        const entry = typeof trackKey === 'string' ? entries.get(trackKey) : null;
        return entry?.placed ? [entry] : [];
    });
}

export function installStoredTrackResolver(): void {
    setStoredTrackResolver(resolveStoredTrackForRequest);
}

async function readRecords(trackKeys: string[]): Promise<Map<string, StoredTrackRecord>> {
    const records = new Map<string, StoredTrackRecord>();
    for (let index = 0; index < trackKeys.length; index += LOAD_BATCH_SIZE) {
        const batch = trackKeys.slice(index, index + LOAD_BATCH_SIZE);
        const values = await redis.mGet(batch.map(recordKey));
        batch.forEach((trackKey, offset) => {
            const record = parseRecord(values[offset]);
            if (record?.key === trackKey) records.set(trackKey, record);
        });
    }
    return records;
}

// Brings this install's stored tracks up to date before a request looks up a
// track. It reads one value when nothing changed, and only the changed tracks
// when a moderator saved something.
export async function ensureStoredTracksLoaded(): Promise<void> {
    const scope = readInstallScope();
    if (!scope) return;
    const revision = (await redis.get(REVISION_KEY)) ?? '0';
    const cached = cacheByInstall.get(scope);
    if (cached?.revision === revision) return;
    const index = revision === '0' ? {} : (await redis.hGetAll(INDEX_KEY)) ?? {};
    const revisionsByKey = new Map(Object.entries(index));
    const entries = new Map<string, StoredTrackEntry>();
    const changed: string[] = [];
    for (const [trackKey, trackRevision] of revisionsByKey) {
        const previous = cached?.entries.get(trackKey);
        if (previous && cached?.revisionsByKey.get(trackKey) === trackRevision) {
            entries.set(trackKey, previous);
        } else {
            changed.push(trackKey);
        }
    }
    for (const [trackKey, record] of await readRecords(changed)) {
        entries.set(trackKey, toEntry(record));
    }
    cacheByInstall.set(scope, { revision, revisionsByKey, entries });
}

export function clearStoredTrackCacheForTests(): void {
    cacheByInstall.clear();
}

// ---- Reads ----

export async function readStoredTrack(trackKey: string): Promise<StoredTrackRecord | null> {
    if (!TRACK_KEY_RE.test(trackKey)) return null;
    return parseRecord(await redis.get(recordKey(trackKey)));
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
export async function readPlacedStoredTracks(trackKeys: string[]): Promise<StoredTrackEntry[]> {
    const keys = [...new Set(trackKeys.filter((trackKey) => TRACK_KEY_RE.test(trackKey)))];
    const records = await readRecords(keys);
    return keys.flatMap((trackKey) => {
        const record = records.get(trackKey);
        return record?.lockedAt ? [toEntry(record)] : [];
    });
}

// ---- Writes ----

async function withTrackWriteLock<T>(trackKey: string, work: () => Promise<T>): Promise<T> {
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const acquired = await redis.set(writeLockKey(trackKey), token, {
        nx: true,
        expiration: new Date(Date.now() + WRITE_LOCK_TTL_MS),
    });
    if (!acquired) throw new TrackConflictError('Someone else is saving this track. Try again.');
    try {
        return await work();
    } finally {
        try {
            if (await redis.get(writeLockKey(trackKey)) === token) await redis.del(writeLockKey(trackKey));
        } catch (error) {
            console.error(`Failed to release the write lock of track ${trackKey}:`, error);
        }
    }
}

async function writeRecord(record: StoredTrackRecord): Promise<void> {
    await redis.set(recordKey(record.key), JSON.stringify(record));
    await redis.hSet(INDEX_KEY, { [record.key]: String(record.revision) });
    await redis.incrBy(REVISION_KEY, 1);
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
    now?: Date;
};

// Creates a track, or saves a new revision of an unlocked one. A save must
// start from the current revision, so two devices cannot overwrite each other.
export async function saveStoredTrack(
    trackKeyInput: unknown,
    input: unknown,
    { username, baseRevision = 0, origin = 'creator', now = new Date() }: SaveStoredTrackOptions,
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
        const error = getMedalRowError(payload.medalRow);
        if (error) throw new TrackInputError(error);
        medalRow = normalizeMedalRow(payload.medalRow) as AuthoredMedalRow;
    }
    const { checksPassed, checkError } = runTrackChecks(track, draftLoop);

    return withTrackWriteLock(trackKey, async () => {
        const existing = await readStoredTrack(trackKey);
        const expected = Number(baseRevision ?? 0);
        if ((existing?.revision ?? 0) !== expected) {
            throw new TrackConflictError('This track changed on another device. Open it again to see the new version.');
        }
        if (existing?.lockedAt) {
            throw new TrackInputError('This track is locked, because players have raced it.');
        }
        if (!existing && origin === 'creator' && isBuiltInTrack(trackKey)) {
            throw new TrackInputError('A track in the game already uses this key. Choose another name.');
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
        await writeRecord(record);
        return record;
    });
}

// Locks a stored track when players can start to race it. It does nothing to
// a built-in track or to a track that is locked already.
export async function lockStoredTrack(
    trackKey: string,
    reason: StoredTrackLockReason,
    now = new Date(),
): Promise<boolean> {
    if (!TRACK_KEY_RE.test(trackKey)) return false;
    const current = await readStoredTrack(trackKey);
    if (!current || current.lockedAt) return false;
    return withTrackWriteLock(trackKey, async () => {
        const existing = await readStoredTrack(trackKey);
        if (!existing || existing.lockedAt) return false;
        await writeRecord({
            ...existing,
            revision: existing.revision + 1,
            lockedAt: now.toISOString(),
            lockReason: reason,
        });
        return true;
    });
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
    return withTrackWriteLock(trackKey, async () => {
        const existing = await readStoredTrack(trackKey);
        if (!existing) return false;
        if (baseRevision !== undefined && Number(baseRevision) !== existing.revision) {
            throw new TrackConflictError('This track changed on another device. Open it again to see the new version.');
        }
        if (existing.lockedAt) {
            throw new TrackInputError('This track is locked, because players have raced it.');
        }
        if (isPlaced && await isPlaced(trackKey)) {
            throw new TrackInputError('Take this track out of the Daily list and the Campaign series first.');
        }
        await redis.del(recordKey(trackKey));
        await redis.hDel(INDEX_KEY, [trackKey]);
        await redis.incrBy(REVISION_KEY, 1);
        return true;
    });
}
