import { STANDARD_MEDAL_TIER_RANK } from '../medals/medal-timing.js';
import {
    normalizeRaceSpec,
    RACE_MEDAL_SCALE_LINEAR_V1,
    RACE_SCORING_TOTAL_TIME,
} from '../race/race-spec.js';

export const CAMPAIGN_ID = 'numbered-v1';
export const CAMPAIGN_RULES_REVISION = 1;

/**
 * Gates open on the player's total campaign medals rather than one medal on
 * the stage before it, so strength on one track can pay for weakness on
 * another. From stage 03 the requirement is 2n + floor(n / 2) — Silver on
 * every prior track plus Gold on half — always reachable without Author. Each
 * gate also requires a medal on the immediately preceding stage, since the
 * total alone would let early medals fund skipping several stages at once.
 */
const STAGE_DEFINITIONS = [
    ['00', 'numberZero', 1, 0],
    ['01', 'numberOne', 1, 1],
    ['02', 'numberTwo', 1, 3],
    ['03', 'numberThree', 2, 7],
    ['04', 'numberFour', 2, 10],
    ['05', 'numberFive', 2, 12],
    ['06', 'numberSix', 3, 15],
    ['07', 'numberSeven', 3, 17],
    ['08', 'numberEight', 3, 20],
    ['09', 'numberNine', 3, 22],
    ['10', 'imaginaryNumber', 2, 25],
    ['11', 'infinitePie', 1, 27],
    ['12', 'eulersNumber', 1, 30],
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

/** Medal count toward the campaign total: bronze=1 through author=4. */
export function getCampaignStageMedalCount(medal) {
    const rank = typeof medal === 'string' ? STANDARD_MEDAL_TIER_RANK[medal] : undefined;
    return rank === undefined ? 0 : rank + 1;
}

/** Medals banked across every campaign stage. Nothing outside the campaign counts. */
export function countCampaignMedals(resultsByRaceId = {}) {
    let total = 0;
    for (const stage of CAMPAIGN_STAGES) {
        total += getCampaignStageMedalCount(resultsByRaceId?.[stage.raceId]?.medal);
    }
    return total;
}

/** An unlock can't lapse — progress only keeps the better medal per stage — except by an explicit server-side revoke, which re-derives from scratch. */
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
