import { normalizeCarDecals, normalizeCarDecalStyle } from './car-decals.js';
import { isDrawnCarAsset } from './drawn-car-skins.js';

export const PLAYER_CAR_DECALS_STORAGE_KEY = 'MiniRacerPlayerCarDecals';

export function readPlayerCarDecals() {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    try {
        const raw = window.localStorage.getItem(PLAYER_CAR_DECALS_STORAGE_KEY);
        return normalizeCarDecals(raw ? JSON.parse(raw) : null);
    } catch (error) {
        console.error('Error reading player car decals:', error);
        return {};
    }
}

export function readPlayerCarDecalStyle(assetName) {
    if (!isDrawnCarAsset(assetName)) return null;
    return readPlayerCarDecals()[assetName] ?? null;
}

// Replace owner maps; profiles predating decals clear another owner's cache.
export function applyPlayerCarDecals(value) {
    const decals = normalizeCarDecals(value);
    if (typeof window === 'undefined' || !window.localStorage) return decals;
    try {
        if (Object.keys(decals).length > 0) {
            window.localStorage.setItem(PLAYER_CAR_DECALS_STORAGE_KEY, JSON.stringify(decals));
        } else {
            window.localStorage.removeItem(PLAYER_CAR_DECALS_STORAGE_KEY);
        }
    } catch (error) {
        console.error('Error saving player car decals:', error);
    }
    return decals;
}

export function writePlayerCarDecalStyle(assetName, id) {
    if (!isDrawnCarAsset(assetName)) return null;
    const decals = readPlayerCarDecals();
    const style = normalizeCarDecalStyle(assetName, id);
    if (id !== null && !style) return decals[assetName] ?? null;
    if (style) decals[assetName] = style;
    else delete decals[assetName];
    applyPlayerCarDecals(decals);
    return decals[assetName] ?? null;
}
