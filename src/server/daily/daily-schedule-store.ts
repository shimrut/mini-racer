import { redis } from '@devvit/redis';
import { TRACK_SCHEDULE_KEYS, hasTrack } from '../../../game/track/catalog.js';
import { getTrackGround } from '../../../game/track/grounds.js';
import { isLiveGround } from '../../../game/track/live-grounds.js';
import { TrackInputError } from '../tracks/track-shape.js';
import { TrackConflictError, queueStoredTrackRecord, matchesStoredTrack, readStoredTracksRevision } from '../tracks/track-store.js';
import { readTracksToShare } from '../tracks/creator-track-access.js';
import { readCompleteTrack } from '../tracks/track-readiness.js';
import { withTrackPlacementLock, commitTrackPlacement } from '../tracks/track-placement-lock.js';
import { findSeriesUsingTrack as readSeriesUsingTrack } from '../campaign/series-usage.js';
import { readTrackUsage } from '../tracks/track-usage.js';

// The Daily track order: the app list until a moderator saves one in the Creator, so new tracks need no release.

export type DailySchedule = {
    keys: string[];
    revision: number;
    source: 'app' | 'stored';
    updatedAt: string | null;
    updatedBy: string | null;
};

type StoredDailySchedule = {
    version: 1;
    keys: string[];
    revision: number;
    updatedAt: string;
    updatedBy: string;
};

const SCHEDULE_KEY = 'dailygp:daily:schedule:v1';
export const MAX_DAILY_SCHEDULE_LENGTH = 1_000;

function parseSchedule(raw: string | null | undefined): StoredDailySchedule | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw);
        return value?.version === 1 && Array.isArray(value.keys)
            && value.keys.every((key: unknown) => typeof key === 'string')
            && Number.isInteger(value.revision)
            ? value as StoredDailySchedule
            : null;
    } catch {
        return null;
    }
}

function appSchedule(): DailySchedule {
    return {
        keys: [...TRACK_SCHEDULE_KEYS],
        revision: 0,
        source: 'app',
        updatedAt: null,
        updatedBy: null,
    };
}

export async function readDailySchedule(): Promise<DailySchedule> {
    const stored = parseSchedule(await redis.get(SCHEDULE_KEY));
    if (!stored) return appSchedule();
    return {
        keys: stored.keys,
        revision: stored.revision,
        source: 'stored',
        updatedAt: stored.updatedAt,
        updatedBy: stored.updatedBy,
    };
}

// The Daily track keys in order; unknown keys are dropped so a bad list cannot stop the Daily.
export async function readDailySchedulePool(): Promise<string[]> {
    const { keys } = await readDailySchedule();
    const known = keys.filter((trackKey) => hasTrack(trackKey));
    return known.length ? known : [...TRACK_SCHEDULE_KEYS];
}

export async function isTrackInDailySchedule(trackKey: string): Promise<boolean> {
    return (await readDailySchedule()).keys.includes(trackKey);
}

// Restores the app list; only the first copy's undo uses it, while `canRestore` accepts the stored list.
export async function restoreAppDailySchedule(
    canRestore: (schedule: DailySchedule) => boolean,
): Promise<'restored' | 'app' | 'kept'> {
    return withTrackPlacementLock((lock) => commitTrackPlacement<'restored' | 'app' | 'kept'>(
        [lock], [SCHEDULE_KEY], async () => {
            const current = await readDailySchedule();
            if (current.source === 'app') return { result: 'app' };
            if (!canRestore(current)) return { result: 'kept' };
            return { result: 'restored', reconcile: async () => !await redis.get(SCHEDULE_KEY),
                mutate: async (transaction) => { await transaction.del(SCHEDULE_KEY); } };
        },
    ));
}

export type SaveDailyScheduleOptions = {
    username: string;
    baseRevision?: unknown;
    // The Campaign series that uses a track, if any. Such a track cannot be a Daily.
    findSeriesUsingTrack?: (trackKey: string) => Promise<string | null>;
    // The latest Daily's track; the next Daily follows it, so the list must keep it.
    currentTrackKey?: string | null;
    now?: Date;
};

export async function saveDailySchedule(
    keysInput: unknown,
    { username, baseRevision = 0, currentTrackKey = null, findSeriesUsingTrack, now = new Date() }: SaveDailyScheduleOptions,
): Promise<DailySchedule> {
    if (!Array.isArray(keysInput) || keysInput.length === 0) {
        throw new TrackInputError('The Daily list needs at least one track.');
    }
    if (keysInput.length > MAX_DAILY_SCHEDULE_LENGTH) {
        throw new TrackInputError(`The Daily list can have at most ${MAX_DAILY_SCHEDULE_LENGTH} tracks.`);
    }
    const keys = keysInput.map((key) => (typeof key === 'string' ? key : ''));
    if (new Set(keys).size !== keys.length) {
        throw new TrackInputError('A track can be in the Daily list only once.');
    }
    return withTrackPlacementLock((lock) => commitTrackPlacement([lock], [SCHEDULE_KEY], async () => {
        const current = await readDailySchedule();
        if (current.revision !== Number(baseRevision ?? 0)) {
            throw new TrackConflictError('The Daily list changed on another device.');
        }
        const previous = new Set(current.keys);
        for (const trackKey of keys) {
            const complete = await readCompleteTrack(trackKey, username);
            if (previous.has(trackKey)) continue;
            if (!isLiveGround(getTrackGround(complete.track).key)) {
                throw new TrackInputError(`${complete.track.name} is on a ground that is not live.`);
            }
            const seriesId = await (findSeriesUsingTrack ?? readSeriesUsingTrack)(trackKey);
            if (seriesId) throw new TrackInputError(`${trackKey} is a stage of the Campaign series ${seriesId}.`);
        }
        const latest = (await readTrackUsage()).latestDaily?.trackKey ?? currentTrackKey;
        if (latest && !keys.includes(latest)) {
            throw new TrackInputError('Keep the track of the latest Daily in the list. The next Daily comes after it.');
        }
        const next: StoredDailySchedule = {
            version: 1,
            keys,
            revision: current.revision + 1,
            updatedAt: now.toISOString(),
            updatedBy: username,
        };
        // Include outgoing placements so older shared tracks stay shared after removal.
        const sharedTracks = await readTracksToShare([...current.keys, ...keys], now);
        const trackCacheRevision = await readStoredTracksRevision() + sharedTracks.length;
        return { result: { ...next, source: 'stored' as const },
            reconcile: async () => await redis.get(SCHEDULE_KEY) === JSON.stringify(next)
                && (await Promise.all(sharedTracks.map((track) => matchesStoredTrack(track, trackCacheRevision)))).every(Boolean),
            mutate: async (transaction) => {
            for (const track of sharedTracks) await queueStoredTrackRecord(transaction, track);
            await transaction.set(SCHEDULE_KEY, JSON.stringify(next));
        } };
    }));
}
