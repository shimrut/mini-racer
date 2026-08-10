import { STANDARD_MEDAL_TIER_RANK } from '../medals/medal-timing.js';
import {
    normalizeRaceSpec,
    RACE_MEDAL_SCALE_LINEAR_V1,
    RACE_SCORING_TOTAL_TIME,
} from '../race/race-spec.js';

export const CAMPAIGN_ID = 'numbered-v1';
export const CAMPAIGN_RULES_REVISION = 1;

/** Gate: 2n + floor(n / 2) total medals (clearable on Gold alone) plus a medal on the previous stage, so a total cannot fund skipping stages. */
const STAGE_DEFINITIONS = [
    ['00', 'numberZero', 2, 0],
    ['01', 'numberOne', 2, 1],
    ['02', 'numberTwo', 1, 3],
    ['03', 'numberThree', 1, 7],
    ['04', 'numberFour', 2, 10],
    ['05', 'numberFive', 1, 12],
    ['06', 'numberSix', 1, 15],
    ['07', 'numberSeven', 3, 17],
    ['08', 'numberEight', 2, 20],
    ['09', 'numberNine', 1, 22],
    ['10', 'imaginaryNumber', 3, 25],
    ['11', 'infinitePie', 1, 27],
    ['12', 'eulersNumber', 2, 30],
    ['13', 'goldenRatio', 2, 32],
];

export const CAMPAIGN_STAGES = Object.freeze(STAGE_DEFINITIONS.map(
    ([stageNumber, trackKey, lapCount, requiredMedals], index) => {
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
            unlock: index > 0
                ? Object.freeze({
                    type: 'medal_total',
                    requiredMedals,
                    previousRaceId: `${CAMPAIGN_ID}-${STAGE_DEFINITIONS[index - 1][0]}`,
                })
                : Object.freeze({ type: 'start' }),
        });
    },
));

const STAGE_BY_RACE_ID = new Map(CAMPAIGN_STAGES.map((stage) => [stage.raceId, stage]));

export function getCampaignStage(raceId) {
    return typeof raceId === 'string' ? STAGE_BY_RACE_ID.get(raceId) ?? null : null;
}

export function getCampaignStageMedalCount(medal) {
    const rank = typeof medal === 'string' ? STANDARD_MEDAL_TIER_RANK[medal] : undefined;
    return rank === undefined ? 0 : rank + 1;
}

export function countCampaignMedals(resultsByRaceId = {}) {
    let total = 0;
    for (const stage of CAMPAIGN_STAGES) {
        total += getCampaignStageMedalCount(resultsByRaceId?.[stage.raceId]?.medal);
    }
    return total;
}

export function getCampaignUnlockedRaceIds(resultsByRaceId = {}) {
    const medalTotal = countCampaignMedals(resultsByRaceId);
    return CAMPAIGN_STAGES
        .filter((stage) => stage.unlock.type === 'start' || (
            medalTotal >= stage.unlock.requiredMedals
            && getCampaignStageMedalCount(
                resultsByRaceId?.[stage.unlock.previousRaceId]?.medal,
            ) > 0
        ))
        .map((stage) => stage.raceId);
}

export function isCampaignStageUnlocked(raceId, resultsByRaceId = {}) {
    return getCampaignUnlockedRaceIds(resultsByRaceId).includes(raceId);
}
