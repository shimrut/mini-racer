import { getCampaignFinalStage, getCampaignSeriesStages, isCampaignSeriesFinished } from './manifest.js';

// Saved stage PBs already include every required lap. A partial or unconfirmed
// series has no aggregate: missing stages must never count as zero.
export function getCampaignAggregateTotalTimeMs(seriesId, resultsByRaceId = {}) {
    const finalStage = getCampaignFinalStage(seriesId);
    const stages = getCampaignSeriesStages(seriesId);
    if (!finalStage || stages.at(-1)?.raceId !== finalStage.raceId
        || !isCampaignSeriesFinished(seriesId, resultsByRaceId)) return null;

    let totalTimeMs = 0;
    for (const stage of stages) {
        const timeMs = resultsByRaceId?.[stage.raceId]?.bestTimeMs;
        if (!Number.isSafeInteger(timeMs) || timeMs <= 0) return null;
        totalTimeMs += timeMs;
        if (!Number.isSafeInteger(totalTimeMs)) return null;
    }
    return totalTimeMs;
}

export function readCampaignPlace(value) {
    const rank = value?.rank;
    const total = value?.total;
    if (!Number.isInteger(rank) || rank < 1 || !Number.isInteger(total) || total < rank) return null;
    return { rank, total };
}

export function formatCampaignPlace(place) {
    return place ? `#${place.rank} / ${place.total}` : '';
}
