export const RACE_SCORING_TOTAL_TIME = 'total_time';
export const RACE_MEDAL_SCALE_LINEAR_V1 = 'linear_v1';

const SUPPORTED_MODES = new Set(['daily', 'campaign', 'challenge']);

export function normalizeRaceSpec(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raceId = typeof value.raceId === 'string' ? value.raceId.trim() : '';
    const mode = typeof value.mode === 'string' ? value.mode : '';
    const trackKey = typeof value.trackKey === 'string' ? value.trackKey.trim() : '';
    const lapCount = Number(value.lapCount);
    const rulesRevision = Number(value.rulesRevision);
    if (
        !raceId
        || !SUPPORTED_MODES.has(mode)
        || !trackKey
        || !Number.isInteger(lapCount)
        || lapCount < 1
        || lapCount > 3
        || value.scoring !== RACE_SCORING_TOTAL_TIME
        || value.medalScale !== RACE_MEDAL_SCALE_LINEAR_V1
        || !Number.isInteger(rulesRevision)
        || rulesRevision < 1
    ) {
        return null;
    }
    return Object.freeze({
        raceId,
        mode,
        trackKey,
        lapCount,
        scoring: RACE_SCORING_TOTAL_TIME,
        medalScale: RACE_MEDAL_SCALE_LINEAR_V1,
        rulesRevision,
    });
}
