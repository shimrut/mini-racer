import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { updateSimulation } from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: {
        p1: { x: 100, y: 100 },
        p2: { x: 110, y: 100 }
    },
    checkpoints: []
};

const FINISH_TRACK_WITH_CHECKPOINT = {
    startLine: {
        p1: { x: 0, y: 0 },
        p2: { x: 10, y: 0 }
    },
    checkpoints: [
        {
            p1: { x: 0, y: -0.1 },
            p2: { x: 10, y: -0.1 }
        }
    ]
};

const FINISH_TRACK_WITH_MISSED_CHECKPOINT = {
    startLine: FINISH_TRACK_WITH_CHECKPOINT.startLine,
    checkpoints: [
        {
            p1: { x: 100, y: 100 },
            p2: { x: 110, y: 100 }
        }
    ]
};

const FINISH_TRACK_NO_CHECKPOINT = {
    startLine: FINISH_TRACK_WITH_CHECKPOINT.startLine,
    checkpoints: []
};

const FINISH_TRACK_WITHOUT_CHECKPOINT_FIELD = {
    startLine: FINISH_TRACK_WITH_CHECKPOINT.startLine
};

const ENDPOINT_WALL = [
    {
        start: { x: 0, y: 0 },
        end: { x: 0, y: 4 },
        dx: 0,
        dy: 4,
        lenSq: 16
    }
];

const OFFSET_VERTICAL_WALL = [
    {
        start: { x: 5, y: 10 },
        end: { x: 5, y: 20 },
        dx: 0,
        dy: 10,
        lenSq: 100
    }
];

const OFFSET_HORIZONTAL_WALL = [
    {
        start: { x: 10, y: 5 },
        end: { x: 20, y: 5 },
        dx: 10,
        dy: 0,
        lenSq: 100
    }
];

describe('updateSimulation mechanics', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('holds movement and timer progression while relaunch delay is active', () => {
        const state = createTestSimState({
            relaunchDelayRemaining: 0.2,
            currentTime: 12,
            pos: { x: 3, y: 4 },
            velocity: { x: 10, y: 0 },
            angle: 0
        });

        const events = updateSimulation(state, 0.1, CONFIG, OPEN_TRACK, []);

        expect(events.winTriggered).toBe(false);
        expect(state.relaunchDelayRemaining).toBeCloseTo(0.1);
        expect(state.currentTime).toBe(12);
        expect(state.pos).toEqual({ x: 3, y: 4 });
    });

    it('does not run driving logic while paused', () => {
        const state = createTestSimState({
            status: 'paused',
            currentTime: 12,
            pos: { x: 3, y: 4 },
            velocity: { x: 10, y: 0 },
            angle: 0
        });

        const events = updateSimulation(state, 0.1, CONFIG, OPEN_TRACK, []);

        expect(events.winTriggered).toBe(false);
        expect(events.crashEndedRun).toBe(false);
        expect(events.challengeCrashReset).toBe(false);
        expect(state.currentTime).toBe(12);
        expect(state.pos).toEqual({ x: 3, y: 4 });
    });

    it('applies steering and rotates acceleration with the heading on a clear driving tick', () => {
        const state = createTestSimState({
            angle: 0,
            keys: { left: true, right: false },
            velocity: { x: 0, y: 0 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 10, turnRate: 2 }, OPEN_TRACK, []);

        expect(state.angle).toBeCloseTo(-0.2);
        expect(state.velocity.x).toBeCloseTo(0.049);
        expect(state.velocity.y).toBeCloseTo(-0.01);
        expect(state.cachedSpeed).toBeCloseTo(0.05);
        expect(state.pos.x).toBeCloseTo(0.005);
        expect(state.pos.y).toBeCloseTo(-0.001);
    });

    it('applies right steering and turns the drive vector with the car heading', () => {
        const state = createTestSimState({
            angle: Math.PI / 2,
            keys: { left: false, right: true },
            velocity: { x: 0, y: 0 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 10, turnRate: 2 }, OPEN_TRACK, []);

        expect(state.angle).toBeCloseTo((Math.PI / 2) + 0.2);
        expect(state.velocity.x).toBeCloseTo(-0.01);
        expect(state.velocity.y).toBeCloseTo(0.049);
        expect(state.cachedSpeed).toBeCloseTo(0.05);
        expect(state.pos.x).toBeCloseTo(-0.001);
        expect(state.pos.y).toBeCloseTo(0.005);
    });

    it('keeps drift without adding speed while steering through existing slip', () => {
        const beforeSpeed = 8;
        const steeringState = createTestSimState({
            angle: 0.6,
            keys: { left: false, right: true },
            velocity: { x: beforeSpeed, y: 0 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(steeringState, 1 / 60, CONFIG, OPEN_TRACK, []);

        expect(steeringState.cachedSpeed).toBeLessThanOrEqual(beforeSpeed + 1e-6);
        expect(Math.abs(steeringState.velocity.y)).toBeGreaterThan(0.1);
    });

    it('treats missing collision data as a clear track', () => {
        const state = createTestSimState({
            velocity: { x: 1, y: 0 },
            angle: 0,
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0 }, OPEN_TRACK, null);

        expect(state.status).toBe('playing');
        expect(state.pos.x).toBeCloseTo(0.1);
        expect(state.pos.y).toBeCloseTo(0);
    });

    it('requires checkpoints before finish-line wins and resets checkpoint progress on crossing', () => {
        const missedCheckpointState = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 2,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 50 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const blocked = updateSimulation(missedCheckpointState, 1 / 60, CONFIG, FINISH_TRACK_WITH_MISSED_CHECKPOINT, []);

        expect(blocked.winTriggered).toBe(false);
        expect(missedCheckpointState.status).toBe('playing');
        expect(missedCheckpointState.nextCheckpointIndex).toBe(0);

        const passedCheckpointState = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 2,
            pos: { x: 5, y: -0.18 },
            velocity: { x: 0, y: 50 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const completed = updateSimulation(passedCheckpointState, 1 / 60, CONFIG, FINISH_TRACK_WITH_CHECKPOINT, []);

        expect(completed.winTriggered).toBe(true);
        expect(passedCheckpointState.status).toBe('won');
        expect(passedCheckpointState.nextCheckpointIndex).toBe(0);
    });

    it('allows a finish exactly at the two-second eligibility boundary', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 1.99,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const events = updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0 },
            FINISH_TRACK_NO_CHECKPOINT,
            []
        );

        expect(state.currentTime).toBeCloseTo(2);
        expect(events.winTriggered).toBe(true);
        expect(state.status).toBe('won');
    });

    it('allows no-checkpoint tracks to finish', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 2,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const events = updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0 },
            FINISH_TRACK_NO_CHECKPOINT,
            []
        );

        expect(events.winTriggered).toBe(true);
        expect(state.nextCheckpointIndex).toBe(0);
    });

    it('treats tracks without a checkpoints field as no-checkpoint tracks', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 2,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
        });

        const events = updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0 },
            FINISH_TRACK_WITHOUT_CHECKPOINT_FIELD,
            []
        );

        expect(events.winTriggered).toBe(true);
        expect(state.status).toBe('won');
    });

    it('records skid marks, route trace, and rounded run history only when the car moves meaningfully', () => {
        const state = createTestSimState({
            angle: 0,
            velocity: { x: 0, y: 3 },
            pos: { x: 1.12345, y: 2.98765 },
            trailTimer: 0.049,
            runHistoryTimer: 0.049
        });

        updateSimulation(state, 0.01, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(state.skidMarks.length).toBe(1);
        expect(state.skidMarks.last().x).toBeCloseTo(0.80345);
        expect(state.skidMarks.last().y).toBeCloseTo(3.01765);
        expect(state.skidMarks.last().cos).toBeCloseTo(1);
        expect(state.skidMarks.last().sin).toBeCloseTo(0);
        expect(state.routeTrace.length).toBe(1);
        expect(state.routeTrace.last().x).toBeCloseTo(0.80345);
        expect(state.routeTrace.last().y).toBeCloseTo(3.01765);
        expect(state.runHistory.length).toBe(1);
        expect(state.runHistory.last()).toEqual({
            x: 0.803,
            y: 3.018
        });

        updateSimulation(state, 0.05, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);
        expect(state.runHistory.length).toBe(2);

        state.velocity = { x: 0, y: 0 };
        updateSimulation(state, 0.05, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);
        expect(state.runHistory.length).toBe(2);
    });

    it('detects low-speed radius contact near a wall endpoint as a bounce', () => {
        const state = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(state.pos).toEqual({ x: -0.25, y: -0.25 });
        expect(state.velocity.x).toBeCloseTo(-0.05);
        expect(state.velocity.y).toBeCloseTo(-0.05);
        expect(state.cachedSpeed).toBeCloseTo(Math.sqrt(0.005));
        expect(state.velocity.x).toBeLessThan(0);
        expect(state.velocity.y).toBeLessThan(0);
        expect(state.particles.length).toBe(25);
    });

    it('uses deterministic spark physics for low-speed bounces', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const state = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(state.particles).toHaveLength(25);
        expect(state.particles[0]).toMatchObject({
            color: CONFIG.sparkColor,
            size: 2
        });
        expect(state.particles[0].x).toBeCloseTo(-0.3);
        expect(state.particles[0].y).toBeCloseTo(-0.5);
        expect(state.particles[0].vx).toBeCloseTo(2);
        expect(state.particles[0].vy).toBeCloseTo(0);
        expect(state.particles[0].life).toBeCloseTo(0.1);
        expect(state.particles[0].maxLife).toBeCloseTo(0.2);
    });

    it('uses full spark angle, speed, and life ranges for bounces', () => {
        vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.8)
            .mockReturnValueOnce(0.75);
        const state = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(state.particles[0]).toMatchObject({
            color: CONFIG.sparkColor,
            size: 2
        });
        expect(state.particles[0].x).toBeCloseTo(-0.25);
        expect(state.particles[0].y).toBeCloseTo(0.35);
        expect(state.particles[0].vx).toBeCloseTo(0);
        expect(state.particles[0].vy).toBeCloseTo(6);
        expect(state.particles[0].life).toBeCloseTo(0.25);
        expect(state.particles[0].maxLife).toBeCloseTo(0.35);
    });

    it('detects low-speed radius contact near the middle of offset wall segments', () => {
        const verticalState = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 2, y: 0 },
            angle: 0,
        });

        updateSimulation(
            verticalState,
            0.1,
            { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.3 },
            OPEN_TRACK,
            OFFSET_VERTICAL_WALL
        );

        expect(verticalState.pos).toEqual({ x: 4.6, y: 15 });
        expect(verticalState.velocity.x).toBeCloseTo(-1);

        const horizontalState = createTestSimState({
            pos: { x: 15, y: 4.6 },
            velocity: { x: 0, y: 2 },
            angle: Math.PI / 2,
        });

        updateSimulation(
            horizontalState,
            0.1,
            { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.3 },
            OPEN_TRACK,
            OFFSET_HORIZONTAL_WALL
        );

        expect(horizontalState.pos).toEqual({ x: 15, y: 4.6 });
        expect(horizontalState.velocity.y).toBeCloseTo(-1);
    });

    it('does not bounce when the car is outside the wall radius', () => {
        const state = createTestSimState({
            pos: { x: 4.4, y: 15 },
            velocity: { x: 1, y: 0 },
            angle: 0,
        });

        updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.3 },
            OPEN_TRACK,
            OFFSET_VERTICAL_WALL
        );

        expect(state.pos.x).toBeCloseTo(4.5);
        expect(state.velocity.x).toBeCloseTo(1);
        expect(state.particles).toHaveLength(0);
    });

    it('treats exact crash-speed wall contact as a bounce', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 5, y: 0 },
            angle: 0,
        });

        const events = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.1 }, OPEN_TRACK, [
            {
                start: { x: 0.5, y: -1 },
                end: { x: 0.5, y: 1 },
                dx: 0,
                dy: 2,
                lenSq: 4
            }
        ]);

        expect(events.crashEndedRun).toBe(false);
        expect(events.crashImpact).toBe(null);
        expect(state.status).toBe('playing');
        expect(state.velocity.x).toBeCloseTo(-2.5);
        expect(state.cachedSpeed).toBeCloseTo(2.5);
    });

    it('detects low-speed radius contact near the far endpoint of a wall', () => {
        const state = createTestSimState({
            pos: { x: -0.25, y: 4.25 },
            velocity: { x: 0.1, y: -0.1 },
            angle: -Math.PI / 4,
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(state.pos).toEqual({ x: -0.25, y: 4.25 });
        expect(state.velocity.x).toBeCloseTo(-0.05);
        expect(state.velocity.y).toBeCloseTo(0.05);
    });

    it('uses reduced spark counts when frames are being skipped', () => {
        const bounceState = createTestSimState({
            frameSkip: 1,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
        });

        updateSimulation(bounceState, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5, maxSpeed: 225 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(bounceState.particles).toHaveLength(15);

        const crashState = createTestSimState({
            frameSkip: 1,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 10, y: 10 },
            angle: Math.PI / 4,
        });

        const events = updateSimulation(crashState, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5, maxSpeed: 225 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(events.crashImpact).toBe(225);
        expect(events.crashEndedRun).toBe(true);
        expect(crashState.particles).toHaveLength(30);
    });

    it('resets one-tick crash events on the next simulation update', () => {
        const challengeRun = {
            objectiveType: 'finish_with_crash_budget',
            requiredLaps: 1,
            completedLaps: 0,
            lastLapAt: 0,
            crashCount: 0,
            maxCrashes: 2
        };
        const state = createTestSimState({
            currentChallengeRun: challengeRun,
            currentTime: 2,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 10, y: 10 },
            angle: Math.PI / 4,
        });

        const crashEvents = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);
        expect(crashEvents.challengeCrashReset).toBe(true);

        state.pos = { x: 20, y: 20 };
        state.velocity = { x: 0, y: 0 };
        const clearEvents = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, []);

        expect(clearEvents.challengeCrashReset).toBe(false);
        expect(clearEvents.challengeFailed).toBe(false);
        expect(clearEvents.crashEndedRun).toBe(false);
    });

    it('ends a non-daily regular run on hard crash and clears one-tick crash flags on the next tick', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 2,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 10, y: 10 },
            angle: Math.PI / 4,
        });

        const crashEvents = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);
        expect(crashEvents.crashEndedRun).toBe(true);
        expect(state.status).toBe('crashed');

        state.pos = { x: 20, y: 20 };
        state.velocity = { x: 0, y: 0 };
        const clearEvents = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, crashSpeed: 5, carRadius: 0.5 }, OPEN_TRACK, []);

        expect(clearEvents.crashEndedRun).toBe(false);
        expect(clearEvents.challengeCrashReset).toBe(false);
    });

    it('keeps only the newest live particles up to the frame-skip particle cap', () => {
        const particles = Array.from({ length: 35 }, (_, index) => ({
            id: index,
            x: index,
            y: index,
            vx: 1,
            vy: 2,
            life: index === 10 ? 0.1 : 1
        }));
        const state = createTestSimState({
            status: 'paused',
            frameSkip: 1,
            particles
        });

        updateSimulation(state, 0.1, CONFIG, OPEN_TRACK, []);

        expect(state.particles).toHaveLength(29);
        expect(state.particles[0]).toMatchObject({
            id: 5,
            x: 5.1,
            y: 5.2,
            life: 0.9
        });
        expect(state.particles.some((particle) => particle.id === 10)).toBe(false);
        expect(state.particles.at(-1).id).toBe(34);
    });

    it('keeps the larger particle cap when frames are not being skipped', () => {
        const particles = Array.from({ length: 55 }, (_, index) => ({
            id: index,
            x: index,
            y: index,
            vx: 1,
            vy: 1,
            life: 1
        }));
        const state = createTestSimState({
            status: 'paused',
            frameSkip: 0,
            particles
        });

        updateSimulation(state, 0.1, CONFIG, OPEN_TRACK, []);

        expect(state.particles).toHaveLength(50);
        expect(state.particles[0].id).toBe(5);
        expect(state.particles.at(-1).id).toBe(54);
    });

    it('skips skid marks below the slip and speed thresholds', () => {
        const alignedState = createTestSimState({
            angle: 0,
            velocity: { x: 3, y: 0 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(alignedState, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(alignedState.skidMarks.length).toBe(0);

        const moderateSlipState = createTestSimState({
            angle: 0,
            velocity: { x: 4, y: 1 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(moderateSlipState, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(moderateSlipState.skidMarks.length).toBe(0);

        const slowSidewaysState = createTestSimState({
            angle: 0,
            velocity: { x: 0, y: 2 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(slowSidewaysState, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(slowSidewaysState.skidMarks.length).toBe(0);
    });

    it('uses the longer route-trace interval in reduced quality modes', () => {
        const state = createTestSimState({
            qualityLevel: 1,
            trailTimer: 0.079,
            velocity: { x: 1, y: 0 },
            angle: 0,
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.routeTrace.length).toBe(0);
        expect(state.trailTimer).toBeCloseTo(0.08);

        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.routeTrace.length).toBe(1);
        expect(state.trailTimer).toBeCloseTo(0.001);

        updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.routeTrace.length).toBe(1);
        expect(state.trailTimer).toBeCloseTo(0.051);
    });

    it('uses the longer route-trace interval when frames are being skipped', () => {
        const state = createTestSimState({
            frameSkip: 1,
            trailTimer: 0.06,
            velocity: { x: 1, y: 0 },
            angle: 0,
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(state.routeTrace.length).toBe(0);
        expect(state.trailTimer).toBeCloseTo(0.061);
    });

    it('records run history when either rounded coordinate moves by the minimum step', () => {
        const state = createTestSimState({
            velocity: { x: 0, y: 0 },
            pos: { x: 1, y: 1 },
            runHistoryTimer: 0.049
        });

        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.runHistory.length).toBe(1);

        state.runHistoryTimer = 0.049;
        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.runHistory.length).toBe(1);

        state.pos = { x: 1.002, y: 1 };
        state.runHistoryTimer = 0.05;
        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.runHistory.length).toBe(2);

        state.pos = { x: 1.002, y: 1.002 };
        state.runHistoryTimer = 0.12;
        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.runHistory.length).toBe(3);
        expect(state.runHistoryTimer).toBeCloseTo(0.021);
    });

    it('does not record run history before the sampling interval elapses', () => {
        const state = createTestSimState({
            velocity: { x: 0, y: 0 },
            pos: { x: 1, y: 1 },
            runHistoryTimer: 0.01
        });

        updateSimulation(state, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(state.runHistory.length).toBe(0);
        expect(state.runHistoryTimer).toBeCloseTo(0.02);
    });

    it('compacts live particles and drops expired particles even outside active play', () => {
        const state = createTestSimState({
            status: 'paused',
            particles: [
                { x: 0, y: 0, vx: 2, vy: 4, life: 0.2 },
                { x: 10, y: 10, vx: 1, vy: 1, life: 0.05 }
            ]
        });

        updateSimulation(state, 0.1, CONFIG, OPEN_TRACK, []);

        expect(state.particles).toEqual([
            { x: 0.2, y: 0.4, vx: 2, vy: 4, life: 0.1 }
        ]);
    });
});
