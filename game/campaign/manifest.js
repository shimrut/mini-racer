import { STANDARD_MEDAL_TIER_RANK } from '../medals/medal-timing.js';
import {
    normalizeRaceSpec,
    RACE_MEDAL_SCALE_LINEAR_V1,
    RACE_SCORING_TOTAL_TIME,
} from '../race/race-spec.js';
import seriesData from './series.json' with { type: 'json' };
import { CAMPAIGN_SERIES_MIN_STAGES, isCampaignSeriesLive } from './series-rules.js';

export { CAMPAIGN_SERIES_MIN_STAGES };

// Numbers keeps this name for ever: every saved Numbers record and key uses it.
export const CAMPAIGN_NUMBERS_SERIES_ID = 'numbered-v1';
export const CAMPAIGN_RULES_REVISION = 1;

const SERIES_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function stageNumberFor(index) {
    return String(index).padStart(2, '0');
}

function buildSeries(definition) {
    const id = definition?.id;
    if (typeof id !== 'string' || !SERIES_ID_RE.test(id)) {
        throw new Error(`Invalid Campaign series name: ${id}`);
    }
    const definitions = Array.isArray(definition.stages) ? definition.stages : [];
    const stages = Object.freeze(definitions.map((stageDefinition, index) => {
        const stageNumber = stageNumberFor(index);
        const raceSpec = normalizeRaceSpec({
            raceId: `${id}-${stageNumber}`,
            mode: 'campaign',
            trackKey: stageDefinition?.trackKey,
            lapCount: stageDefinition?.laps,
            scoring: RACE_SCORING_TOTAL_TIME,
            medalScale: RACE_MEDAL_SCALE_LINEAR_V1,
            rulesRevision: CAMPAIGN_RULES_REVISION,
        });
        if (!raceSpec) throw new Error(`Invalid Campaign race specification at ${id} stage ${stageNumber}.`);
        return Object.freeze({
            stageIndex: index,
            stageNumber,
            seriesId: id,
            ...raceSpec,
            unlock: index > 0
                ? Object.freeze({
                    type: 'medal_total',
                    requiredMedals: Number(stageDefinition.requiredMedals) || 0,
                    previousRaceId: `${id}-${stageNumberFor(index - 1)}`,
                })
                : Object.freeze({ type: 'start' }),
        });
    }));
    return Object.freeze({
        id,
        name: typeof definition.name === 'string' && definition.name.trim()
            ? definition.name.trim()
            : id,
        ground: typeof definition.ground === 'string' ? definition.ground : 'tarmac',
        live: isCampaignSeriesLive({ stages }),
        stages,
    });
}

// Every series in the data file, also the hidden ones. Only the Mapmaker and tests use this.
export const CAMPAIGN_ALL_SERIES = Object.freeze(
    (Array.isArray(seriesData?.series) ? seriesData.series : []).map(buildSeries),
);

if (new Set(CAMPAIGN_ALL_SERIES.map((series) => series.id)).size !== CAMPAIGN_ALL_SERIES.length) {
    throw new Error('Campaign series names must be unique.');
}

// The series that players can see.
export const CAMPAIGN_SERIES = Object.freeze(CAMPAIGN_ALL_SERIES.filter((series) => series.live));

const SERIES_BY_ID = new Map(CAMPAIGN_SERIES.map((series) => [series.id, series]));

export const CAMPAIGN_LIVE_STAGES = Object.freeze(CAMPAIGN_SERIES.flatMap((series) => series.stages));

const STAGE_BY_RACE_ID = new Map(CAMPAIGN_LIVE_STAGES.map((stage) => [stage.raceId, stage]));

if (!SERIES_BY_ID.has(CAMPAIGN_NUMBERS_SERIES_ID)) {
    throw new Error('The Numbers Campaign series must stay live.');
}

// The Numbers series, under the names that the code used before there were series.
export const CAMPAIGN_ID = CAMPAIGN_NUMBERS_SERIES_ID;
export const CAMPAIGN_STAGES = SERIES_BY_ID.get(CAMPAIGN_NUMBERS_SERIES_ID).stages;

export function getCampaignSeries(seriesId) {
    return typeof seriesId === 'string' ? SERIES_BY_ID.get(seriesId) ?? null : null;
}

export function isCampaignSeriesId(value) {
    return getCampaignSeries(value) !== null;
}

export function getCampaignSeriesStages(seriesId) {
    return getCampaignSeries(seriesId)?.stages ?? Object.freeze([]);
}

export function getCampaignStage(raceId) {
    return typeof raceId === 'string' ? STAGE_BY_RACE_ID.get(raceId) ?? null : null;
}

export function getCampaignStageMedalCount(medal) {
    const rank = typeof medal === 'string' ? STANDARD_MEDAL_TIER_RANK[medal] : undefined;
    return rank === undefined ? 0 : rank + 1;
}

// Counts the medals of one series. Medals in other series do not count.
export function countCampaignMedals(resultsByRaceId = {}, seriesId = CAMPAIGN_NUMBERS_SERIES_ID) {
    let total = 0;
    for (const stage of getCampaignSeriesStages(seriesId)) {
        total += getCampaignStageMedalCount(resultsByRaceId?.[stage.raceId]?.medal);
    }
    return total;
}

// The open stages of every live series. Each series counts its own medals.
export function getCampaignUnlockedRaceIds(resultsByRaceId = {}) {
    const unlocked = [];
    for (const series of CAMPAIGN_SERIES) {
        const medalTotal = countCampaignMedals(resultsByRaceId, series.id);
        for (const stage of series.stages) {
            if (stage.unlock.type === 'start' || (
                medalTotal >= stage.unlock.requiredMedals
                && getCampaignStageMedalCount(
                    resultsByRaceId?.[stage.unlock.previousRaceId]?.medal,
                ) > 0
            )) {
                unlocked.push(stage.raceId);
            }
        }
    }
    return unlocked;
}

export function isCampaignStageUnlocked(raceId, resultsByRaceId = {}) {
    return getCampaignUnlockedRaceIds(resultsByRaceId).includes(raceId);
}

// A series is finished when its last stage has a medal.
export function isCampaignSeriesFinished(seriesId, resultsByRaceId = {}) {
    const lastStage = getCampaignSeriesStages(seriesId).at(-1);
    return Boolean(lastStage)
        && getCampaignStageMedalCount(resultsByRaceId?.[lastStage.raceId]?.medal) > 0;
}
