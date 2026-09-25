// Medal times in the Mapmaker, and the Drive Draft laps that help to choose them.

// Median gaps between the author time and the other medals on the current tracks.
export const MEDAL_GAP_RATIOS = Object.freeze({ gold: 1.025, silver: 1.055, bronze: 1.088 });
export const MEDAL_TIERS = Object.freeze(['author', 'gold', 'silver', 'bronze']);
// Keep a bronze lap under this time, because the server refuses a replay longer
// than 41.7 s for each lap (docs/track-authoring.md).
export const BRONZE_WARNING_SEC = 25;
export const DRAFT_LAP_LIMIT = 10;
const DRAFT_LAPS_PREFIX = 'mapmaker:draft-laps:v1:';

function roundCentiseconds(value) {
    return Math.round(value * 100) / 100;
}

// A lap time as an author time: rounded up to 0.01 s, so the lap itself earns it.
export function lapToAuthorTime(lapSec) {
    const lap = Number(lapSec);
    if (!Number.isFinite(lap) || lap <= 0) return null;
    return Math.ceil(lap * 100 - 1e-6) / 100;
}

export function suggestMedalTimes(authorSec) {
    const author = Number(authorSec);
    if (!Number.isFinite(author) || author <= 0) return null;
    const rounded = roundCentiseconds(author);
    return {
        author: rounded,
        gold: roundCentiseconds(rounded * MEDAL_GAP_RATIOS.gold),
        silver: roundCentiseconds(rounded * MEDAL_GAP_RATIOS.silver),
        bronze: roundCentiseconds(rounded * MEDAL_GAP_RATIOS.bronze),
    };
}

export function normalizeMedalRow(row) {
    if (!row || typeof row !== 'object') return null;
    const values = {};
    for (const tier of MEDAL_TIERS) {
        const value = Number(row[tier]);
        if (!Number.isFinite(value) || value <= 0) return null;
        values[tier] = roundCentiseconds(value);
    }
    return values;
}

// Returns an error text, or null when all four times are set and in order.
export function getMedalRowError(row) {
    const values = normalizeMedalRow(row);
    if (!values) return 'Set all four medal times.';
    if (!(values.author < values.gold && values.gold < values.silver && values.silver < values.bronze)) {
        return 'Medal times must go up: author, then gold, then silver, then bronze.';
    }
    return null;
}

export function sameMedalRow(first, second) {
    const a = normalizeMedalRow(first);
    const b = normalizeMedalRow(second);
    if (!a || !b) return a === b;
    return MEDAL_TIERS.every((tier) => a[tier] === b[tier]);
}

// A short hash of the track layout. A change to a wall, gate, start point,
// corner or ground gives a new hash, so old Drive Draft laps do not count.
export function trackLayoutHash(track) {
    const { name: _name, ...layout } = track && typeof track === 'object' ? track : {};
    const text = JSON.stringify(layout);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function draftLapsStorageKey(trackKey, track) {
    return `${DRAFT_LAPS_PREFIX}${trackKey}:${trackLayoutHash(track)}`;
}

function sanitizeLaps(value) {
    return (Array.isArray(value) ? value : [])
        .map(Number)
        .filter((lap) => Number.isFinite(lap) && lap > 0)
        .sort((a, b) => a - b)
        .slice(0, DRAFT_LAP_LIMIT);
}

export function readDraftLaps(storage, key) {
    try {
        return sanitizeLaps(JSON.parse(storage?.getItem(key) || '[]'));
    } catch {
        return [];
    }
}

// Saves one finished lap and keeps the 10 best. Returns the saved list.
export function recordDraftLap(storage, key, lapSec) {
    const laps = sanitizeLaps([...readDraftLaps(storage, key), Number(lapSec)]);
    try {
        storage?.setItem(key, JSON.stringify(laps));
    } catch {}
    return laps;
}

export function averageDraftLap(laps) {
    const clean = sanitizeLaps(laps);
    if (!clean.length) return null;
    return clean.reduce((sum, lap) => sum + lap, 0) / clean.length;
}
