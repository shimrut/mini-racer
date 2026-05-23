import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    CAR_PROCEDURAL_AUDIO_STORAGE_KEY,
    getCarProceduralAudioEnabled,
    setCarProceduralAudioEnabled,
} from '../game/settings/car-audio-preference.js';

describe('car procedural audio preference', () => {
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

    it('defaults to on when unset', () => {
        expect(getCarProceduralAudioEnabled()).toBe(true);
    });

    it('persists on and off', () => {
        expect(setCarProceduralAudioEnabled(true)).toBe(true);
        expect(store.get(CAR_PROCEDURAL_AUDIO_STORAGE_KEY)).toBe('1');
        expect(getCarProceduralAudioEnabled()).toBe(true);

        expect(setCarProceduralAudioEnabled(false)).toBe(false);
        expect(store.get(CAR_PROCEDURAL_AUDIO_STORAGE_KEY)).toBe('0');
        expect(getCarProceduralAudioEnabled()).toBe(false);
    });
});
