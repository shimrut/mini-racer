import {
    DEFAULT_PAUSE_PLACEMENT,
    normalizePausePlacement,
    PAUSE_PLACEMENT_SEPARATE,
    PAUSE_PLACEMENT_SPEEDO,
    PAUSE_PLACEMENT_TIMER,
} from '../shared/pause-placement.js';
import { parseStoredBooleanToggle } from './parse-stored-boolean-toggle.js';

export const PAUSE_PLACEMENT_STORAGE_KEY = 'VectorGpPausePlacement';
export const PAUSE_ON_TIMER_STORAGE_KEY = 'VectorGpPauseOnTimerEnabled';

export {
    DEFAULT_PAUSE_PLACEMENT,
    normalizePausePlacement,
    PAUSE_PLACEMENT_SEPARATE,
    PAUSE_PLACEMENT_SPEEDO,
    PAUSE_PLACEMENT_TIMER,
};

function readLegacyTimerEnabled() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return true;
    }
    try {
        return parseStoredBooleanToggle(
            window.localStorage.getItem(PAUSE_ON_TIMER_STORAGE_KEY),
            { treatMissingAsTrue: true },
        );
    } catch (error) {
        console.error('Error reading pause on timer preference:', error);
        return true;
    }
}

export function getPausePlacement() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return DEFAULT_PAUSE_PLACEMENT;
    }
    try {
        const stored = normalizePausePlacement(
            window.localStorage.getItem(PAUSE_PLACEMENT_STORAGE_KEY),
        );
        if (stored) return stored;
        return readLegacyTimerEnabled() ? PAUSE_PLACEMENT_TIMER : PAUSE_PLACEMENT_SEPARATE;
    } catch (error) {
        console.error('Error reading pause placement preference:', error);
        return DEFAULT_PAUSE_PLACEMENT;
    }
}

export function setPausePlacement(value) {
    const next = normalizePausePlacement(value) ?? DEFAULT_PAUSE_PLACEMENT;
    if (typeof window === 'undefined' || !window.localStorage) {
        return next;
    }
    try {
        window.localStorage.setItem(PAUSE_PLACEMENT_STORAGE_KEY, next);
        window.localStorage.setItem(
            PAUSE_ON_TIMER_STORAGE_KEY,
            next === PAUSE_PLACEMENT_TIMER ? '1' : '0',
        );
    } catch (error) {
        console.error('Error writing pause placement preference:', error);
    }
    return next;
}

export function applyPausePlacementPreference(value) {
    if (!value || typeof value !== 'object') {
        return setPausePlacement(DEFAULT_PAUSE_PLACEMENT);
    }
    const fromPlacement = normalizePausePlacement(value.pausePlacement);
    if (fromPlacement) {
        return setPausePlacement(fromPlacement);
    }
    return setPausePlacement(
        value.pauseOnTimerEnabled === false
            ? PAUSE_PLACEMENT_SEPARATE
            : PAUSE_PLACEMENT_TIMER,
    );
}
