import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    HIDE_HUD_STORAGE_KEY,
    getHideHudEnabled,
    setHideHudEnabled,
} from '../game/settings/hide-hud-preference.js';

describe('hide hud preference', () => {
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
        expect(getHideHudEnabled()).toBe(false);
        expect(setHideHudEnabled(true)).toBe(true);
        expect(store.get(HIDE_HUD_STORAGE_KEY)).toBe('1');
        expect(getHideHudEnabled()).toBe(true);
        expect(setHideHudEnabled(false)).toBe(false);
        expect(store.get(HIDE_HUD_STORAGE_KEY)).toBe('0');
    });
});
