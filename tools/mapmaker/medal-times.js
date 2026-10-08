// Medal times in the Mapmaker, and the Test Drive laps that help to choose them.

export {
    MEDAL_TIERS,
    getMedalRowError,
    normalizeMedalRow,
    sameMedalRow,
} from '../../game/track/authoring/medal-rules.js';

// Median gaps between the author time and the other medals on the current tracks.
export const MEDAL_GAP_RATIOS = Object.freeze({ gold: 1.025, silver: 1.055, bronze: 1.088 });
// Bronze laps stay under this, because the server refuses replays over 41.7 s per lap.
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

// A layout hash; any wall, gate, start, corner or ground change voids old Test Drive laps.
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
