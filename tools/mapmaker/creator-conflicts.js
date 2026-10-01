// Compares Creator work with the version on the server, in the form the
// server stores. A save whose answer was lost, or a version that another
// device saved, is then known by its content.

import { MEDAL_TIERS } from './medal-times.js';
import { isValidTrackKey, trackKeyFromName } from './track-source.js';

const MAX_TRACK_NAME_LENGTH = 40;

function point(value) {
    const output = { x: value?.x, y: value?.y };
    if (value?.cornerRadius !== undefined) output.cornerRadius = value.cornerRadius;
    return output;
}

function gate(value) {
    return { p1: point(value?.p1), p2: point(value?.p2) };
}

function centiseconds(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

// Each medal rounded to 0.01 s, as the server stores it. A row with a blank or
// a zero time stays as it is: it is not the same as no row.
function medalRowContent(row) {
    if (!row || typeof row !== 'object') return null;
    return Object.fromEntries(MEDAL_TIERS.map((tier) => [tier, centiseconds(row[tier])]));
}

// The track, its unfinished road and its medal row as the server keeps them.
export function trackContent({ track, draftLoop, medalRow }) {
    const shape = {
        name: String(track?.name ?? '').trim(),
        outer: (track?.outer ?? []).map(point),
        inner: (track?.inner ?? []).map(point),
        startLine: gate(track?.startLine),
        startPos: point(track?.startPos),
        startAngle: track?.startAngle,
        checkpoints: (track?.checkpoints ?? []).map(gate),
    };
    if (track?.cornerRadius !== undefined) shape.cornerRadius = track.cornerRadius;
    if (track?.ground !== undefined) shape.ground = track.ground;
    return JSON.stringify({
        track: shape,
        draftLoop: (draftLoop ?? []).map(point),
        medalRow: medalRowContent(medalRow),
    });
}

export function sameTrackContent(first, second) {
    return trackContent(first) === trackContent(second);
}

// A series as the server keeps it: the name trimmed, the stages as numbers.
// The typed text of a medal target is only for its field.
export function seriesContent(series) {
    return JSON.stringify({
        name: String(series?.name ?? '').trim(),
        ground: series?.ground,
        stages: (series?.stages ?? []).map((stage) => ({
            trackKey: stage.trackKey,
            laps: Number(stage.laps),
            requiredMedals: stage.requiredMedals === null || stage.requiredMedals === undefined
                ? null : Number(stage.requiredMedals),
        })),
    });
}

export function sameSeriesContent(first, second) {
    return seriesContent(first) === seriesContent(second);
}

// The order of the Daily list is the order of the Dailies.
export function sameDailyKeys(first, second) {
    return Array.isArray(first) && Array.isArray(second)
        && first.length === second.length && first.every((key, index) => key === second[index]);
}

// A live series keeps its ground and its live stages. A draft that changes
// them cannot be saved over it.
export function fitsLiveSeries(draft, server) {
    const fixed = server?.publishedStageCount ?? 0;
    if (!fixed) return true;
    if (draft.ground !== server.ground) return false;
    for (let index = 0; index < fixed; index += 1) {
        const mine = draft.stages[index];
        const theirs = server.stages[index];
        if (!mine || !theirs || mine.trackKey !== theirs.trackKey || Number(mine.laps) !== theirs.laps
            || Number(mine.requiredMedals) !== theirs.requiredMedals) return false;
    }
    return true;
}

// Saves that ended with no clear answer: the server may have them. Each key
// keeps its own list, and a retry never replaces an earlier entry.
export function rememberUncertain(uncertainByKey, key, content) {
    const entries = uncertainByKey.get(key) ?? [];
    if (!entries.includes(content)) entries.push(content);
    uncertainByKey.set(key, entries.slice(-10));
}

export function isUncertain(uncertainByKey, key, content) {
    return Boolean(uncertainByKey.get(key)?.includes(content));
}

// A request with no clear answer: no HTTP answer, a server failure, or an
// answer that cannot be read. A 4xx answer is clear: nothing was written.
export function isUncertainFailure(error) {
    const status = Number(error?.status);
    return !Number.isFinite(status) || status === 0 || status >= 500;
}

// The name and key of a copy: "‹name› copy", then "‹name› copy 2" and on.
// The suffix always fits in the name limit, and the key is free.
export function copyTrackName(name, isTaken) {
    const base = String(name ?? '').trim() || 'Track';
    for (let number = 1; number <= 50; number += 1) {
        const suffix = number === 1 ? ' copy' : ` copy ${number}`;
        const candidate = `${base.slice(0, MAX_TRACK_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
        const key = trackKeyFromName(candidate);
        if (isValidTrackKey(key) && !isTaken(key)) return { name: candidate, key };
    }
    return null;
}
