import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    PAUSE_ON_TIMER_STORAGE_KEY,
    getPauseOnTimerEnabled,
    setPauseOnTimerEnabled,
} from '../game/settings/pause-on-timer-preference.js';

describe('pause on timer preference', () => {
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

    it('defaults to enabled and persists both states', () => {
        expect(getPauseOnTimerEnabled()).toBe(true);
        expect(setPauseOnTimerEnabled(false)).toBe(false);
        expect(store.get(PAUSE_ON_TIMER_STORAGE_KEY)).toBe('0');
        expect(getPauseOnTimerEnabled()).toBe(false);
        expect(setPauseOnTimerEnabled(true)).toBe(true);
        expect(store.get(PAUSE_ON_TIMER_STORAGE_KEY)).toBe('1');
    });
});
