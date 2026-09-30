import { getCampaignSeries } from '../../../game/campaign/manifest.js';
import { TRACK_CATALOG, getTrackName } from '../../../game/track/catalog.js';
import { TRACKS } from '../../../game/track/tracks.js';
import { getTrackGround } from '../../../game/track/grounds.js';
import { isBuiltInTrackComplete } from '../tracks/track-readiness.js';
import { readDailySchedule } from '../daily/daily-schedule-store.js';
import { listStoredTracks } from '../tracks/track-store.js';
import { readTrackUsage } from '../tracks/track-usage.js';
import { listAppSeriesDefinitions, listStoredSeries } from './series-store.js';
import { readSeriesTrackUse } from './series-usage.js';

// What the Creator's Campaign Planner shows: the stored series, the app series
// that no stored copy replaces, and every track with the place that uses it.
export async function readCreatorSeriesView() {
    const [stored, schedule, usage, storedTracks, seriesUse] = await Promise.all([
        listStoredSeries(),
        readDailySchedule(),
        readTrackUsage(),
        listStoredTracks(),
        readSeriesTrackUse(),
    ]);
    const storedIds = new Set(stored.map((series) => series.id));
    const dailyKeys = new Set(schedule.keys);
    const storedByKey = new Map(storedTracks.map((track) => [track.key, track]));
    const keys = [...new Set([...Object.keys(TRACK_CATALOG), ...storedByKey.keys()])];
    return {
        series: stored,
        appSeries: listAppSeriesDefinitions()
            .filter((series) => !storedIds.has(series.id))
            .map((series) => ({
                id: series.id,
                name: series.name ?? series.id,
                ground: series.ground ?? 'tarmac',
                stages: series.stages ?? [],
                live: getCampaignSeries(series.id) !== null,
            })),
        tracks: keys.map((key) => {
            const storedTrack = storedByKey.get(key);
            return {
                key,
                name: storedTrack?.name ?? getTrackName(key, key),
                ground: storedTrack?.ground ?? getTrackGround(TRACKS[key]).key,
                source: storedTrack?.origin ?? 'app',
                played: usage.playedTrackKeys.has(key),
                ready: storedTrack
                    ? storedTrack.ready
                    : isBuiltInTrackComplete(key),
                usedBy: dailyKeys.has(key) ? 'daily' : seriesUse.get(key) ?? null,
            };
        }),
    };
}
