import { CAMPAIGN_NUMBERS_SERIES_ID, getCampaignSeries } from '../../../game/campaign/manifest.js';
import { TRACK_CATALOG, getTrackName } from '../../../game/track/catalog.js';
import { TRACKS, BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { getTrackGround } from '../../../game/track/grounds.js';
import { getCampaignSeriesGrounds } from '../../../game/campaign/series-surfaces.js';
import { isBuiltInTrackComplete } from '../tracks/track-readiness.js';
import { readDailySchedule } from '../daily/daily-schedule-store.js';
import { listCreatorTracks } from '../tracks/creator-track-access.js';
import { readTrackUsage } from '../tracks/track-usage.js';
import { listAppSeriesDefinitions, listStoredSeries } from './series-store.js';
import { readSeriesTrackUse } from './series-usage.js';

// The Campaign Planner view: stored and unreplaced app series, and each track's place; locked Numbers is left out.
export async function readCreatorSeriesView(username: string) {
    const [allStored, schedule, usage, storedTracks, seriesUse] = await Promise.all([
        listStoredSeries(),
        readDailySchedule(),
        readTrackUsage(),
        listCreatorTracks(username),
        readSeriesTrackUse(),
    ]);
    const stored = allStored.filter((series) => series.id !== CAMPAIGN_NUMBERS_SERIES_ID);
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
                grounds: getCampaignSeriesGrounds(series, (trackKey: string) => {
                    const track = BUILT_IN_TRACKS[trackKey as keyof typeof BUILT_IN_TRACKS];
                    return track ? getTrackGround(track).key : null;
                }),
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
