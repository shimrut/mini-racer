export const RACE_SCORING_TOTAL_TIME = 'total_time';
export const RACE_MEDAL_SCALE_LINEAR_V1 = 'linear_v1';

export const RACE_OBJECTIVE_SINGLE_LAP = 'single_lap_fastest';
export const RACE_OBJECTIVE_MULTI_LAP = 'multi_lap_total';

const SUPPORTED_MODES = new Set(['daily', 'campaign', 'challenge']);

export function objectiveTypeForLapCount(lapCount) {
    return Number(lapCount) === 1
        ? RACE_OBJECTIVE_SINGLE_LAP
        : RACE_OBJECTIVE_MULTI_LAP;
}

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
        objectiveType: objectiveTypeForLapCount(lapCount),
    });
}

// A Campaign stage or a Head to Head race, as a challenge that never ends.
export function permanentRaceChallenge(stage, { mode, fallbackDate }) {
    return {
        id: stage.raceId,
        challengeDate: stage.challengeDate || fallbackDate,
        trackKey: stage.trackKey,
        startsAt: '1970-01-01T00:00:00.000Z',
        endsAt: '9999-12-31T23:59:59.999Z',
        availableUntil: '9999-12-31T23:59:59.999Z',
        status: 'active',
        rulesRevision: stage.rulesRevision,
        objectiveType: objectiveTypeForLapCount(stage.lapCount),
        objectiveParams: { lapCount: stage.lapCount },
        skin: 'default',
        mode,
    };
}
