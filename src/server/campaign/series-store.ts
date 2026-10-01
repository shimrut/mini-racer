import { redis, type TxClientLike } from '@devvit/redis';
import { context } from '@devvit/web/server';
import seriesData from '../../../game/campaign/series.json' with { type: 'json' };
import { CAMPAIGN_NUMBERS_SERIES_ID, getCampaignSeries } from '../../../game/campaign/manifest.js';
import {
    CAMPAIGN_STAGE_MAX_LAPS,
    getCampaignSeriesMinStages,
    getRequiredMedalsError,
} from '../../../game/campaign/series-rules.js';
import { setStoredSeriesResolver } from '../../../game/campaign/stored-series.js';
import { hasTrack } from '../../../game/track/catalog.js';
import { getTrackGround, isTrackGroundKey } from '../../../game/track/grounds.js';
import { isLiveGround } from '../../../game/track/live-grounds.js';
import { TrackInputError } from '../tracks/track-shape.js';
import {
    TrackConflictError, queueStoredTrackRecord, freezeStoredTrack, matchesStoredTrack, readStoredTrack,
    readStoredTrackKeys, readStoredTracksRevision, type StoredTrackRecord,
} from '../tracks/track-store.js';
import { buildLockedTrackCopy } from '../tracks/track-copy.js';

import { acquireRedisLock, releaseRedisLock, type RedisLock } from '../redis/redis-lock.js';
import { withTrackPlacementLock, commitTrackPlacement } from '../tracks/track-placement-lock.js';
import { readCompleteTrack } from '../tracks/track-readiness.js';

// Campaign series made in the Creator, and copies of the app series that are
// not live. A draft is private. A published series is live for players: its
// stages are fixed, and new stages can only go after the last one.

export type StoredSeriesStage = { trackKey: string; laps: number; requiredMedals: number };
export type StoredSeriesStatus = 'draft' | 'published';

export type StoredSeriesRecord = {
    version: 1;
    id: string;
    name: string;
    ground: string;
    stages: StoredSeriesStage[];
    status: StoredSeriesStatus;
    // The stages that players can race. They cannot change.
    publishedStageCount: number;
    publishedAt: string | null;
    origin: 'creator' | 'migrated';
    revision: number;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
};

export type StoredSeriesDefinition = {
    id: string;
    name: string;
    ground: string;
    stages: StoredSeriesStage[];
};

export const SERIES_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_SERIES_ID_LENGTH = 40;
const MAX_SERIES_NAME_LENGTH = 40;
const MAX_SERIES_STAGES = 50;
const SERIES_PREFIX = 'dailygp:campaign:series:v1';
const INDEX_KEY = `${SERIES_PREFIX}:index`;
const REVISION_KEY = `${SERIES_PREFIX}:revision`;
const WRITE_LOCK_TTL_MS = 10_000;

type AppSeriesDefinition = { id: string; name?: string; ground?: string; stages?: StoredSeriesStage[] };
const APP_SERIES_DEFINITIONS = ((seriesData as { series?: AppSeriesDefinition[] }).series ?? []);
const APP_SERIES_IDS = new Set(APP_SERIES_DEFINITIONS.map((series) => series.id));

function recordKey(seriesId: string): string {
    return `${SERIES_PREFIX}:series:${seriesId}`;
}

function writeLockKey(seriesId: string): string {
    return `${SERIES_PREFIX}:write-lock:${seriesId}`;
}

export function assertSeriesId(value: unknown): string {
    if (typeof value !== 'string' || !SERIES_ID_RE.test(value) || value.length > MAX_SERIES_ID_LENGTH) {
        throw new TrackInputError('A series key has small letters, digits and dashes, and starts with a letter.');
    }
    if (value === CAMPAIGN_NUMBERS_SERIES_ID) {
        throw new TrackInputError('Numbers stays in the app. Choose another series key.');
    }
    return value;
}

function parseRecord(raw: string | null | undefined): StoredSeriesRecord | null {
    if (!raw) return null;
    try {
        const record = JSON.parse(raw);
        return record?.version === 1 && typeof record.id === 'string' && Array.isArray(record.stages)
            ? record as StoredSeriesRecord : null;
    } catch {
        return null;
    }
}

export function toSeriesDefinition(record: StoredSeriesRecord): StoredSeriesDefinition {
    return {
        id: record.id,
        name: record.name,
        ground: record.ground,
        // Players see only the published stages.
        stages: record.stages.slice(0, record.publishedStageCount).map((stage) => ({ ...stage })),
    };
}

// ---- The per-install cache that the Campaign manifest reads ----

type InstallCache = { revision: string; published: readonly StoredSeriesDefinition[] };
const cacheByInstall = new Map<string, InstallCache>();
const EMPTY: readonly StoredSeriesDefinition[] = Object.freeze([]);

function readInstallScope(): string | null {
    try {
        const id = (context as { subredditId?: unknown }).subredditId;
        if (typeof id === 'string' && id) return id;
        const name = (context as { subredditName?: unknown }).subredditName;
        return typeof name === 'string' && name ? name.toLowerCase() : null;
    } catch {
        return null;
    }
}

export function resolveStoredSeriesForRequest(): readonly StoredSeriesDefinition[] {
    const scope = readInstallScope();
    return scope ? cacheByInstall.get(scope)?.published ?? EMPTY : EMPTY;
}

export function installStoredSeriesResolver(): void {
    setStoredSeriesResolver(resolveStoredSeriesForRequest);
}

async function readAllRecords(): Promise<StoredSeriesRecord[]> {
    const index = (await redis.hGetAll(INDEX_KEY)) ?? {};
    if (typeof index !== 'object') throw new Error('The stored series list could not be read.');
    const ids = Object.keys(index);
    if (!ids.length) return [];
    const values = await redis.mGet(ids.map(recordKey));
    if (!Array.isArray(values) || values.length !== ids.length) {
        throw new Error('The stored series could not be read.');
    }
    return ids.flatMap((id, offset) => {
        const record = parseRecord(values[offset]);
        return record?.id === id ? [record] : [];
    });
}

// The published series at one revision of the series list.
export type StoredSeriesSnapshot = InstallCache;

export const STORED_SERIES_REVISION_KEY = REVISION_KEY;

export function readStoredSeriesCacheRevision(scope: string): string | null {
    return cacheByInstall.get(scope)?.revision ?? null;
}

// Reads the published series for this revision. The stored catalog publishes
// the snapshot only when the revision did not change during the reads.
export async function readStoredSeriesSnapshot(revision: string): Promise<StoredSeriesSnapshot> {
    const records = revision === '0' ? [] : await readAllRecords();
    const published = Object.freeze(records
        .filter((record) => record.status === 'published' && record.publishedStageCount > 0)
        .sort((a, b) => Date.parse(a.publishedAt ?? '') - Date.parse(b.publishedAt ?? ''))
        .map((record) => Object.freeze(toSeriesDefinition(record))));
    return { revision, published };
}

// Only a newer snapshot replaces the cache. An equal one adds nothing.
export function publishStoredSeriesSnapshot(scope: string, snapshot: StoredSeriesSnapshot): boolean {
    const current = cacheByInstall.get(scope);
    if (current && Number(current.revision) >= Number(snapshot.revision)) return false;
    cacheByInstall.set(scope, snapshot);
    return true;
}

export function clearStoredSeriesCacheForTests(): void {
    cacheByInstall.clear();
}

// ---- Reads ----

export async function readStoredSeries(seriesId: string): Promise<StoredSeriesRecord | null> {
    if (!SERIES_ID_RE.test(seriesId)) return null;
    return parseRecord(await redis.get(recordKey(seriesId)));
}

export async function listStoredSeries(): Promise<StoredSeriesRecord[]> {
    return (await readAllRecords()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function isTrackInStoredSeries(trackKey: string, exceptSeriesId?: string): Promise<boolean> {
    return (await readAllRecords()).some((record) => record.id !== exceptSeriesId
        && record.stages.some((stage) => stage.trackKey === trackKey));
}

// The app series that are not in Redis yet. A copy of a hidden app series
// replaces it after it is published.
export function listAppSeriesDefinitions(): AppSeriesDefinition[] {
    return APP_SERIES_DEFINITIONS;
}

// ---- Writes ----

async function withSeriesWriteLock<T>(seriesId: string, work: (lock: RedisLock) => Promise<T>): Promise<T> {
    const lock = await acquireRedisLock(writeLockKey(seriesId), WRITE_LOCK_TTL_MS);
    if (!lock) throw new TrackConflictError('Someone else is saving this series. Try again.');
    try {
        return await work(lock);
    } finally {
        try {
            await releaseRedisLock(lock);
        } catch (error) {
            console.error(`Failed to release the write lock of series ${seriesId}:`, error);
        }
    }
}

async function queueRecord(transaction: TxClientLike, record: StoredSeriesRecord): Promise<void> {
    await transaction.set(recordKey(record.id), JSON.stringify(record));
    await transaction.hSet(INDEX_KEY, { [record.id]: String(record.revision) });
    await transaction.incrBy(REVISION_KEY, 1);
}

async function matchesRecord(record: StoredSeriesRecord, cacheRevision: number): Promise<boolean> {
    return await redis.get(recordKey(record.id)) === JSON.stringify(record)
        && await redis.hGet(INDEX_KEY, record.id) === String(record.revision)
        && Number(await redis.get(REVISION_KEY) ?? 0) === cacheRevision;
}

async function trackUsedElsewhere(trackKey: string, seriesId: string): Promise<boolean> {
    const { isTrackInDailySchedule } = await import('../daily/daily-schedule-store.js');
    const { findSeriesUsingTrack } = await import('./series-usage.js');
    return await isTrackInDailySchedule(trackKey) || Boolean(await findSeriesUsingTrack(trackKey, seriesId));
}

function normalizeStages(value: unknown): StoredSeriesStage[] {
    if (!Array.isArray(value) || value.length > MAX_SERIES_STAGES) {
        throw new TrackInputError(`A series can have at most ${MAX_SERIES_STAGES} stages.`);
    }
    const stages = value.map((stage, index): StoredSeriesStage => {
        const input = stage && typeof stage === 'object' ? stage as Record<string, unknown> : {};
        const trackKey = typeof input.trackKey === 'string' ? input.trackKey : '';
        if (!hasTrack(trackKey)) throw new TrackInputError(`Stage ${index + 1} has no track.`);
        const laps = Number(input.laps);
        if (!Number.isInteger(laps) || laps < 1 || laps > CAMPAIGN_STAGE_MAX_LAPS) {
            throw new TrackInputError(`Laps must be a whole number from 1 to ${CAMPAIGN_STAGE_MAX_LAPS}.`);
        }
        return { trackKey, laps, requiredMedals: Number(input.requiredMedals) };
    });
    const keys = stages.map((stage) => stage.trackKey);
    if (new Set(keys).size !== keys.length) {
        throw new TrackInputError('A track can be in a series only once.');
    }
    stages.forEach((stage, index) => {
        const error = getRequiredMedalsError(
            stage.requiredMedals,
            index,
            index > 0 ? stages[index - 1].requiredMedals : 0,
        );
        if (error) throw new TrackInputError(`Stage ${index + 1}: ${error}`);
    });
    return stages;
}

function sameStage(a: StoredSeriesStage | undefined, b: StoredSeriesStage | undefined): boolean {
    return Boolean(a && b) && a!.trackKey === b!.trackKey && a!.laps === b!.laps
        && a!.requiredMedals === b!.requiredMedals;
}

export type SaveStoredSeriesOptions = {
    username: string;
    baseRevision?: unknown;
    origin?: 'creator' | 'migrated';
    // Checks each stage track against the other series and the Daily list.
    isTrackUsedElsewhere?: (trackKey: string, seriesId: string) => Promise<boolean>;
    now?: Date;
};

export async function saveStoredSeries(
    seriesIdInput: unknown,
    input: unknown,
    { username, baseRevision = 0, origin = 'creator', isTrackUsedElsewhere, now = new Date() }: SaveStoredSeriesOptions,
): Promise<StoredSeriesRecord> {
    const id = assertSeriesId(seriesIdInput);
    const payload = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown> : {};
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name || name.length > MAX_SERIES_NAME_LENGTH) {
        throw new TrackInputError(`Give the series a name of at most ${MAX_SERIES_NAME_LENGTH} characters.`);
    }
    if (!isTrackGroundKey(payload.ground)) throw new TrackInputError('Choose the ground of the series.');
    const ground = payload.ground as string;
    const stages = normalizeStages(payload.stages);

    return withTrackPlacementLock((placementLock) => withSeriesWriteLock(id, (seriesLock) =>
        commitTrackPlacement([placementLock, seriesLock], [], async () => {
            const existing = await readStoredSeries(id);
            if ((existing?.revision ?? 0) !== Number(baseRevision ?? 0)) {
                throw new TrackConflictError('This series changed on another device. Open it again to see the new version.');
            }
            if (!existing && origin === 'creator' && APP_SERIES_IDS.has(id)) {
                throw new TrackInputError('A series in the game already uses this key. Choose another key.');
            }
            const fixed = existing?.publishedStageCount ?? 0;
            if (fixed > 0) {
                if (ground !== existing!.ground) {
                    throw new TrackInputError(`${existing!.name} is live, so its ground cannot change.`);
                }
                for (let index = 0; index < fixed; index += 1) {
                    if (!sameStage(stages[index], existing!.stages[index])) {
                        throw new TrackInputError(
                            `${existing!.name} is live, so its first ${fixed} stages are fixed. New stages go after them.`,
                        );
                    }
                }
            }
            for (const stage of stages.slice(fixed)) {
                const complete = await readCompleteTrack(stage.trackKey);
                if (getTrackGround(complete.track).key !== ground) {
                    throw new TrackInputError(`${complete.track.name} is on another ground than the series.`);
                }
                if (await (isTrackUsedElsewhere ?? trackUsedElsewhere)(stage.trackKey, id)) {
                    throw new TrackInputError(`${complete.track.name} is used somewhere else already.`);
                }
            }
            const stamp = now.toISOString();
            const record: StoredSeriesRecord = {
                version: 1,
                id,
                name,
                ground,
                stages,
                status: existing?.status ?? 'draft',
                publishedStageCount: fixed,
                publishedAt: existing?.publishedAt ?? null,
                origin: existing?.origin ?? origin,
                revision: (existing?.revision ?? 0) + 1,
                createdAt: existing?.createdAt ?? stamp,
                createdBy: existing?.createdBy ?? username,
                updatedAt: stamp,
                updatedBy: username,
            };
            const cacheRevision = Number(await redis.get(REVISION_KEY) ?? 0) + 1;
            return { result: record, reconcile: () => matchesRecord(record, cacheRevision),
                mutate: (transaction) => queueRecord(transaction, record) };
        })));
}

// Makes the series live, or makes its new stages live. The stages cannot
// change after this, and their stored tracks are locked.
export async function publishStoredSeries(
    seriesIdInput: unknown,
    { username, baseRevision, now = new Date() }: { username: string; baseRevision?: unknown; now?: Date },
): Promise<StoredSeriesRecord> {
    const id = assertSeriesId(seriesIdInput);
    return withTrackPlacementLock((placementLock) => withSeriesWriteLock(id, (seriesLock) =>
        commitTrackPlacement([placementLock, seriesLock], [], async () => {
            const existing = await readStoredSeries(id);
            if (!existing) throw new TrackInputError('Save the series first.');
            if (baseRevision !== undefined && Number(baseRevision) !== existing.revision) {
                throw new TrackConflictError('This series changed on another device. Open it again to see the new version.');
            }
            if (!isLiveGround(existing.ground)) {
                throw new TrackInputError('Only a series on a live ground can go live. Other grounds need an app release.');
            }
            if (existing.stages.length < getCampaignSeriesMinStages(existing)) {
                throw new TrackInputError('Add more stages before the series goes live.');
            }
            if (existing.stages.length === existing.publishedStageCount) {
                throw new TrackInputError('Every stage of this series is live already.');
            }
            const tracksToLock = [];
            for (const stage of existing.stages.slice(existing.publishedStageCount)) {
                const complete = await readCompleteTrack(stage.trackKey);
                if (getTrackGround(complete.track).key !== existing.ground) {
                    throw new TrackInputError(`${complete.track.name} is on another ground than the series.`);
                }
                if (await trackUsedElsewhere(stage.trackKey, id)) {
                    throw new TrackInputError(`${complete.track.name} is used somewhere else already.`);
                }
                if (complete.stored && !complete.stored.lockedAt) tracksToLock.push(complete.stored);
            }
            const record: StoredSeriesRecord = {
                ...existing,
                status: 'published',
                publishedStageCount: existing.stages.length,
                publishedAt: existing.publishedAt ?? now.toISOString(),
                revision: existing.revision + 1,
                updatedAt: now.toISOString(),
                updatedBy: username,
            };
            const frozenTracks = tracksToLock.map((track) => freezeStoredTrack(track, 'series', now));
            const trackCacheRevision = await readStoredTracksRevision() + frozenTracks.length;
            const seriesCacheRevision = Number(await redis.get(REVISION_KEY) ?? 0) + 1;
            return { result: record,
                reconcile: async () => await matchesRecord(record, seriesCacheRevision)
                    && (await Promise.all(frozenTracks.map((track) => matchesStoredTrack(track, trackCacheRevision)))).every(Boolean),
                mutate: async (transaction) => {
                    for (const track of frozenTracks) await queueStoredTrackRecord(transaction, track);
                    await queueRecord(transaction, record);
                } };
        })));
}

export async function deleteStoredSeries(
    seriesIdInput: unknown,
    { baseRevision }: { baseRevision?: unknown } = {},
): Promise<boolean> {
    const id = assertSeriesId(seriesIdInput);
    return withTrackPlacementLock((placementLock) => withSeriesWriteLock(id, (seriesLock) =>
        commitTrackPlacement([placementLock, seriesLock], [], async () => {
            const existing = await readStoredSeries(id);
            if (!existing) return { result: false };
            if (baseRevision !== undefined && Number(baseRevision) !== existing.revision) {
                throw new TrackConflictError('This series changed on another device. Open it again to see the new version.');
            }
            if (existing.publishedStageCount > 0) {
                throw new TrackInputError(`${existing.name} is live, so it cannot be deleted.`);
            }
            const cacheRevision = Number(await redis.get(REVISION_KEY) ?? 0) + 1;
            return { result: true, reconcile: async () => !await redis.get(recordKey(id))
                && !await redis.hGet(INDEX_KEY, id) && Number(await redis.get(REVISION_KEY) ?? 0) === cacheRevision,
                mutate: async (transaction) => {
                await transaction.del(recordKey(id));
                await transaction.hDel(INDEX_KEY, [id]);
                await transaction.incrBy(REVISION_KEY, 1);
            } };
        })));
}

// Writes a copy of a live app series and the stage tracks that Redis does
// not hold yet, in one transaction, so a copy is never half done.
async function commitLiveSeriesCopy(
    record: StoredSeriesRecord,
    trackRecords: StoredTrackRecord[],
): Promise<{ written: boolean; tracks: string[] }> {
    return withTrackPlacementLock((placementLock) => withSeriesWriteLock(record.id, (seriesLock) =>
        commitTrackPlacement<{ written: boolean; tracks: string[] }>([placementLock, seriesLock], [], async () => {
            if (await readStoredSeries(record.id)) return { result: { written: false, tracks: [] } };
            const missing: StoredTrackRecord[] = [];
            for (const track of trackRecords) {
                if (!await readStoredTrack(track.key)) missing.push(track);
            }
            const trackCacheRevision = await readStoredTracksRevision() + missing.length;
            const seriesCacheRevision = Number(await redis.get(REVISION_KEY) ?? 0) + 1;
            return {
                result: { written: true, tracks: missing.map((track) => track.key) },
                reconcile: async () => await matchesRecord(record, seriesCacheRevision)
                    && (await Promise.all(missing.map((track) => matchesStoredTrack(track, trackCacheRevision))))
                        .every(Boolean),
                mutate: async (transaction) => {
                    for (const track of missing) await queueStoredTrackRecord(transaction, track);
                    await queueRecord(transaction, record);
                },
            };
        })));
}

function isLiveAppSeries(definition: AppSeriesDefinition): boolean {
    return definition.id === CAMPAIGN_NUMBERS_SERIES_ID || Boolean(getCampaignSeries(definition.id));
}

// Copies each live app series as players race it now: published with all
// its stages, and each stage track locked, as an exact copy of the app
// track. The game still reads Numbers from the app; the copy is ready for
// the release that removes the app tracks.
export async function copyLiveAppSeries({
    dryRun,
    username,
    now = new Date(),
}: {
    dryRun: boolean;
    username: string;
    now?: Date;
}): Promise<{ copied: string[]; alreadyStored: string[]; tracks: string[]; failed: { key: string; error: string }[] }> {
    const report = { copied: [] as string[], alreadyStored: [] as string[], tracks: [] as string[], failed: [] as { key: string; error: string }[] };
    const storedKeys = await readStoredTrackKeys();
    for (const definition of APP_SERIES_DEFINITIONS) {
        if (!isLiveAppSeries(definition)) continue;
        if (await readStoredSeries(definition.id)) {
            report.alreadyStored.push(definition.id);
            continue;
        }
        const stages: StoredSeriesStage[] = (definition.stages ?? [])
            .map(({ trackKey, laps, requiredMedals }) => ({ trackKey, laps, requiredMedals }));
        const missing = stages.map((stage) => stage.trackKey).filter((trackKey) => !storedKeys.has(trackKey));
        if (dryRun) {
            report.copied.push(definition.id);
            report.tracks.push(...missing);
            continue;
        }
        try {
            const trackRecords = missing.map((trackKey) => buildLockedTrackCopy(trackKey, { username, reason: 'series', now }));
            const stamp = now.toISOString();
            const result = await commitLiveSeriesCopy({
                version: 1,
                id: definition.id,
                name: definition.name ?? definition.id,
                ground: definition.ground ?? 'tarmac',
                stages,
                status: 'published',
                publishedStageCount: stages.length,
                publishedAt: stamp,
                origin: 'migrated',
                revision: 1,
                createdAt: stamp,
                createdBy: username,
                updatedAt: stamp,
                updatedBy: username,
            }, trackRecords);
            if (result.written) {
                report.copied.push(definition.id);
                report.tracks.push(...result.tracks);
            } else {
                report.alreadyStored.push(definition.id);
            }
        } catch (error) {
            report.failed.push({ key: definition.id, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return report;
}

// Copies each app series that is not live into Redis as a draft, so the
// Creator can change it. A live app series goes with the live Campaign copy.
export async function copyAppSeriesDrafts({
    dryRun,
    username,
    now = new Date(),
}: {
    dryRun: boolean;
    username: string;
    now?: Date;
}): Promise<{ copied: string[]; alreadyStored: string[]; live: string[]; failed: { id: string; error: string }[] }> {
    const report = { copied: [] as string[], alreadyStored: [] as string[], live: [] as string[], failed: [] as { id: string; error: string }[] };
    for (const definition of APP_SERIES_DEFINITIONS) {
        if (definition.id === CAMPAIGN_NUMBERS_SERIES_ID || getCampaignSeries(definition.id)) {
            report.live.push(definition.id);
            continue;
        }
        if (await readStoredSeries(definition.id)) {
            report.alreadyStored.push(definition.id);
            continue;
        }
        if (dryRun) {
            report.copied.push(definition.id);
            continue;
        }
        try {
            await saveStoredSeries(definition.id, {
                name: definition.name ?? definition.id,
                ground: definition.ground ?? 'tarmac',
                stages: definition.stages ?? [],
            }, { username, origin: 'migrated', now });
            report.copied.push(definition.id);
        } catch (error) {
            report.failed.push({ id: definition.id, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return report;
}
