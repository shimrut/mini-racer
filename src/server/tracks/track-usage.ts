import { CAMPAIGN_LIVE_STAGES } from '../../../game/campaign/manifest.js';
import { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } from '../../../game/shared/daily-gp-history-backfill.js';
import { readDailyChallengeHistory } from '../daily/daily-gp-store.js';
import type { DailyGpChallenge } from '../daily/daily-gp-model.js';

// Where players have met a track. A track is played when it was a Daily or
// when it is a stage of a live Campaign series. Head to Head comes only from
// those two modes. A played track never changes.

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
