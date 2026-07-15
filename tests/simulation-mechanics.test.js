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
            nextCheckpointIndex: 0,
            lapCheckpointTimesSec: [],
        });

        const completed = updateSimulation(passedCheckpointState, 1 / 60, CONFIG, FINISH_TRACK_WITH_CHECKPOINT, []);

        expect(completed.winTriggered).toBe(true);
        expect(passedCheckpointState.status).toBe('won');
        expect(passedCheckpointState.nextCheckpointIndex).toBe(0);
        expect(passedCheckpointState.lapCheckpointTimesSec).toHaveLength(1);
        expect(passedCheckpointState.lapCheckpointTimesSec[0]).toBeGreaterThan(2);
        expect(passedCheckpointState.lapCheckpointTimesSec[0]).toBeLessThan(2.1);
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

    it('uses a radial normal to resolve a scrape near a wall endpoint', () => {
        const state = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.5 },
            OPEN_TRACK,
            ENDPOINT_WALL
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(events.crashImpact).toBeNull();
        expect(Math.hypot(state.pos.x, state.pos.y)).toBeCloseTo(
            0.5 + CONFIG.carCollisionHalfLength + CONFIG.wallContactPadding
        );
        expect(state.velocity.x).toBeLessThan(0);
        expect(state.velocity.y).toBeLessThan(0);
        expect(state.particles.length).toBe(15);
    });

    it('uses deterministic spark physics for scrapes', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const state = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(state.particles).toHaveLength(15);
        expect(state.particles[0]).toMatchObject({
            color: CONFIG.sparkColor,
            size: 2
        });
        expect(state.particles[0].vx).toBeCloseTo(2);
        expect(state.particles[0].vy).toBeCloseTo(0);
        expect(state.particles[0].life).toBeCloseTo(0.1);
        expect(state.particles[0].maxLife).toBeCloseTo(0.2);
    });

    it('uses full spark angle, speed, and life ranges for scrapes', () => {
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

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(state.particles[0]).toMatchObject({
            color: CONFIG.sparkColor,
            size: 2
        });
        expect(state.particles[0].vx).toBeCloseTo(0);
        expect(state.particles[0].vy).toBeCloseTo(6);
        expect(state.particles[0].life).toBeCloseTo(0.25);
        expect(state.particles[0].maxLife).toBeCloseTo(0.35);
    });

    it('resolves straight-wall contacts to the safe side of the barrier', () => {
        const verticalState = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 2, y: 0 },
            angle: 0,
        });

        updateSimulation(
            verticalState,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.3 },
            OPEN_TRACK,
            OFFSET_VERTICAL_WALL
        );

        expect(verticalState.pos).toEqual({ x: 4.359, y: 15 });
        expect(verticalState.velocity.x).toBeLessThan(0);

        const horizontalState = createTestSimState({
            pos: { x: 15, y: 4.6 },
            velocity: { x: 0, y: 2 },
            angle: Math.PI / 2,
        });

        updateSimulation(
            horizontalState,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.3 },
            OPEN_TRACK,
            OFFSET_HORIZONTAL_WALL
        );

        expect(horizontalState.pos).toEqual({ x: 15, y: 4.359 });
        expect(horizontalState.velocity.y).toBeLessThan(0);
    });

    it('detects a nose impact that the old center circle would miss', () => {
        const state = createTestSimState({
            pos: { x: 4.4, y: 15 },
            velocity: { x: 1, y: 0 },
            angle: 0,
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.3 },
            OPEN_TRACK,
            OFFSET_VERTICAL_WALL
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeCloseTo(4.359);
        expect(state.velocity.x).toBeLessThan(0);
        expect(state.particles).toHaveLength(15);
    });

    it('uses body orientation when deciding whether the car touches a wall', () => {
        const noseFirst = createTestSimState({
            pos: { x: 4.4, y: 15 },
            velocity: { x: 0.5, y: 0 },
            angle: 0,
        });
        const sideOn = createTestSimState({
            pos: { x: 4.4, y: 15 },
            velocity: { x: 0.5, y: 0 },
            angle: Math.PI / 2,
        });
        const config = { ...CONFIG, accel: 0, grip: 0 };

        const noseEvents = updateSimulation(noseFirst, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);
        const noseImpactKind = noseEvents.wallImpact?.kind;
        const sideEvents = updateSimulation(sideOn, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);

        expect(noseImpactKind).toBe('scrape');
        expect(sideEvents.wallImpact).toBeNull();
        expect(sideOn.pos.x).toBeCloseTo(4.405);
    });

    it('uses rotation at the body contact point when measuring impact speed', () => {
        const rotating = createTestSimState({
            pos: { x: 4.73, y: 15 },
            velocity: { x: 0, y: 5 },
            angle: Math.PI / 2,
            angularVelocity: 4,
        });
        const notRotating = createTestSimState({
            pos: { x: 4.73, y: 15 },
            velocity: { x: 0, y: 5 },
            angle: Math.PI / 2,
            angularVelocity: 0,
        });
        const config = { ...CONFIG, accel: 0, grip: 0 };

        const rotatingEvents = updateSimulation(rotating, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);
        const rotatingImpact = rotatingEvents.wallImpact?.impactKph;
        const stillEvents = updateSimulation(notRotating, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);

        expect(rotatingImpact).toBe(20);
        expect(stillEvents.wallImpact).toBeNull();
        expect(rotating.angularVelocity).toBe(0);
    });

    it('continues a high-speed glancing scrape while preserving along-wall momentum', () => {
        const state = createTestSimState({
            pos: { x: 0.2, y: 0 },
            velocity: { x: 3, y: 10 },
            angle: Math.atan2(10, 3),
        });

        const events = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, grip: 0, carRadius: 0.275 }, OPEN_TRACK, [
            {
                start: { x: 0.5, y: -1 },
                end: { x: 0.5, y: 2 },
                dx: 0,
                dy: 3,
                lenSq: 9
            }
        ]);

        expect(events.crashEndedRun).toBe(false);
        expect(events.crashImpact).toBeNull();
        expect(events.wallImpact).toMatchObject({ kind: 'scrape', impactKph: 60 });
        expect(state.status).toBe('playing');
        expect(state.velocity.x).toBeLessThan(0);
        expect(state.velocity.y).toBeGreaterThan(5);
        expect(state.cachedSpeed).toBeLessThan(Math.hypot(3, 10));
    });

    it('treats the exact 150 KPH perpendicular boundary as a maximum-severity scrape', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 7.5, y: 0 },
            angle: 0,
        });

        const events = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, carRadius: 0.1 }, OPEN_TRACK, [
            {
                start: { x: 0.5, y: -1 },
                end: { x: 0.5, y: 1 },
                dx: 0,
                dy: 2,
                lenSq: 4
            }
        ]);

        expect(events.wallImpact).toEqual({ kind: 'scrape', impactKph: 150, severity: 1 });
        expect(events.crashImpact).toBeNull();
        expect(events.crashEndedRun).toBe(false);
        expect(state.status).toBe('playing');
    });

    it('uses the strongest inward contact when two wall segments meet', () => {
        const state = createTestSimState({
            pos: { x: 4.8, y: 4.8 },
            velocity: { x: 2, y: 6 },
            angle: Math.atan2(6, 2),
        });
        const cornerWalls = [
            {
                start: { x: 5, y: 0 },
                end: { x: 5, y: 10 },
                dx: 0,
                dy: 10,
                lenSq: 100,
            },
            {
                start: { x: 0, y: 5 },
                end: { x: 10, y: 5 },
                dx: 10,
                dy: 0,
                lenSq: 100,
            },
        ];

        const events = updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 },
            OPEN_TRACK,
            cornerWalls
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape', impactKph: 120 });
        const bodyReachX = CONFIG.carRadius
            + Math.abs(Math.cos(state.angle)) * CONFIG.carCollisionHalfLength;
        const bodyReachY = CONFIG.carRadius
            + Math.abs(Math.sin(state.angle)) * CONFIG.carCollisionHalfLength;
        expect(state.pos.x + bodyReachX).toBeLessThanOrEqual(5);
        expect(state.pos.y + bodyReachY).toBeLessThanOrEqual(5);
    });

    it('preserves a valid finish when a hard wall impact happens in the same step', () => {
        const wallAndFinish = {
            startLine: {
                p1: { x: 0.5, y: -1 },
                p2: { x: 0.5, y: 1 },
            },
            checkpoints: [],
        };
        const wall = [{
            start: wallAndFinish.startLine.p1,
            end: wallAndFinish.startLine.p2,
            dx: 0,
            dy: 2,
            lenSq: 4,
        }];
        const state = createTestSimState({
            currentTime: 1.99,
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 0 },
            angle: 0,
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.1 },
            wallAndFinish,
            wall
        );

        expect(events.winTriggered).toBe(true);
        expect(events.crashEndedRun).toBe(false);
        expect(events.wallImpact).toBeNull();
        expect(events.crashImpact).toBeNull();
        expect(state.particles).toHaveLength(0);
        expect(state.status).toBe('won');
    });

    it('scales scrape slowdown with penetration depth', () => {
        const shallow = createTestSimState({
            pos: { x: 4.51, y: 15 },
            velocity: { x: 0.1, y: 5 },
            angle: Math.atan2(5, 0.1),
        });
        const deep = createTestSimState({
            pos: { x: 4.8, y: 15 },
            velocity: { x: 0.1, y: 5 },
            angle: Math.atan2(5, 0.1),
        });
        const config = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 };

        const shallowEvents = updateSimulation(shallow, 0.1, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);
        const shallowSeverity = shallowEvents.wallImpact.severity;
        const deepEvents = updateSimulation(deep, 0.1, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);

        expect(deepEvents.wallImpact.kind).toBe('scrape');
        expect(deepEvents.wallImpact.severity).toBeGreaterThan(shallowSeverity);
        expect(deep.cachedSpeed).toBeLessThan(shallow.cachedSpeed);
    });

    it('corrects moving-away overlap without another penalty', () => {
        const state = createTestSimState({
            pos: { x: 4.8, y: 15 },
            velocity: { x: -1, y: 0 },
            angle: Math.PI,
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.5 },
            OPEN_TRACK,
            OFFSET_VERTICAL_WALL
        );

        expect(events.wallImpact).toBeNull();
        expect(state.pos.x).toBeCloseTo(4.159);
        expect(state.velocity.x).toBeCloseTo(-1);
        expect(state.particles).toHaveLength(0);
    });

    it('suppresses repeat scrape penalties and feedback during cooldown', () => {
        const state = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 1, y: 5 },
            angle: Math.atan2(5, 1),
        });
        const config = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 };
        const first = updateSimulation(state, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);
        const firstKind = first.wallImpact?.kind;
        const firstTangentialSpeed = Math.abs(state.velocity.y);
        const particleCount = state.particles.length;
        state.pos = { x: 4.8, y: 15 };
        state.velocity.x = 1;
        const second = updateSimulation(state, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);

        expect(firstKind).toBe('scrape');
        expect(second.wallImpact).toBeNull();
        expect(state.wallImpactCooldownRemaining).toBeGreaterThan(0);
        expect(Math.abs(state.velocity.y)).toBeCloseTo(firstTangentialSpeed);
        expect(state.particles.length).toBeLessThanOrEqual(particleCount);
    });

    it('does not retrigger a scrape while the same wall contact remains active', () => {
        const state = createTestSimState({
            pos: { x: 4.7, y: 15 },
            velocity: { x: 1, y: 5 },
            angle: Math.atan2(5, 1),
        });
        const config = { ...CONFIG, accel: 0, grip: 0 };
        const first = updateSimulation(state, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);
        const firstKind = first.wallImpact?.kind;
        const particleCount = state.particles.length;
        state.wallImpactCooldownRemaining = 0;
        state.pos = { x: 3, y: 15 };
        updateSimulation(state, 0.05, config, OPEN_TRACK, []);
        expect(state.wallContactActive).toBe(true);
        state.pos = { x: 4.8, y: 15 };
        state.velocity.x = 1;

        const continuous = updateSimulation(state, 0.01, config, OPEN_TRACK, OFFSET_VERTICAL_WALL);

        expect(firstKind).toBe('scrape');
        expect(continuous.wallImpact).toBeNull();
        expect(state.wallContactActive).toBe(true);
        expect(state.particles.length).toBeLessThanOrEqual(particleCount);

        state.pos = { x: 3, y: 15 };
        updateSimulation(state, 0.13, config, OPEN_TRACK, []);
        expect(state.wallContactActive).toBe(false);
    });

    it('uses reduced scrape spark counts when frames are being skipped', () => {
        const bounceState = createTestSimState({
            frameSkip: 1,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
        });

        updateSimulation(bounceState, 0.1, { ...CONFIG, accel: 0, carRadius: 0.5, maxSpeed: 225 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(bounceState.particles).toHaveLength(10);

        const severeScrapeState = createTestSimState({
            frameSkip: 1,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 10, y: 10 },
            angle: Math.PI / 4,
        });

        const events = updateSimulation(severeScrapeState, 0.1, { ...CONFIG, accel: 0, carRadius: 0.5, maxSpeed: 225 }, OPEN_TRACK, ENDPOINT_WALL);

        expect(events.wallImpact).toMatchObject({ kind: 'scrape', impactKph: 159 });
        expect(events.wallImpact.severity).toBeGreaterThan(0.8);
        expect(events.crashImpact).toBeNull();
        expect(events.crashEndedRun).toBe(false);
        expect(severeScrapeState.status).toBe('playing');
        expect(severeScrapeState.particles).toHaveLength(10);
    });

    it('keeps a regular run active after an extreme wall impact and clears one-tick scrape flags', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 2,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 10, y: 10 },
            angle: Math.PI / 4,
        });

        const scrapeEvents = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, carRadius: 0.5 }, OPEN_TRACK, ENDPOINT_WALL);
        expect(scrapeEvents.wallImpact).toMatchObject({ kind: 'scrape', severity: 1 });
        expect(scrapeEvents.crashEndedRun).toBe(false);
        expect(state.status).toBe('playing');

        state.pos = { x: 20, y: 20 };
        state.velocity = { x: 0, y: 0 };
        const clearEvents = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, carRadius: 0.5 }, OPEN_TRACK, []);

        expect(clearEvents.wallImpact).toBeNull();
        expect(clearEvents.crashEndedRun).toBe(false);
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
