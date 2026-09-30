import { redis } from '@devvit/redis';
import { TRACK_SCHEDULE_KEYS, getTrackName, hasTrack, isBuiltInTrack } from '../../../game/track/catalog.js';
import { getTrackMedalThresholds } from '../../../game/medals/medal-timing.js';
import { TrackInputError } from '../tracks/track-shape.js';
import { TrackConflictError, readStoredTrack } from '../tracks/track-store.js';

// The Daily list: the order in which tracks become the Daily. The app has a
// built-in list. After a moderator saves a list in the Creator, the Daily
// reads the stored list, so a new track needs no release.

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
const SCHEDULE_WRITE_LOCK_KEY = 'dailygp:daily:schedule-write-lock:v1';
const WRITE_LOCK_TTL_MS = 10_000;
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

// The track keys that the Daily picks from, in order. A key that the game
// does not know is left out, so a bad list cannot stop the Daily.
export async function readDailySchedulePool(): Promise<string[]> {
    const { keys } = await readDailySchedule();
    const known = keys.filter((trackKey) => hasTrack(trackKey));
    return known.length ? known : [...TRACK_SCHEDULE_KEYS];
}

export async function isTrackInDailySchedule(trackKey: string): Promise<boolean> {
    return (await readDailySchedule()).keys.includes(trackKey);
}

async function assertSchedulableTrack(trackKey: string): Promise<void> {
    const record = await readStoredTrack(trackKey);
    if (!record && isBuiltInTrack(trackKey)) {
        if (!getTrackMedalThresholds(trackKey)) {
            throw new TrackInputError(`${getTrackName(trackKey)} has no medal times.`);
        }
        return;
    }
    if (!record) throw new TrackInputError(`The game has no track called ${trackKey}.`);
    if (!record.checksPassed) {
        throw new TrackInputError(`${record.track.name} does not pass the checks yet.`);
    }
    if (!record.medalRow) {
        throw new TrackInputError(`Set the medal times of ${record.track.name} first.`);
    }
}

export type SaveDailyScheduleOptions = {
    username: string;
    baseRevision?: unknown;
    // The Campaign series that uses a track, if any. Such a track cannot be a Daily.
    findSeriesUsingTrack?: (trackKey: string) => Promise<string | null>;
    // The track of the latest Daily. The next Daily comes after it, so the
    // list must keep it.
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
    for (const trackKey of keys) await assertSchedulableTrack(trackKey);
    if (findSeriesUsingTrack) {
        const previous = new Set((await readDailySchedule()).keys);
        for (const trackKey of keys) {
            if (previous.has(trackKey)) continue;
            const seriesId = await findSeriesUsingTrack(trackKey);
            if (seriesId) throw new TrackInputError(`${trackKey} is a stage of the Campaign series ${seriesId}.`);
        }
    }
    if (currentTrackKey && !keys.includes(currentTrackKey)) {
        throw new TrackInputError('Keep the track of the latest Daily in the list. The next Daily comes after it.');
    }

    const token = `${now.getTime()}:${Math.random().toString(36).slice(2)}`;
    const acquired = await redis.set(SCHEDULE_WRITE_LOCK_KEY, token, {
        nx: true,
        expiration: new Date(now.getTime() + WRITE_LOCK_TTL_MS),
    });
    if (!acquired) throw new TrackConflictError('Someone else is saving the Daily list. Try again.');
    try {
        const current = await readDailySchedule();
        if (current.revision !== Number(baseRevision ?? 0)) {
            throw new TrackConflictError('The Daily list changed on another device. Open it again to see the new list.');
        }
        const next: StoredDailySchedule = {
            version: 1,
            keys,
            revision: current.revision + 1,
            updatedAt: now.toISOString(),
            updatedBy: username,
        };
        await redis.set(SCHEDULE_KEY, JSON.stringify(next));
        return { ...next, source: 'stored' };
    } finally {
        try {
            if (await redis.get(SCHEDULE_WRITE_LOCK_KEY) === token) await redis.del(SCHEDULE_WRITE_LOCK_KEY);
        } catch (error) {
            console.error('Failed to release the Daily list write lock:', error);
        }
    }
}
