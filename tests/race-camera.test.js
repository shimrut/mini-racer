import { describe, expect, it } from 'vitest';
import {
    getCameraZoom,
    getDesiredLookAhead,
    getLookAheadLerpFactor,
    isMobileCameraMode,
} from '../game/race/race-camera.js';

// The numbers the race camera used before it moved into its own module.
describe('race camera', () => {
    it('keeps the race zoom on desktop and phone', () => {
        expect(getCameraZoom(false)).toBe(1);
        expect(getCameraZoom(true)).toBe(0.75);
        expect(isMobileCameraMode({ coarsePointer: false, narrowViewport: true })).toBe(true);
        expect(isMobileCameraMode({})).toBe(false);
    });

    it('looks ahead along the velocity, up to a limit', () => {
        const out = { x: 0, y: 0 };
        expect(getDesiredLookAhead(out, { x: 10, y: 0 }, 10, 1000, 800, false)).toEqual({ x: 50, y: 0 });
        expect(getDesiredLookAhead(out, { x: 100, y: 0 }, 100, 1000, 800, false)).toEqual({ x: 160, y: 0 });
        expect(getDesiredLookAhead(out, { x: 10, y: 0 }, 10, 1000, 800, true)).toEqual({ x: 120, y: 0 });
        expect(getDesiredLookAhead(out, { x: 100, y: 0 }, 100, 1000, 800, true)).toEqual({ x: 320, y: 0 });
        expect(getDesiredLookAhead(out, { x: 0.5, y: 0 }, 0.5, 1000, 800, false)).toEqual({ x: 0, y: 0 });
    });

    it('smooths the look-ahead with the race rates and frame limits', () => {
        expect(getLookAheadLerpFactor(1 / 60, false)).toBeCloseTo(1 - Math.exp(-4 / 60), 12);
        expect(getLookAheadLerpFactor(1 / 60, true)).toBeCloseTo(1 - Math.exp(-2 / 60), 12);
        expect(getLookAheadLerpFactor(1, false)).toBeCloseTo(1 - Math.exp(-4 / 45), 12);
        expect(getLookAheadLerpFactor(1 / 500, false)).toBeCloseTo(1 - Math.exp(-4 / 120), 12);
        expect(getLookAheadLerpFactor(0, false)).toBe(0);
    });
});
