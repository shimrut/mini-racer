// Campaign series rules, with no imports so the Mapmaker server can use them.

// Stages a series needs to go live (Formula Mini: 2); then stages are fixed and new ones go last.
export const CAMPAIGN_SERIES_MIN_STAGES = 1;
const FORMULA_MINI_SERIES_ID = 'grip-v1';
const FORMULA_MINI_MIN_STAGES = 2;

export function getCampaignSeriesMinStages(series) {
    return series?.id === FORMULA_MINI_SERIES_ID ? FORMULA_MINI_MIN_STAGES : CAMPAIGN_SERIES_MIN_STAGES;
}

export const CAMPAIGN_STAGE_MAX_LAPS = 3;

// Max medals a stage can need: 3 per earlier stage, so all Gold always opens the next.
export function getMaxRequiredMedals(stageIndex) {
    return Math.max(0, stageIndex) * 3;
}

// Numbers keeps this name for ever: every saved Numbers record and key uses it.
export const CAMPAIGN_NUMBERS_SERIES_ID = 'numbered-v1';

// A series is live only when the Creator makes it live; in app data only Numbers is.
export function isAppCampaignSeriesLive(series) {
    return series?.id === CAMPAIGN_NUMBERS_SERIES_ID;
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
