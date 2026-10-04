import { CAR_PAINT_CHANNELS, normalizeCarPaints } from './car-paint.js';
import { isDrawnCarAsset } from './drawn-car-skins.js';

export const PLAYER_CAR_PAINT_STORAGE_KEY = 'MiniRacerPlayerCarPaints';

export function readPlayerCarPaints() {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    try {
        const raw = window.localStorage.getItem(PLAYER_CAR_PAINT_STORAGE_KEY);
        return normalizeCarPaints(raw ? JSON.parse(raw) : null);
    } catch (error) {
        console.error('Error reading player car paint:', error);
        return {};
    }
}

export function readPlayerCarPaint(assetName) {
    if (!isDrawnCarAsset(assetName)) return {};
    return readPlayerCarPaints()[assetName] ?? {};
}

// Replaces the cache when applying the authoritative owner's profile. Older
// profiles without paints clear another owner's locally cached colors.
export function applyPlayerCarPaints(value) {
    const paints = normalizeCarPaints(value);
    if (typeof window === 'undefined' || !window.localStorage) return paints;
    try {
        if (Object.keys(paints).length > 0) {
            window.localStorage.setItem(PLAYER_CAR_PAINT_STORAGE_KEY, JSON.stringify(paints));
        } else {
            window.localStorage.removeItem(PLAYER_CAR_PAINT_STORAGE_KEY);
        }
    } catch (error) {
        console.error('Error saving player car paint:', error);
    }
    return paints;
}

export function writePlayerCarPaint(assetName, channel, color) {
    const paints = readPlayerCarPaints();
    if (!isDrawnCarAsset(assetName)) return {};
    if (!CAR_PAINT_CHANNELS.some(({ id }) => id === channel)) {
        return paints[assetName] ?? {};
    }
    // A preset choice removes just this override, retaining its original
    // hand-authored tones and the other customized channels.
    if (color === null) {
        const remaining = { ...paints[assetName] };
        delete remaining[channel];
        if (Object.keys(remaining).length) paints[assetName] = remaining;
        else delete paints[assetName];
        applyPlayerCarPaints(paints);
        return remaining;
    }
    const next = normalizeCarPaints({ [assetName]: { [channel]: color } })[assetName];
    if (!next) return paints[assetName] ?? {};
    paints[assetName] = { ...paints[assetName], ...next };
    applyPlayerCarPaints(paints);
    return paints[assetName];
}
