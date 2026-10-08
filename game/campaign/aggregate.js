import { getCampaignFinalStage, getCampaignSeriesStages, isCampaignSeriesFinished } from './manifest.js';

// Stage PBs include all laps; a partial or unconfirmed series has no aggregate, never zeros.
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

export function formatCampaignTotalTime(timeMs) {
    if (!Number.isSafeInteger(timeMs) || timeMs <= 0) return '';
    const milliseconds = String(timeMs % 1000).padStart(3, '0');
    const seconds = String(Math.floor(timeMs / 1000) % 60).padStart(2, '0');
    const minutes = Math.floor(timeMs / 60_000);
    const hours = Math.floor(minutes / 60);
    return hours > 0
        ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${seconds}.${milliseconds}`
        : `${minutes}:${seconds}.${milliseconds}`;
}
