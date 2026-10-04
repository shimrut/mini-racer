import { STANDARD_MEDAL_TIER_RANK } from '../medals/medal-timing.js';
import {
    normalizeRaceSpec,
    RACE_MEDAL_SCALE_LINEAR_V1,
    RACE_SCORING_TOTAL_TIME,
} from '../race/race-spec.js';
import seriesData from './series.json' with { type: 'json' };
import {
    CAMPAIGN_NUMBERS_SERIES_ID,
    CAMPAIGN_SERIES_MIN_STAGES,
    isAppCampaignSeriesLive,
} from './series-rules.js';
import { getStoredSeriesDefinitions } from './stored-series.js';
import { TRACK_CATALOG } from '../track/catalog.js';
import { getCampaignSeriesGrounds } from './series-surfaces.js';

export { CAMPAIGN_NUMBERS_SERIES_ID, CAMPAIGN_SERIES_MIN_STAGES };
export const CAMPAIGN_RULES_REVISION = 1;

const SERIES_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function stageNumberFor(index) {
    return String(index).padStart(2, '0');
}

function buildSeries(definition, { app = false } = {}) {
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
    const ground = typeof definition.ground === 'string' ? definition.ground : 'tarmac';
    const grounds = Object.freeze(getCampaignSeriesGrounds(definition, app
        ? (trackKey) => Object.hasOwn(TRACK_CATALOG, trackKey)
            ? TRACK_CATALOG[trackKey].ground ?? 'tarmac' : null
        : null));
    return Object.freeze({
        id,
        name: typeof definition.name === 'string' && definition.name.trim()
            ? definition.name.trim()
            : id,
        ground,
        grounds,
        // The game gets only the series published in the Creator, so a stored series is live.
        live: app ? isAppCampaignSeriesLive({ id }) : true,
        stages,
    });
}

// Every series in the data file, also the hidden ones.
const APP_SERIES = Object.freeze(
    (Array.isArray(seriesData?.series) ? seriesData.series : []).map((definition) => buildSeries(definition, { app: true })),
);

if (new Set(APP_SERIES.map((series) => series.id)).size !== APP_SERIES.length) {
    throw new Error('Campaign series names must be unique.');
}

if (!APP_SERIES.some((series) => series.id === CAMPAIGN_NUMBERS_SERIES_ID && series.live)) {
    throw new Error('The Numbers Campaign series must stay live.');
}

// The app series with the published stored series. A stored series replaces
// the app series with the same name, but never Numbers. New stored series
// come after the app series. Each stored list is built once: on the server,
// requests that run at the same time can read different lists, and each one
// keeps the same stages until it ends.
const viewsByDefinitions = new WeakMap();

function buildStoredSeries(definitions) {
    return definitions.flatMap((definition) => {
        if (definition?.id === CAMPAIGN_NUMBERS_SERIES_ID) return [];
        try {
            return [buildSeries(definition)];
        } catch (error) {
            console.error(`Stored Campaign series ${definition?.id} is not valid:`, error);
            return [];
        }
    });
}

function currentViews() {
    const definitions = getStoredSeriesDefinitions();
    const built = viewsByDefinitions.get(definitions);
    if (built) return built;
    const stored = buildStoredSeries(definitions);
    const storedById = new Map(stored.map((series) => [series.id, series]));
    const appIds = new Set(APP_SERIES.map((series) => series.id));
    const all = Object.freeze([
        ...APP_SERIES.map((series) => storedById.get(series.id) ?? series),
        ...stored.filter((series) => !appIds.has(series.id)),
    ]);
    const live = Object.freeze(all.filter((series) => series.live));
    const liveStages = Object.freeze(live.flatMap((series) => series.stages));
    const views = {
        all,
        live,
        liveStages,
        seriesById: new Map(live.map((series) => [series.id, series])),
        stageByRaceId: new Map(liveStages.map((stage) => [stage.raceId, stage])),
    };
    viewsByDefinitions.set(definitions, views);
    return views;
}

// An array that always shows the current list, so the code that reads the
// Campaign lists sees the published stored series too.
function liveList(read) {
    return new Proxy([], {
        get(_target, property) {
            const list = read();
            const value = Reflect.get(list, property, list);
            return typeof value === 'function' && property !== 'constructor' ? value.bind(list) : value;
        },
        has(_target, property) {
            return Reflect.has(read(), property);
        },
        ownKeys() {
            return Reflect.ownKeys(read());
        },
        getOwnPropertyDescriptor(_target, property) {
            const list = read();
            if (property === 'length') {
                return { value: list.length, writable: true, enumerable: false, configurable: false };
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(list, property);
            return descriptor ? { ...descriptor, configurable: true } : undefined;
        },
    });
}

// Every series, also the hidden ones.
export const CAMPAIGN_ALL_SERIES = liveList(() => currentViews().all);

// The series that players can see.
export const CAMPAIGN_SERIES = liveList(() => currentViews().live);

export const CAMPAIGN_LIVE_STAGES = liveList(() => currentViews().liveStages);

// Players choose a series only when more than one is live. With one, the
// Campaign opens its stages, with no series screen and no series choice.
// The count includes the published series from the Creator.
export function campaignHasSeriesChoice() {
    return currentViews().live.length > 1;
}

// The Numbers series, under the name that the code used before there were series.
export const CAMPAIGN_ID = CAMPAIGN_NUMBERS_SERIES_ID;

export function getCampaignSeries(seriesId) {
    return typeof seriesId === 'string' ? currentViews().seriesById.get(seriesId) ?? null : null;
}

export function isCampaignSeriesId(value) {
    return getCampaignSeries(value) !== null;
}

export function getCampaignSeriesStages(seriesId) {
    return getCampaignSeries(seriesId)?.stages ?? Object.freeze([]);
}

export function getCampaignStage(raceId) {
    return typeof raceId === 'string' ? currentViews().stageByRaceId.get(raceId) ?? null : null;
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
