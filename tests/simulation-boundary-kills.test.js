import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import {
    CONTACT_EPSILON,
    isStrictlyFasterInward,
    selectDeepestOverlap,
    selectWallContact,
    updateSimulation
} from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 100, y: 100 }, p2: { x: 110, y: 100 } },
    checkpoints: []
};

function contact(overrides) {
    return {
        inwardSpeed: 0,
        penetration: 0,
        segmentIndex: 0,
        normal: { x: -1, y: 0 },
        ...overrides
    };
}

describe('simulation boundary kills — thrust gate (L578)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not apply negative accel as thrust when the gate is closed', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 4, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const before = state.velocity.x;

        updateSimulation(
            state,
            1 / 60,
            { ...CONFIG, accel: -200, grip: 0, downforceGrip: 0 },
            OPEN_TRACK,
            []
        );

        expect(state.velocity.x).toBeCloseTo(before, 10);
        expect(state.velocity.y).toBeCloseTo(0, 10);
    });

    it('still applies positive thrust when clearly under the speed ceiling', () => {
        const accel = 120;
        const dt = 1 / 60;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });

        updateSimulation(
            state,
            dt,
            { ...CONFIG, accel, grip: 0, downforceGrip: 0 },
            OPEN_TRACK,
            []
        );

        expect(state.velocity.x).toBeCloseTo((accel / KPH_PER_WORLD_UNIT) * dt, 10);
    });
});

describe('simulation boundary kills — contact selection', () => {
    it('prefers higher inwardSpeed beyond CONTACT_EPSILON (L285/L298)', () => {
        const slow = contact({ inwardSpeed: 1, penetration: 9, segmentIndex: 0 });
        const fast = contact({
            inwardSpeed: 1 + CONTACT_EPSILON * 2,
            penetration: 0.1,
            segmentIndex: 1
        });

        expect(isStrictlyFasterInward(fast, slow)).toBe(true);
        expect(isStrictlyFasterInward(slow, fast)).toBe(false);
        expect(isStrictlyFasterInward(slow, {
            ...slow,
            inwardSpeed: slow.inwardSpeed + CONTACT_EPSILON * 0.5
        })).toBe(false);
        expect(selectWallContact([slow, fast])).toBe(fast);
        expect(selectWallContact([fast, slow])).toBe(fast);
    });

    it('treats inwardSpeed within CONTACT_EPSILON as a tie (L300)', () => {
        const first = contact({ inwardSpeed: 2, penetration: 1, segmentIndex: 1 });
        const near = contact({
            inwardSpeed: 2 + CONTACT_EPSILON * 0.5,
            penetration: 3,
            segmentIndex: 0
        });

        expect(selectWallContact([first, near])).toBe(near);
    });

    it('prefers deeper penetration beyond CONTACT_EPSILON when speeds tie (L302)', () => {
        const shallow = contact({ inwardSpeed: 1, penetration: 1, segmentIndex: 0 });
        const deep = contact({
            inwardSpeed: 1,
            penetration: 1 + CONTACT_EPSILON * 2,
            segmentIndex: 1
        });

        expect(selectWallContact([shallow, deep])).toBe(deep);
        expect(selectWallContact([deep, shallow])).toBe(deep);
    });

    it('treats penetration within CONTACT_EPSILON as a tie then uses lower segmentIndex (L304, L305)', () => {
        const higherIndex = contact({
            inwardSpeed: 1,
            penetration: 2 + CONTACT_EPSILON * 0.25,
            segmentIndex: 3
        });
        const lowerIndex = contact({
            inwardSpeed: 1,
            penetration: 2,
            segmentIndex: 1
        });

        expect(selectWallContact([higherIndex, lowerIndex])).toBe(lowerIndex);
        expect(selectWallContact([lowerIndex, higherIndex])).toBe(lowerIndex);
    });

    it('keeps the earlier contact when a later one is not strictly better (L305)', () => {
        const first = contact({ inwardSpeed: 1, penetration: 2, segmentIndex: 2 });
        const laterEqual = contact({ inwardSpeed: 1, penetration: 2, segmentIndex: 2 });
        const laterWorseIndex = contact({ inwardSpeed: 1, penetration: 2, segmentIndex: 5 });

        expect(selectWallContact([first, laterEqual])).toBe(first);
        expect(selectWallContact([first, laterWorseIndex])).toBe(first);
    });

    it('selects deepest overlap with the same epsilon and index rules (L389, L390)', () => {
        const shallow = contact({ penetration: 1, segmentIndex: 0, normal: { x: -1, y: 0 } });
        const deep = contact({
            penetration: 1 + CONTACT_EPSILON * 2,
            segmentIndex: 4,
            normal: { x: 0, y: -1 }
        });
        expect(selectDeepestOverlap([shallow, deep])).toBe(deep);

        const a = contact({ penetration: 2, segmentIndex: 5, normal: { x: -1, y: 0 } });
        const b = contact({
            penetration: 2 + CONTACT_EPSILON * 0.5,
            segmentIndex: 1,
            normal: { x: 0, y: 1 }
        });
        expect(selectDeepestOverlap([a, b])).toBe(b);
        expect(selectDeepestOverlap([b, a])).toBe(b);
    });
});

describe('simulation boundary kills — steer trim and downforce gates', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('ignores non-finite highSpeedSteerTrim even when the value is positive Infinity (L538)', () => {
        const finiteZero = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const infinite = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const base = { ...CONFIG, accel: 0, grip: 0, turnRate: 3 };

        updateSimulation(finiteZero, 0.1, { ...base, highSpeedSteerTrim: 0 }, OPEN_TRACK, []);
        updateSimulation(infinite, 0.1, { ...base, highSpeedSteerTrim: Number.POSITIVE_INFINITY }, OPEN_TRACK, []);

        expect(infinite.angle).toBeCloseTo(finiteZero.angle, 10);
        expect(Number.isFinite(infinite.angle)).toBe(true);
    });

    it('ignores non-finite downforceGrip even when the value is positive Infinity (L596)', () => {
        const none = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 5 },
            angle: 0
        });
        const infinite = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 5 },
            angle: 0
        });
        const base = { ...CONFIG, accel: 0, grip: 2, downforceGrip: 0 };

        updateSimulation(none, 0.05, base, OPEN_TRACK, []);
        updateSimulation(infinite, 0.05, { ...base, downforceGrip: Number.POSITIVE_INFINITY }, OPEN_TRACK, []);

        expect(infinite.velocity.y).toBeCloseTo(none.velocity.y, 10);
        expect(Number.isFinite(infinite.velocity.y)).toBe(true);
    });

    it('treats highSpeedSteerTrim of exactly zero as disabled (L538)', () => {
        const zero = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const tiny = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const base = { ...CONFIG, accel: 0, grip: 0, turnRate: 3 };

        updateSimulation(zero, 0.1, { ...base, highSpeedSteerTrim: 0 }, OPEN_TRACK, []);
        updateSimulation(tiny, 0.1, { ...base, highSpeedSteerTrim: 1e-9 }, OPEN_TRACK, []);

        expect(Math.abs(tiny.angle)).toBeLessThan(Math.abs(zero.angle));
    });
});

describe('simulation boundary kills — swept half-length (L255)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses nose sampling only when collision half-length is strictly above zero', () => {
        const wall = [{
            start: { x: 5, y: 10 },
            end: { x: 5, y: 20 },
            dx: 0,
            dy: 10,
            lenSq: 100
        }];
        const zero = createTestSimState({
            pos: { x: 4.55, y: 15 },
            velocity: { x: 8, y: 0 },
            angle: 0
        });
        const positive = createTestSimState({
            pos: { x: 4.55, y: 15 },
            velocity: { x: 8, y: 0 },
            angle: 0
        });
        const base = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.275 };

        updateSimulation(zero, 0.05, { ...base, carCollisionHalfLength: 0 }, OPEN_TRACK, wall);
        updateSimulation(positive, 0.05, { ...base, carCollisionHalfLength: 0.34 }, OPEN_TRACK, wall);

        expect(positive.pos.x).toBeLessThan(zero.pos.x - 0.2);
        expect(positive.pos.x).toBeCloseTo(4.384, 3);
        expect(zero.pos.x).toBeCloseTo(4.724, 3);
    });
});
