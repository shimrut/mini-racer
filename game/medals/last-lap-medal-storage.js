import { isStandardMedalTier, maxMedalTier } from './medals.js';

const STORAGE_KEY = 'VectorGpTrackLastLapMedal';

function readMap() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return {};
    }
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeMap(map) {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
    }
}

export function readTrackLastLapMedal(trackKey) {
    if (!trackKey) return null;
    const v = readMap()[trackKey];
    if (isStandardMedalTier(v)) return v;
    return null;
}

export function writeTrackLastLapMedal(trackKey, medal) {
    if (!trackKey) return;
    const map = readMap();
    const prevRaw = map[trackKey];
    const prev = isStandardMedalTier(prevRaw) ? prevRaw : null;
    const incoming = isStandardMedalTier(medal) ? medal : null;
    const merged = maxMedalTier(prev, incoming);
    if (merged) {
        map[trackKey] = merged;
    } else {
        delete map[trackKey];
    }
    writeMap(map);
}
