import { TRACK_CATALOG, getTrackName } from '../../../game/track/catalog.js';
import { TRACKS } from '../../../game/track/tracks.js';
import { getTrackGround } from '../../../game/track/grounds.js';
import { isLiveGround } from '../../../game/track/live-grounds.js';
import { readDailySchedule, type DailySchedule } from './daily-schedule-store.js';
import { listStoredTracks } from '../tracks/track-store.js';
import { readTrackUsage } from '../tracks/track-usage.js';

// What the Creator shows for the Daily list: the list, the latest Daily, and
// every track that the list can use.

export type CreatorDailyTrack = {
    key: string;
    name: string;
    ground: string;
    liveGround: boolean;
    source: 'app' | 'creator' | 'migrated';
    played: boolean;
    locked: boolean;
    ready: boolean;
};

export type CreatorDailyView = {
    schedule: DailySchedule;
    latestTrackKey: string | null;
    latestChallengeDate: string | null;
    tracks: CreatorDailyTrack[];
};

export async function readCreatorDailyView(): Promise<CreatorDailyView> {
    const [schedule, usage, stored] = await Promise.all([
        readDailySchedule(),
        readTrackUsage(),
        listStoredTracks(),
    ]);
    const storedByKey = new Map(stored.map((track) => [track.key, track]));
    const keys = [...new Set([...Object.keys(TRACK_CATALOG), ...storedByKey.keys()])];
    const tracks = keys.map((key): CreatorDailyTrack => {
        const storedTrack = storedByKey.get(key);
        const ground = storedTrack?.ground ?? getTrackGround(TRACKS[key]).key;
        return {
            key,
            name: storedTrack?.name ?? getTrackName(key, key),
            ground,
            liveGround: isLiveGround(ground),
            source: storedTrack?.origin ?? 'app',
            played: usage.playedTrackKeys.has(key),
            locked: Boolean(storedTrack?.lockedAt),
            ready: storedTrack ? storedTrack.checksPassed && Boolean(storedTrack.medalRow) : true,
        };
    });
    return {
        schedule,
        latestTrackKey: usage.latestDaily?.trackKey ?? null,
        latestChallengeDate: usage.latestDaily?.challengeDate ?? null,
        tracks,
    };
}
