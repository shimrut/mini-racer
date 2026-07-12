import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    CRASH_AUTO_RESTART_STORAGE_KEY,
    getCrashAutoRestartAfterCrashEnabled,
    setCrashAutoRestartAfterCrashEnabled,
} from '../game/settings/crash-auto-restart-preference.js';

describe('crash auto-restart preference', () => {
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
        expect(getCrashAutoRestartAfterCrashEnabled()).toBe(true);
    });

    it('persists on and off', () => {
        expect(setCrashAutoRestartAfterCrashEnabled(true)).toBe(true);
        expect(store.get(CRASH_AUTO_RESTART_STORAGE_KEY)).toBe('1');
        expect(getCrashAutoRestartAfterCrashEnabled()).toBe(true);

        expect(setCrashAutoRestartAfterCrashEnabled(false)).toBe(false);
        expect(store.get(CRASH_AUTO_RESTART_STORAGE_KEY)).toBe('0');
        expect(getCrashAutoRestartAfterCrashEnabled()).toBe(false);
    });
});
