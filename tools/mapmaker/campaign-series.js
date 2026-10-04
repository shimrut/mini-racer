import {
    CAMPAIGN_STAGE_MAX_LAPS,
    getRequiredMedalsError,
    isAppCampaignSeriesLive,
} from '../../game/campaign/series-rules.js';

export const DAILY_DESTINATION = 'daily';
// Off the Daily schedule and in no series. New tracks start here.
export const UNUSED_DESTINATION = 'none';
const SERIES_DESTINATION_PREFIX = 'series:';
const SERIES_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function seriesDestination(seriesId) {
    return `${SERIES_DESTINATION_PREFIX}${seriesId}`;
}

// Returns { type: 'daily' }, { type: 'none' } or { type: 'series', seriesId },
// or null for an unknown value.
export function parseTrackDestination(value, seriesData = null) {
    if (value === DAILY_DESTINATION) return { type: 'daily' };
    if (value === UNUSED_DESTINATION) return { type: 'none' };
    if (typeof value !== 'string' || !value.startsWith(SERIES_DESTINATION_PREFIX)) return null;
    const seriesId = value.slice(SERIES_DESTINATION_PREFIX.length);
    if (!SERIES_ID_RE.test(seriesId)) return null;
    if (seriesData && !seriesData.series.some((series) => series.id === seriesId)) return null;
    return { type: 'series', seriesId };
}

// Adds the track to the end of the Daily schedule, or takes it off. Changes scheduleKeys.
export function applyScheduleDestination(scheduleKeys, trackKey, destination) {
    const scheduleIndex = scheduleKeys.indexOf(trackKey);
    if (destination.type === 'daily') {
        if (scheduleIndex === -1) {
            scheduleKeys.push(trackKey);
        }
        return;
    }

    if (scheduleIndex !== -1) {
        scheduleKeys.splice(scheduleIndex, 1);
    }
    if (scheduleKeys.length === 0) {
        throw new Error('Track schedule must contain at least one key.');
    }
}

function normalizeStage(stage) {
    return {
        trackKey: String(stage?.trackKey ?? ''),
        laps: Number(stage?.laps),
        requiredMedals: Number(stage?.requiredMedals),
    };
}

export function normalizeCampaignSeriesData(value) {
    const list = Array.isArray(value?.series) ? value.series : null;
    if (!list) throw new Error('The Campaign series file needs a "series" list.');
    const ids = new Set();
    const trackKeys = new Set();
    const series = list.map((entry) => {
        const id = entry?.id;
        if (typeof id !== 'string' || !SERIES_ID_RE.test(id)) {
            throw new Error(`Campaign series name ${JSON.stringify(id)} is not valid.`);
        }
        if (ids.has(id)) throw new Error(`Campaign series ${id} is listed twice.`);
        ids.add(id);
        const stages = (Array.isArray(entry.stages) ? entry.stages : []).map(normalizeStage);
        for (const stage of stages) {
            if (trackKeys.has(stage.trackKey)) {
                throw new Error(`Track ${stage.trackKey} is in more than one Campaign stage.`);
            }
            trackKeys.add(stage.trackKey);
        }
        return {
            id,
            name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
            ground: typeof entry.ground === 'string' ? entry.ground : 'tarmac',
            stages,
        };
    });
    return { series };
}

export function parseCampaignSeriesSource(source) {
    let value;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error('The Campaign series file is not valid JSON.');
    }
    return normalizeCampaignSeriesData(value);
}

export function serializeCampaignSeries(data) {
    return `${JSON.stringify({
        series: data.series.map((series) => ({
            id: series.id,
            name: series.name,
            ground: series.ground,
            stages: series.stages.map((stage) => ({
                trackKey: stage.trackKey,
                laps: stage.laps,
                requiredMedals: stage.requiredMedals,
            })),
        })),
    }, null, 2)}\n`;
}

// Returns { series, stageIndex } for the stage that uses the track, or null.
export function findTrackStage(data, trackKey) {
    for (const series of data.series) {
        const stageIndex = series.stages.findIndex((stage) => stage.trackKey === trackKey);
        if (stageIndex !== -1) return { series, stageIndex };
    }
    return null;
}

export function suggestRequiredMedals(series) {
    const index = series.stages.length;
    if (index === 0) return 0;
    return series.stages[index - 1].requiredMedals + 2;
}

export function getStageLapsError(laps) {
    return Number.isInteger(laps) && laps >= 1 && laps <= CAMPAIGN_STAGE_MAX_LAPS
        ? null
        : `Laps must be a whole number from 1 to ${CAMPAIGN_STAGE_MAX_LAPS}.`;
}

function cloneData(data) {
    return {
        series: data.series.map((series) => ({
            ...series,
            stages: series.stages.map((stage) => ({ ...stage })),
        })),
    };
}

// Takes the track out of a series that is not live. The later tracks move up
// one position, and each position keeps its medal target.
function removeDraftStage(series, stageIndex) {
    const targets = series.stages.map((stage) => stage.requiredMedals);
    const remaining = series.stages.filter((_, index) => index !== stageIndex);
    series.stages = remaining.map((stage, index) => ({ ...stage, requiredMedals: targets[index] }));
}

function liveStageError(series, action) {
    return new Error(
        `${series.name} is live, so its stages are fixed. You cannot ${action}.`,
    );
}

/**
 * Applies a track save or a Campaign Planner change to the series list.
 * - destination "daily" or "none": the track leaves its series (a series that is not live only).
 * - destination "series:<id>": the track joins that series after its last stage,
 *   or keeps its stage and gets new laps and a new medal target (not live only).
 * - A rename changes the track key of its stage (not live only).
 */
export function applyTrackSeriesUpdate(data, {
    trackKey,
    originalTrackKey = null,
    destination,
    laps = null,
    requiredMedals = null,
}) {
    const target = parseTrackDestination(destination, data);
    if (!target) throw new Error('Use For must be Daily Challenge, Not used, or a Campaign series.');
    const next = cloneData(data);
    const lookupKey = originalTrackKey ?? trackKey;
    const current = findTrackStage(next, lookupKey);
    const isRename = originalTrackKey !== null && originalTrackKey !== trackKey;

    if (isRename && findTrackStage(next, trackKey)) {
        throw new Error(`Track ${trackKey} is already a Campaign stage.`);
    }

    if (current) {
        const live = isAppCampaignSeriesLive(current.series);
        const stage = current.series.stages[current.stageIndex];
        const staysInSeries = target.type === 'series' && target.seriesId === current.series.id;
        if (live) {
            if (!staysInSeries) throw liveStageError(current.series, `move ${lookupKey} out of it`);
            if (isRename) throw liveStageError(current.series, `rename ${lookupKey}`);
            if (laps !== null && laps !== stage.laps) {
                throw liveStageError(current.series, `change the laps of ${lookupKey}`);
            }
            if (requiredMedals !== null && requiredMedals !== stage.requiredMedals) {
                throw liveStageError(current.series, `change the medal target of ${lookupKey}`);
            }
            return { data: next, series: current.series, stageIndex: current.stageIndex, changed: false };
        }
        if (staysInSeries) {
            if (isRename) stage.trackKey = trackKey;
            if (laps !== null) {
                const lapsError = getStageLapsError(laps);
                if (lapsError) throw new Error(lapsError);
                stage.laps = laps;
            }
            if (requiredMedals !== null) {
                const previous = current.stageIndex > 0
                    ? current.series.stages[current.stageIndex - 1].requiredMedals
                    : 0;
                const targetError = getRequiredMedalsError(requiredMedals, current.stageIndex, previous);
                if (targetError) throw new Error(targetError);
                const following = current.series.stages[current.stageIndex + 1];
                if (following && following.requiredMedals <= requiredMedals) {
                    throw new Error(
                        `The medal target must be less than ${following.requiredMedals}, the target of the stage after it.`,
                    );
                }
                stage.requiredMedals = requiredMedals;
            }
            return { data: next, series: current.series, stageIndex: current.stageIndex, changed: true };
        }
        removeDraftStage(current.series, current.stageIndex);
    }

    if (target.type !== 'series') {
        return { data: next, series: null, stageIndex: -1, changed: Boolean(current) };
    }

    const series = next.series.find((entry) => entry.id === target.seriesId);
    const stageIndex = series.stages.length;
    const stageLaps = laps ?? 1;
    const lapsError = getStageLapsError(stageLaps);
    if (lapsError) throw new Error(lapsError);
    const stageTarget = requiredMedals ?? suggestRequiredMedals(series);
    const previous = stageIndex > 0 ? series.stages[stageIndex - 1].requiredMedals : 0;
    const targetError = getRequiredMedalsError(stageTarget, stageIndex, previous);
    if (targetError) throw new Error(targetError);
    series.stages.push({ trackKey, laps: stageLaps, requiredMedals: stageTarget });
    return { data: next, series, stageIndex, changed: true };
}

// Moves a stage one position up (-1) or down (+1) in a series that is not live.
// The tracks and their laps move; the medal targets stay with the positions.
export function moveSeriesStage(data, seriesId, trackKey, direction) {
    const next = cloneData(data);
    const series = next.series.find((entry) => entry.id === seriesId);
    if (!series) throw new Error(`Campaign series ${seriesId} does not exist.`);
    if (isAppCampaignSeriesLive(series)) throw liveStageError(series, 'change the stage order');
    const from = series.stages.findIndex((stage) => stage.trackKey === trackKey);
    if (from === -1) throw new Error(`Track ${trackKey} is not in ${series.name}.`);
    const to = from + (direction < 0 ? -1 : 1);
    if (to < 0 || to >= series.stages.length) return next;
    const targets = series.stages.map((stage) => stage.requiredMedals);
    const stages = [...series.stages];
    [stages[from], stages[to]] = [stages[to], stages[from]];
    series.stages = stages.map((stage, index) => ({ ...stage, requiredMedals: targets[index] }));
    return next;
}
