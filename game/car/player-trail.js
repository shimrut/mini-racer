import { PLAYER_SELECTABLE_CAR_ASSETS } from './car-unlock-policy.js';

export const PLAYER_TRAIL_STORAGE_KEY = 'MiniRacerPlayerTrail';
export const PLAYER_CAR_TRAILS_STORAGE_KEY = 'MiniRacerPlayerCarTrails';

export const PLAYER_TRAIL_COLORS = Object.freeze([
    Object.freeze({ id: 'none', label: 'No Trail', strokeStyle: 'rgba(15, 23, 42, 0)', swatch: '#0f172a' }),
    Object.freeze({ id: 'sky', label: 'Sky', strokeStyle: 'rgba(56, 189, 248, 0.5)', swatch: '#38bdf8' }),
    Object.freeze({ id: 'cyan', label: 'Cyan', strokeStyle: 'rgba(34, 211, 238, 0.5)', swatch: '#22d3ee' }),
    Object.freeze({ id: 'lime', label: 'Lime', strokeStyle: 'rgba(163, 230, 53, 0.5)', swatch: '#a3e635' }),
    Object.freeze({ id: 'gold', label: 'Gold', strokeStyle: 'rgba(250, 204, 21, 0.5)', swatch: '#facc15' }),
    Object.freeze({ id: 'coral', label: 'Coral', strokeStyle: 'rgba(251, 113, 133, 0.5)', swatch: '#fb7185' }),
    Object.freeze({ id: 'violet', label: 'Violet', strokeStyle: 'rgba(167, 139, 250, 0.5)', swatch: '#a78bfa' }),
    Object.freeze({ id: 'white', label: 'White', strokeStyle: 'rgba(248, 250, 252, 0.55)', swatch: '#f8fafc' })
]);

const DEFAULT_TRAIL_ID = 'sky';

const BY_ID = new Map(PLAYER_TRAIL_COLORS.map((entry) => [entry.id, entry]));
const CAR_ASSETS = new Set(PLAYER_SELECTABLE_CAR_ASSETS);

export function normalizeCarTrails(value) {
    const trails = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return trails;
    for (const assetName of PLAYER_SELECTABLE_CAR_ASSETS) {
        if (!Object.hasOwn(value, assetName)) continue;
        const id = typeof value[assetName] === 'string' ? value[assetName].trim() : '';
        if (BY_ID.has(id)) trails[assetName] = id;
    }
    return trails;
}

export function readPlayerCarTrails() {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    try {
        const raw = window.localStorage.getItem(PLAYER_CAR_TRAILS_STORAGE_KEY);
        return normalizeCarTrails(raw ? JSON.parse(raw) : null);
    } catch (error) {
        console.error('Error reading player car trails:', error);
        return {};
    }
}

export function applyPlayerCarTrails(value) {
    const trails = normalizeCarTrails(value);
    if (typeof window === 'undefined' || !window.localStorage) return trails;
    try {
        if (Object.keys(trails).length) {
            window.localStorage.setItem(PLAYER_CAR_TRAILS_STORAGE_KEY, JSON.stringify(trails));
        } else {
            window.localStorage.removeItem(PLAYER_CAR_TRAILS_STORAGE_KEY);
        }
    } catch (error) {
        console.error('Error saving player car trails:', error);
    }
    return trails;
}

export function trailStrokeStyleForId(id) {
    if (id === 'none') return null;
    return BY_ID.get(id)?.strokeStyle ?? BY_ID.get(DEFAULT_TRAIL_ID).strokeStyle;
}

export function readPlayerTrailId(assetName) {
    const picked = assetName && readPlayerCarTrails()[assetName];
    if (picked) return picked;
    // Existing global choices remain the fallback for skins not yet customized.
    if (typeof window === 'undefined' || !window.localStorage) {
        return DEFAULT_TRAIL_ID;
    }
    try {
        const raw = window.localStorage.getItem(PLAYER_TRAIL_STORAGE_KEY);
        if (!raw) return DEFAULT_TRAIL_ID;
        const parsed = JSON.parse(raw);
        const id = typeof parsed === 'string' ? parsed.trim() : '';
        if (id && BY_ID.has(id)) return id;
    } catch (error) {
        console.error('Error reading player trail color:', error);
    }
    return DEFAULT_TRAIL_ID;
}

export function readPlayerTrailStrokeStyle(assetName) {
    return trailStrokeStyleForId(readPlayerTrailId(assetName));
}

export function writePlayerTrailId(id, assetName) {
    const next = BY_ID.has(id) ? id : DEFAULT_TRAIL_ID;
    if (assetName !== undefined) {
        if (!CAR_ASSETS.has(assetName)) return readPlayerTrailId();
        applyPlayerCarTrails({ ...readPlayerCarTrails(), [assetName]: next });
        return next;
    }
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            window.localStorage.setItem(PLAYER_TRAIL_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
            console.error('Error saving player trail color:', error);
        }
    }
    return next;
}
