import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    COLLISION_AUTO_RESTART_STORAGE_KEY,
    getCollisionAutoRestartEnabled,
    setCollisionAutoRestartEnabled,
} from '../game/settings/collision-auto-restart-preference.js';

describe('collision auto-restart preference', () => {
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

    it('defaults to off when unset', () => {
        expect(getCollisionAutoRestartEnabled()).toBe(false);
    });

    it('persists on and off using the existing player storage slot', () => {
        expect(setCollisionAutoRestartEnabled(true)).toBe(true);
        expect(store.get(COLLISION_AUTO_RESTART_STORAGE_KEY)).toBe('1');
        expect(getCollisionAutoRestartEnabled()).toBe(true);

        expect(setCollisionAutoRestartEnabled(false)).toBe(false);
        expect(store.get(COLLISION_AUTO_RESTART_STORAGE_KEY)).toBe('0');
        expect(getCollisionAutoRestartEnabled()).toBe(false);
    });
});
