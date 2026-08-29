import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    PAUSE_ON_TIMER_STORAGE_KEY,
    PAUSE_PLACEMENT_SEPARATE,
    PAUSE_PLACEMENT_SPEEDO,
    PAUSE_PLACEMENT_STORAGE_KEY,
    PAUSE_PLACEMENT_TIMER,
    applyPausePlacementPreference,
    getPausePlacement,
    setPausePlacement,
} from '../game/settings/pause-placement-preference.js';

describe('pause placement preference', () => {
    const store = new Map();

    beforeEach(() => {
        store.clear();
        globalThis.window = {
            localStorage: {
                getItem: (key) => store.get(key) ?? null,
                setItem: (key, value) => store.set(key, String(value)),
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('defaults to timer and persists each placement', () => {
        expect(getPausePlacement()).toBe(PAUSE_PLACEMENT_TIMER);
        expect(setPausePlacement(PAUSE_PLACEMENT_SEPARATE)).toBe(PAUSE_PLACEMENT_SEPARATE);
        expect(store.get(PAUSE_PLACEMENT_STORAGE_KEY)).toBe('separate');
        expect(store.get(PAUSE_ON_TIMER_STORAGE_KEY)).toBe('0');
        expect(getPausePlacement()).toBe(PAUSE_PLACEMENT_SEPARATE);
        expect(setPausePlacement(PAUSE_PLACEMENT_SPEEDO)).toBe(PAUSE_PLACEMENT_SPEEDO);
        expect(store.get(PAUSE_PLACEMENT_STORAGE_KEY)).toBe('speedo');
        expect(getPausePlacement()).toBe(PAUSE_PLACEMENT_SPEEDO);
        expect(setPausePlacement(PAUSE_PLACEMENT_TIMER)).toBe(PAUSE_PLACEMENT_TIMER);
        expect(store.get(PAUSE_ON_TIMER_STORAGE_KEY)).toBe('1');
    });

    it('reads the old timer toggle when the new key is missing', () => {
        store.set(PAUSE_ON_TIMER_STORAGE_KEY, '0');
        expect(getPausePlacement()).toBe(PAUSE_PLACEMENT_SEPARATE);
        store.set(PAUSE_ON_TIMER_STORAGE_KEY, '1');
        expect(getPausePlacement()).toBe(PAUSE_PLACEMENT_TIMER);
    });

    it('applies a saved profile, preferring the new placement field', () => {
        expect(applyPausePlacementPreference({ pauseOnTimerEnabled: false })).toBe(PAUSE_PLACEMENT_SEPARATE);
        expect(applyPausePlacementPreference({ pausePlacement: 'speedo', pauseOnTimerEnabled: true }))
            .toBe(PAUSE_PLACEMENT_SPEEDO);
        expect(applyPausePlacementPreference({})).toBe(PAUSE_PLACEMENT_TIMER);
    });
});
