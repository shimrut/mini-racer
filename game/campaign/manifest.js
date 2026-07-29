import { STANDARD_MEDAL_TIER_RANK } from '../medals/medal-timing.js';
import {
    normalizeRaceSpec,
    RACE_MEDAL_SCALE_LINEAR_V1,
    RACE_SCORING_TOTAL_TIME,
} from '../race/race-spec.js';

export const CAMPAIGN_ID = 'numbered-v1';
export const CAMPAIGN_RULES_REVISION = 1;

/**
 * A stage opens on the player's medal total across the whole campaign rather
 * than on one medal on the stage before it. A chain makes a single track the
 * player cannot Gold a full stop; a total lets strength on one track pay for
 * weakness on another, and gives Author a reason to exist beyond pride.
 *
 * From stage 03 the requirement is Silver on every previous track plus Gold on
 * half of them — 2n + floor(n / 2). Stages 01 and 02 are set below that curve so
 * the opening is not a wall. Every gate stays reachable without a single Author
 * (each is under 3n, the Gold-on-everything total).
 *
 * A total on its own cannot keep the ladder sequential: medals earned on early
 * stages spend against every gate at once, so six Authors would open four stages
 * the player had never driven. Pricing that out would mean asking 33 of the 36
 * medals available by stage 09 — Author on nearly everything — so the ladder
 * keeps a second, cheap condition instead: a medal on the stage immediately
 * before. That caps progress at one new stage at a time, because the stage after
 * next cannot have been medalled while it was locked.
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

/**
 * What one stage contributes to the total: the number of medals showing in its
 * stack, which is what the lobby card already draws. Bronze is worth 1 and
 * Author 4, so an Author is two Silvers ahead where a Gold is one.
 */
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

/**
 * Progress only ever keeps a better medal per stage, so the total climbs and an
 * unlock earned here cannot lapse. The one path back is the explicit revoke of a
 * finish the server refused, which drops the result and re-derives from scratch.
 */
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
