import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    MUSIC_STORAGE_KEY,
    getMusicEnabled,
    setMusicEnabled,
} from '../game/settings/music-preference.js';

describe('music preference', () => {
    const store = new Map();

    beforeEach(() => {
        store.clear();
        globalThis.window = {
            localStorage: {
                getItem: (key) => (store.has(key) ? store.get(key) : null),
                setItem: (key, value) => {
                    store.set(key, String(value));
                },
                removeItem: (key) => {
                    store.delete(key);
                },
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('defaults to true when unset', () => {
        expect(getMusicEnabled()).toBe(true);
    });

    it('persists changes to localStorage', () => {
        expect(setMusicEnabled(false)).toBe(false);
        expect(store.get(MUSIC_STORAGE_KEY)).toBe('0');
        expect(getMusicEnabled()).toBe(false);

        expect(setMusicEnabled(true)).toBe(true);
        expect(store.get(MUSIC_STORAGE_KEY)).toBe('1');
        expect(getMusicEnabled()).toBe(true);
    });
});
