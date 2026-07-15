import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    COLLISION_RESTART_DELAY_STORAGE_KEY,
    collisionRestartDelayToMeterStep,
    getCollisionRestartDelaySec,
    normalizeCollisionRestartDelaySec,
    setCollisionRestartDelaySec,
} from '../game/settings/collision-restart-delay-preference.js';

describe('collision restart delay preference', () => {
    const store = new Map();

    beforeEach(() => {
        store.clear();
        globalThis.window = {
            localStorage: {
                getItem: (key) => (store.has(key) ? store.get(key) : null),
                setItem: (key, value) => store.set(key, String(value)),
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('defaults to half a second when unset', () => {
        expect(getCollisionRestartDelaySec()).toBe(0.5);
    });

    it('normalizes the supported range to tenths', () => {
        expect(normalizeCollisionRestartDelaySec(0)).toBe(0);
        expect(normalizeCollisionRestartDelaySec(1)).toBe(1);
        expect(normalizeCollisionRestartDelaySec(0.34)).toBe(0.3);
        expect(normalizeCollisionRestartDelaySec(0.35)).toBe(0.4);
        expect(normalizeCollisionRestartDelaySec(1.9)).toBe(1);
        expect(normalizeCollisionRestartDelaySec(-2)).toBe(0);
    });

    it('persists a normalized delay using the existing storage slot', () => {
        expect(setCollisionRestartDelaySec(0.8)).toBe(0.8);
        expect(store.get(COLLISION_RESTART_DELAY_STORAGE_KEY)).toBe('0.8');
        expect(getCollisionRestartDelaySec()).toBe(0.8);
    });

    it('maps seconds to meter steps', () => {
        expect(collisionRestartDelayToMeterStep(0)).toBe(0);
        expect(collisionRestartDelayToMeterStep(0.5)).toBe(5);
        expect(collisionRestartDelayToMeterStep(1)).toBe(10);
    });
});
