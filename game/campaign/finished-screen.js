import { formatSeriesMedals } from '../lobby/campaign-series-picker.js';
import { getCampaignAggregateTotalTimeMs } from './aggregate.js';
import {
    countCampaignMedals,
    getCampaignSeries,
    isCampaignSeriesFinished,
} from './manifest.js';

const STAGE_MEDAL_TIERS = new Set(['author', 'gold', 'silver', 'bronze']);
const MEDAL_TIER_ORDER = ['author', 'gold', 'silver', 'bronze'];

// One screen for every campaign. The series that was just finished fills the
// title, the medal of each stage and the medal total. A series the game does
// not currently publish, or one that is not finished, has no screen.
export function buildCampaignFinishedScreen(seriesId, resultsByRaceId = {}) {
    const series = getCampaignSeries(seriesId);
    if (!series || !isCampaignSeriesFinished(seriesId, resultsByRaceId)) return null;

    const stageCount = series.stages.length;
    const medalCount = countCampaignMedals(resultsByRaceId, seriesId);
    const medals = series.stages.map((stage) => {
        const medal = resultsByRaceId?.[stage.raceId]?.medal;
        return {
            stageNumber: stage.stageNumber,
            tier: STAGE_MEDAL_TIERS.has(medal) ? medal : null,
        };
    });
    const medalDistribution = Object.fromEntries(MEDAL_TIER_ORDER.map((tier) => [
        tier, medals.filter((medal) => medal.tier === tier).length,
    ]));

    return {
        seriesId: series.id,
        finalStageId: series.finalStageId,
        totalTimeMs: getCampaignAggregateTotalTimeMs(series.id, resultsByRaceId),
        stageCount,
        medalDistribution,
        title: series.name,
        status: 'Complete',
        medals,
        bestTier: MEDAL_TIER_ORDER.find((tier) => medals.some((medal) => medal.tier === tier)) ?? null,
        medalTotal: formatSeriesMedals({ medalCount, stageCount }),
    };
}
