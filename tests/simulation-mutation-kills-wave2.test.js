import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import {
    CONTACT_EPSILON,
    isStrictlyFasterInward,
    selectWallContact,
    updateSimulation,
} from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
    checkpoints: [],
};

const CHECKPOINT_TRACK = {
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
    checkpoints: [
        { p1: { x: 0, y: -0.1 }, p2: { x: 10, y: -0.1 } },
        { p1: { x: 0, y: -0.3 }, p2: { x: 10, y: -0.3 } },
    ],
};

function contact(overrides) {
    return {
        inwardSpeed: 0,
        penetration: 0,
        segmentIndex: 0,
        normal: { x: -1, y: 0 },
        ...overrides,
    };
}

describe('simulation mutation kills wave2 — contact epsilon ties', () => {
    it('treats inward-speed differences within CONTACT_EPSILON as ties (L292-L294)', () => {
        const base = contact({ inwardSpeed: 2, penetration: 0.5 });
        const barelyFaster = contact({
            inwardSpeed: 2 + CONTACT_EPSILON * 0.5,
            penetration: 0.1,
            segmentIndex: 1,
        });
        const strictlyFaster = contact({
            inwardSpeed: 2 + CONTACT_EPSILON * 2,
            penetration: 0.1,
            segmentIndex: 1,
        });

        expect(isStrictlyFasterInward(barelyFaster, base)).toBe(false);
        expect(isStrictlyFasterInward(strictlyFaster, base)).toBe(true);
        expect(selectWallContact([base, barelyFaster])).toBe(base);
        expect(selectWallContact([base, strictlyFaster])).toBe(strictlyFaster);
    });
});

describe('simulation mutation kills wave2 — steering and slip gates', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('applies high-speed steer trim only when steerTrim is positive and finite (L557-L560)', () => {
        const dt = 1 / 60;
        const trimmed = createTestSimState({
            pos: { x: 5, y: 0 },
            prevPos: { x: 5, y: 0 },
            velocity: { x: 0, y: 40 },
            angle: Math.PI / 2,
            keys: { left: true, right: false },
            angularVelocity: 0,
        });
        const untrimmed = createTestSimState({
            ...trimmed,
            angularVelocity: 0,
        });

        updateSimulation(
            trimmed,
            dt,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: 40,
                turnRate: 4,
                highSpeedSteerTrim: 0.5,
            },
            OPEN_TRACK,
            [],
        );
        updateSimulation(
            untrimmed,
            dt,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: 40,
                turnRate: 4,
                highSpeedSteerTrim: 0,
            },
            OPEN_TRACK,
            [],
        );

        expect(Math.abs(trimmed.angularVelocity)).toBeLessThan(Math.abs(untrimmed.angularVelocity));
    });

    it('activates the slip speed gate once slip reaches 0.11 (L637-L640)', () => {
        const dt = 1 / 60;
        const state = createTestSimState({
            pos: { x: 5, y: 0 },
            prevPos: { x: 5, y: 0 },
            velocity: { x: 8, y: 1.2 },
            angle: 0,
            keys: { left: true, right: false },
            slipSpeedGateClamp: false,
        });
        const currentSpeed = Math.hypot(state.velocity.x, state.velocity.y);
        const slipRatio = Math.abs(state.velocity.y) / currentSpeed;

        expect(slipRatio).toBeGreaterThanOrEqual(0.11);

        updateSimulation(
            state,
            dt,
            {
                ...CONFIG,
                accel: 50,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: 10,
                turnRate: 6,
                steerGripScale: 0.05,
            },
            OPEN_TRACK,
            [],
        );

        expect(state.slipSpeedGateClamp).toBe(true);
        expect(Math.hypot(state.velocity.x, state.velocity.y)).toBeLessThanOrEqual(currentSpeed + 1e-6);
    });

    it('clears the slip speed gate when steering input returns to zero (L647-L648)', () => {
        const state = createTestSimState({
            pos: { x: 5, y: 0 },
            prevPos: { x: 5, y: 0 },
            velocity: { x: 4, y: 0 },
            angle: 0,
            keys: { left: false, right: false },
            slipSpeedGateClamp: true,
        });

        updateSimulation(
            state,
            1 / 60,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: 50,
            },
            OPEN_TRACK,
            [],
        );

        expect(state.slipSpeedGateClamp).toBe(false);
    });

    it('skips forward thrust once currentSpeed reaches safeMaxSpeed (L598)', () => {
        const dt = 1 / 60;
        const safeMaxSpeed = 10 / KPH_PER_WORLD_UNIT;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            prevPos: { x: 0, y: 0 },
            velocity: { x: 0, y: safeMaxSpeed },
            angle: Math.PI / 2,
            keys: { left: false, right: false },
        });
        const forwardBefore = state.velocity.y;

        updateSimulation(
            state,
            dt,
            {
                ...CONFIG,
                accel: 200,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: 10,
            },
            OPEN_TRACK,
            [],
        );

        expect(forwardBefore).toBeCloseTo(safeMaxSpeed, 8);
        expect(state.velocity.y).toBeCloseTo(forwardBefore, 8);
    });
});

describe('simulation mutation kills wave2 — checkpoints and finish gating', () => {
    it('does not finish until all checkpoints are passed and currentTime is at least two seconds (L699-L704)', () => {
        const state = createTestSimState({
            currentTime: 1.5,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0,
            lapCheckpointTimesSec: [],
        });

        updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 },
            CHECKPOINT_TRACK,
            [],
        );

        expect(state.nextCheckpointIndex).toBe(1);
        expect(state.status).toBe('playing');

        state.pos = { x: 5, y: -0.315 };
        state.velocity = { x: 0, y: 1 };
        updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 },
            CHECKPOINT_TRACK,
            [],
        );
        expect(state.nextCheckpointIndex).toBe(2);

        state.currentTime = 2.0;
        state.pos = { x: 5, y: -0.01 };
        state.velocity = { x: 0, y: 8 };
        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 },
            CHECKPOINT_TRACK,
            [],
        );

        expect(state.status).toBe('won');
        expect(events.winTriggered).toBe(true);
        expect(state.nextCheckpointIndex).toBe(0);
    });
});
