import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    QUICK_RESTART_STORAGE_KEY,
    getQuickRestartEnabled,
    setQuickRestartEnabled,
} from '../game/settings/quick-restart-preference.js';

describe('quick restart preference', () => {
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

    it('defaults to off and persists both states', () => {
        expect(getQuickRestartEnabled()).toBe(false);
        expect(setQuickRestartEnabled(true)).toBe(true);
        expect(store.get(QUICK_RESTART_STORAGE_KEY)).toBe('1');
        expect(getQuickRestartEnabled()).toBe(true);
        expect(setQuickRestartEnabled(false)).toBe(false);
        expect(store.get(QUICK_RESTART_STORAGE_KEY)).toBe('0');
    });
});
