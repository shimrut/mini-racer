import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    CRASH_RESTART_DELAY_STORAGE_KEY,
    crashRestartDelayToMeterStep,
    getCrashRestartDelaySec,
    normalizeCrashRestartDelaySec,
    setCrashRestartDelaySec,
} from '../game/settings/crash-restart-delay-preference.js';

describe('crash restart delay preference', () => {
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

    it('defaults when unset', () => {
        expect(getCrashRestartDelaySec()).toBe(0.5);
    });

    it('normalizes to 0.1 steps within 0–1', () => {
        expect(normalizeCrashRestartDelaySec(0)).toBe(0);
        expect(normalizeCrashRestartDelaySec(1)).toBe(1);
        expect(normalizeCrashRestartDelaySec(0.34)).toBe(0.3);
        expect(normalizeCrashRestartDelaySec(0.35)).toBe(0.4);
        expect(normalizeCrashRestartDelaySec(1.9)).toBe(1);
        expect(normalizeCrashRestartDelaySec(-2)).toBe(0);
    });

    it('persists', () => {
        expect(setCrashRestartDelaySec(0.8)).toBe(0.8);
        expect(store.get(CRASH_RESTART_DELAY_STORAGE_KEY)).toBe('0.8');
        expect(getCrashRestartDelaySec()).toBe(0.8);
    });

    it('maps seconds to meter step index', () => {
        expect(crashRestartDelayToMeterStep(0)).toBe(0);
        expect(crashRestartDelayToMeterStep(0.5)).toBe(5);
        expect(crashRestartDelayToMeterStep(1)).toBe(10);
    });
});
