import {
    normalizeRaceSpec,
    RACE_MEDAL_SCALE_LINEAR_V1,
    RACE_SCORING_TOTAL_TIME,
} from '../race/race-spec.js';

export const CAMPAIGN_ID = 'numbered-v1';
export const CAMPAIGN_RULES_REVISION = 1;

const STAGE_DEFINITIONS = [
    ['00', 'numberZero', 1, null],
    ['01', 'numberOne', 1, 'numbered-v1-00'],
    ['02', 'numberTwo', 1, 'numbered-v1-01'],
    ['03', 'numberThree', 2, 'numbered-v1-02'],
    ['04', 'numberFour', 2, 'numbered-v1-03'],
    ['05', 'numberFive', 2, 'numbered-v1-04'],
    ['06', 'numberSix', 3, 'numbered-v1-05'],
    ['07', 'numberSeven', 3, 'numbered-v1-06'],
];

export const CAMPAIGN_STAGES = Object.freeze(STAGE_DEFINITIONS.map(
    ([stageNumber, trackKey, lapCount, prerequisiteRaceId], index) => {
        const raceSpec = normalizeRaceSpec({
            raceId: `${CAMPAIGN_ID}-${stageNumber}`,
            mode: 'campaign',
            trackKey,
            lapCount,
            scoring: RACE_SCORING_TOTAL_TIME,
            medalScale: RACE_MEDAL_SCALE_LINEAR_V1,
            rulesRevision: CAMPAIGN_RULES_REVISION,
        });
        if (!raceSpec) throw new Error(`Invalid Campaign race specification at stage ${stageNumber}.`);
        return Object.freeze({
            stageIndex: index,
            stageNumber,
            ...raceSpec,
            unlock: prerequisiteRaceId
                ? Object.freeze({
                    type: 'medal_on_race',
                    raceId: prerequisiteRaceId,
                    minimumMedal: 'gold',
                })
                : Object.freeze({ type: 'start' }),
        });
    },
));

const STAGE_BY_RACE_ID = new Map(CAMPAIGN_STAGES.map((stage) => [stage.raceId, stage]));

export function getCampaignStage(raceId) {
    return typeof raceId === 'string' ? STAGE_BY_RACE_ID.get(raceId) ?? null : null;
}

export function getCampaignUnlockedRaceIds(resultsByRaceId = {}) {
    const unlocked = [];
    for (const stage of CAMPAIGN_STAGES) {
        if (stage.unlock.type === 'start') {
            unlocked.push(stage.raceId);
            continue;
        }
        const medal = resultsByRaceId?.[stage.unlock.raceId]?.medal;
        if (medal === 'gold' || medal === 'author') unlocked.push(stage.raceId);
    }
    return unlocked;
}

export function isCampaignStageUnlocked(raceId, resultsByRaceId = {}) {
    return getCampaignUnlockedRaceIds(resultsByRaceId).includes(raceId);
}
