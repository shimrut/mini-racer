// Rules for the Campaign series list. This file has no imports, so the Mapmaker
// server can use it without watching the series data file.

// A series stays hidden from players until it has this many stages. After that,
// its stages are fixed, and new stages go after the last one.
export const CAMPAIGN_SERIES_MIN_STAGES = 2;

export const CAMPAIGN_STAGE_MAX_LAPS = 3;

// The medals that the stage at this position can need at most: 3 for each
// stage before it, so Gold on every stage always opens the next one.
export function getMaxRequiredMedals(stageIndex) {
    return Math.max(0, stageIndex) * 3;
}

export function isCampaignSeriesLive(series) {
    return Array.isArray(series?.stages) && series.stages.length >= CAMPAIGN_SERIES_MIN_STAGES;
}

// Returns an error text, or null when the medal target fits its position.
export function getRequiredMedalsError(requiredMedals, stageIndex, previousRequiredMedals) {
    if (!Number.isInteger(requiredMedals)) return 'The medal target must be a whole number.';
    if (stageIndex === 0) {
        return requiredMedals === 0 ? null : 'The first stage needs no medals.';
    }
    if (requiredMedals <= previousRequiredMedals) {
        return `The medal target must be more than ${previousRequiredMedals}, the target of the stage before it.`;
    }
    const max = getMaxRequiredMedals(stageIndex);
    if (requiredMedals > max) {
        return `The medal target can be ${max} at most, so Gold on every stage opens this stage.`;
    }
    return null;
}
