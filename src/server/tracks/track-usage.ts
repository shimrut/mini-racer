import { CAMPAIGN_LIVE_STAGES } from '../../../game/campaign/manifest.js';
import { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } from '../../../game/shared/daily-gp-history-backfill.js';
import { readDailyChallengeHistory } from '../daily/daily-gp-store.js';
import type { DailyGpChallenge } from '../daily/daily-gp-model.js';
import { isLiveAppSeries, listAppSeriesDefinitions, listStoredSeries } from '../campaign/series-store.js';

// A track is played once it was a Daily or is a live Campaign stage; a played track never changes.

export type TrackUsage = {
    playedTrackKeys: Set<string>;
    latestDaily: DailyGpChallenge | null;
};

export async function readTrackUsage(): Promise<TrackUsage> {
    const history = await readDailyChallengeHistory();
    const playedTrackKeys = new Set<string>(history.map((challenge) => challenge.trackKey));
    // The first Daily days are in a fixed table, not in the stored history.
    for (const trackKey of Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE)) playedTrackKeys.add(String(trackKey));
    for (const stage of CAMPAIGN_LIVE_STAGES) playedTrackKeys.add(stage.trackKey);
    return {
        playedTrackKeys,
        latestDaily: history.at(-1) ?? null,
    };
}

// Whether players can meet a track now, from Redis records; used under the placement lock, so it is current.
export async function isTrackPlayedNow(trackKey: string): Promise<boolean> {
    if (Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE).some((key) => String(key) === trackKey)) return true;
    const inLiveAppSeries = listAppSeriesDefinitions().some((series) => (
        isLiveAppSeries(series) && (series.stages ?? []).some((stage) => stage.trackKey === trackKey)
    ));
    if (inLiveAppSeries) return true;
    const stored = await listStoredSeries();
    const inPublishedStage = stored.some((series) => series.status === 'published'
        && series.stages.slice(0, series.publishedStageCount).some((stage) => stage.trackKey === trackKey));
    if (inPublishedStage) return true;
    return (await readDailyChallengeHistory()).some((challenge) => challenge.trackKey === trackKey);
}
