import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PHYSICS_TUNING,
    normalizePhysicsConfig,
    simulateStraightLine,
} from '../game/car/handling.js';
import { clamp } from '../game/shared/clamp.js';

describe('car handling helpers', () => {
    it('clamps values to inclusive bounds', () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-1, 0, 10)).toBe(0);
        expect(clamp(99, 0, 10)).toBe(10);
    });

    it('returns fallback when config is missing or not an object', () => {
        const fromNull = normalizePhysicsConfig(null);
        const fromNumber = normalizePhysicsConfig(7);
        const fromUndefined = normalizePhysicsConfig(undefined);
        expect(fromNull).toEqual({ ...DEFAULT_PHYSICS_TUNING });
        expect(fromNumber).toEqual({ ...DEFAULT_PHYSICS_TUNING });
        expect(fromUndefined).toEqual({ ...DEFAULT_PHYSICS_TUNING });
        expect(fromNull).not.toBe(DEFAULT_PHYSICS_TUNING);
    });

    it('copies only finite numeric overrides and clamps optional ranges', () => {
        const normalized = normalizePhysicsConfig({
            accel: 500,
            maxSpeed: 280,
            brakePower: 90,
            turnRate: 3.5,
            grip: -4,
            steerGripScale: 9,
            downforceGrip: -1,
            highSpeedSteerTrim: 2,
            angularResponse: 1,
            ignored: 'nope',
            badAccel: Number.NaN,
        });

        expect(normalized.accel).toBe(500);
        expect(normalized.maxSpeed).toBe(280);
        expect(normalized.brakePower).toBe(90);
        expect(normalized.turnRate).toBe(3.5);
        expect(normalized.grip).toBe(0);
        expect(normalized.steerGripScale).toBe(1.5);
        expect(normalized.downforceGrip).toBe(0);
        expect(normalized.highSpeedSteerTrim).toBe(0.92);
        expect(normalized.angularResponse).toBe(4);
    });

    it('keeps defaults when override fields are non-finite', () => {
        const normalized = normalizePhysicsConfig({
            accel: Number.NaN,
            maxSpeed: Number.POSITIVE_INFINITY,
            brakePower: 'fast',
            turnRate: null,
            grip: undefined,
            steerGripScale: Number.NaN,
            downforceGrip: 'x',
            highSpeedSteerTrim: {},
            angularResponse: false,
        });
        expect(normalized).toEqual({ ...DEFAULT_PHYSICS_TUNING });
    });

    it('rejects array configs the same as non-object primitives for field copies', () => {
        // Arrays are typeof 'object', so fields are only applied when finite numbers exist.
        expect(normalizePhysicsConfig([])).toEqual({ ...DEFAULT_PHYSICS_TUNING });
        expect(normalizePhysicsConfig('config')).toEqual({ ...DEFAULT_PHYSICS_TUNING });
        expect(normalizePhysicsConfig(true)).toEqual({ ...DEFAULT_PHYSICS_TUNING });
    });

    it('marks target reached only when the world-speed threshold is hit', () => {
        const hit = simulateStraightLine(
            { accel: 400, maxSpeed: 310 },
            { targetSpeed: 40, maxTime: 20 },
        );
        expect(hit.reached).toBe(true);
        expect(hit.speed * 20).toBeGreaterThanOrEqual(40);
        expect(hit.time).toBeGreaterThan(0);
        expect(hit.time).toBeLessThan(20);
    });

    it('uses inclusive loop and speed comparisons at exact thresholds', () => {
        const oneStep = simulateStraightLine(
            { accel: 400, maxSpeed: 310 },
            { maxTime: 1 / 60, dt: 1 / 60 },
        );
        expect(oneStep.time).toBeCloseTo(1 / 60, 8);
        expect(oneStep.speed).toBeGreaterThan(0);

        const exactWorld = oneStep.speed;
        const exactHit = simulateStraightLine(
            { accel: 400, maxSpeed: 310 },
            { maxTime: 1 / 60, dt: 1 / 60, targetSpeed: exactWorld * 20 },
        );
        expect(exactHit.reached).toBe(true);
        expect(exactHit.speed).toBeCloseTo(exactWorld, 10);

        const exactMiss = simulateStraightLine(
            { accel: 400, maxSpeed: 310 },
            { maxTime: 1 / 60, dt: 1 / 60, targetSpeed: exactWorld * 20 + 0.0001 },
        );
        expect(exactMiss.reached).toBe(false);
        expect(exactMiss.speed).toBeCloseTo(exactWorld, 10);
    });

    it('reports not reached when target speed is never attained', () => {
        const miss = simulateStraightLine(
            { accel: 5, maxSpeed: 40 },
            { targetSpeed: 200, maxTime: 0.5 },
        );
        expect(miss.reached).toBe(false);
        expect(miss.time).toBeCloseTo(0.5, 5);
        expect(miss.speed * 20).toBeLessThan(200);
    });

    it('treats missing target speed as always reached at end of run', () => {
        const open = simulateStraightLine({ accel: 50, maxSpeed: 220 }, { maxTime: 1 });
        expect(open.reached).toBe(true);
        expect(open.time).toBeCloseTo(1, 5);
    });

    it('uses the final step when target is barely missed inside the loop', () => {
        const barelyMiss = simulateStraightLine(
            { accel: 10, maxSpeed: 50 },
            { targetSpeed: 49.9, maxTime: 0.25 },
        );
        expect(barelyMiss.reached).toBe(false);
        expect(barelyMiss.time).toBeCloseTo(0.25, 5);
    });
});
