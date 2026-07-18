import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import { getCarRearAxleWorldPoint, updateSimulation } from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 100, y: 100 }, p2: { x: 110, y: 100 } },
    checkpoints: []
};

const CHECKPOINT_TRACK = {
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
    checkpoints: [
        { p1: { x: 0, y: -0.1 }, p2: { x: 10, y: -0.1 } },
        { p1: { x: 0, y: -0.3 }, p2: { x: 10, y: -0.3 } }
    ]
};

const VERTICAL_WALL = (x, yMin = -10, yMax = 10) => ({
    start: { x, y: yMin },
    end: { x, y: yMax },
    dx: 0,
    dy: yMax - yMin,
    lenSq: (yMax - yMin) ** 2
});

describe('getCarRearAxleWorldPoint', () => {
    it('offsets rear axle along heading using config.carRearAxleOffset', () => {
        const point = getCarRearAxleWorldPoint({ x: 2, y: 3 }, 0, CONFIG);
        expect(point.x).toBeCloseTo(2 - CONFIG.carRearAxleOffset);
        expect(point.y).toBeCloseTo(3);
    });

    it('rotates the rear offset with car heading', () => {
        const point = getCarRearAxleWorldPoint({ x: 0, y: 0 }, Math.PI / 2, CONFIG);
        expect(point.x).toBeCloseTo(0, 5);
        expect(point.y).toBeCloseTo(-CONFIG.carRearAxleOffset);
    });

    it('uses zero offset when carRearAxleOffset is missing or non-finite', () => {
        expect(getCarRearAxleWorldPoint({ x: 4, y: 5 }, 1.2, {})).toEqual({ x: 4, y: 5 });
        expect(getCarRearAxleWorldPoint({ x: 4, y: 5 }, 1.2, { carRearAxleOffset: NaN })).toEqual({ x: 4, y: 5 });
    });

    it('clamps negative rear offsets to zero', () => {
        const point = getCarRearAxleWorldPoint({ x: 1, y: 1 }, 0, { carRearAxleOffset: -5 });
        expect(point).toEqual({ x: 1, y: 1 });
    });
});

describe('updateSimulation — checkpoints and finish', () => {
    it('emits checkpointPassed and initializes lapCheckpointTimesSec on first crossing', () => {
        const state = createTestSimState({
            currentTime: 1.25,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });
        delete state.lapCheckpointTimesSec;

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);

        expect(events.checkpointPassed).toEqual({
            index: 0,
            splitTimeSec: state.currentTime
        });
        expect(state.lapCheckpointTimesSec).toHaveLength(1);
        expect(state.lapCheckpointTimesSec[0]).toBe(state.currentTime);
        expect(state.nextCheckpointIndex).toBe(1);
        expect(events.winTriggered).toBe(false);
        expect(state.pos.y).toBeLessThan(0);
    });

    it('records sequential checkpoint splits without finishing until all are passed', () => {
        const state = createTestSimState({
            currentTime: 2,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0,
            lapCheckpointTimesSec: []
        });

        const first = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);
        expect(first.checkpointPassed?.index).toBe(0);
        expect(state.nextCheckpointIndex).toBe(1);

        state.pos = { x: 5, y: -0.315 };
        state.velocity = { x: 0, y: 1 };
        const second = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);
        expect(second.checkpointPassed?.index).toBe(1);
        expect(state.nextCheckpointIndex).toBe(2);

        state.pos = { x: 5, y: -0.01 };
        state.velocity = { x: 0, y: 8 };
        const finish = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);
        expect(finish.winTriggered).toBe(true);
        expect(state.nextCheckpointIndex).toBe(0);
    });

    it('resets checkpoint progress on finish crossing even when the lap is not valid', () => {
        const state = createTestSimState({
            currentTime: 2,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 8 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);

        expect(events.winTriggered).toBe(false);
        expect(events.checkpointPassed).toBeNull();
        expect(state.nextCheckpointIndex).toBe(0);
    });

    it('does not trigger a win when crossing finish before the two-second minimum', () => {
        const state = createTestSimState({
            currentTime: 0.5,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 20 },
            angle: Math.PI / 2
        });

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(events.winTriggered).toBe(false);
        expect(state.status).toBe('playing');
    });

    it('skips checkpoint detection once all checkpoints are already passed', () => {
        const state = createTestSimState({
            currentTime: 2,
            pos: { x: 5, y: -0.2 },
            velocity: { x: 0, y: 12 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 2,
            lapCheckpointTimesSec: [1.1, 1.4]
        });

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);

        expect(events.checkpointPassed).toBeNull();
        expect(state.lapCheckpointTimesSec).toHaveLength(2);
    });
});

describe('updateSimulation — collision broadphase branches', () => {
    it('uses a plain array when collision data is passed as an array', () => {
        const wall = VERTICAL_WALL(0.5);
        const state = createTestSimState({
            collisionHash: [wall],
            pos: { x: 0, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.1, wallScrapeReferenceImpactKph: 100 },
            OPEN_TRACK,
            []
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(0.5);
    });

    it('treats hash objects without cells or segments as empty collision data', () => {
        const state = createTestSimState({
            collisionHash: { cells: null, segments: null, queryStamp: 0, candidateSegments: [] },
            pos: { x: 0, y: 0 },
            velocity: { x: 5, y: 0 },
            angle: 0
        });
        const wall = VERTICAL_WALL(0.5);

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0 }, OPEN_TRACK, [wall]);

        expect(state.pos.x).toBeCloseTo(0.5);
        expect(state.particles).toHaveLength(0);
    });

    it('deduplicates segments referenced from multiple hash buckets in one query', () => {
        const sharedWall = VERTICAL_WALL(0.5);
        const collisionHash = {
            cells: new Map([
                ['0,0', [sharedWall]],
                ['1,0', [sharedWall]]
            ]),
            segments: [VERTICAL_WALL(50)],
            cellSize: 1,
            queryStamp: 0,
            candidateSegments: []
        };
        const state = createTestSimState({
            collisionHash,
            pos: { x: 0, y: 0 },
            velocity: { x: 0.5, y: 0 },
            angle: 0
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, carRadius: 0.275 }, OPEN_TRACK, []);

        expect(collisionHash.candidateSegments).toEqual([sharedWall]);
    });
});

describe('updateSimulation — driving physics branches', () => {
    it('tapers forward acceleration as total speed approaches max speed', () => {
        const lowSpeed = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const highSpeed = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 14.5 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const config = { ...CONFIG, grip: 0 };

        updateSimulation(lowSpeed, 0.1, config, OPEN_TRACK, []);
        updateSimulation(highSpeed, 0.1, config, OPEN_TRACK, []);

        expect(lowSpeed.cachedSpeed).toBeGreaterThan(highSpeed.cachedSpeed - 14.5);
    });

    it('does not add forward thrust when accel is zero or already at the speed ceiling', () => {
        const coasting = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 8 },
            angle: 0
        });
        const capped = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: CONFIG.maxSpeed / KPH_PER_WORLD_UNIT },
            angle: 0
        });

        updateSimulation(coasting, 0.1, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);
        updateSimulation(capped, 0.1, { ...CONFIG, grip: 0 }, OPEN_TRACK, []);

        expect(coasting.cachedSpeed).toBeCloseTo(8);
        expect(capped.cachedSpeed).toBeLessThanOrEqual(CONFIG.maxSpeed / KPH_PER_WORLD_UNIT + 1e-6);
    });

    it('applies reverse braking toward zero forward speed', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: -4, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });

        updateSimulation(state, 0.2, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(state.velocity.x).toBeGreaterThan(-4);
        expect(state.velocity.x).toBeLessThanOrEqual(0);
    });

    it('adds downforce grip at speed so lateral slip decays faster than without downforce', () => {
        const withDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 14, y: 8 },
            angle: 0
        });
        const withoutDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 14, y: 8 },
            angle: 0
        });
        const base = { ...CONFIG, accel: 0, grip: 3, downforceGrip: 0 };

        updateSimulation(withDownforce, 0.1, { ...base, downforceGrip: 2 }, OPEN_TRACK, []);
        updateSimulation(withoutDownforce, 0.1, base, OPEN_TRACK, []);

        expect(Math.abs(withDownforce.velocity.y)).toBeLessThan(Math.abs(withoutDownforce.velocity.y));
    });

    it('reduces steering authority at high speed when highSpeedSteerTrim is enabled', () => {
        const lowSpeed = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const highSpeed = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 14 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const config = { ...CONFIG, accel: 0, grip: 0, turnRate: 3, highSpeedSteerTrim: 0.5 };

        updateSimulation(lowSpeed, 0.1, config, OPEN_TRACK, []);
        updateSimulation(highSpeed, 0.1, config, OPEN_TRACK, []);

        expect(Math.abs(highSpeed.angle)).toBeLessThan(Math.abs(lowSpeed.angle));
    });

    it('uses reduced lateral grip while steering via steerGripScale', () => {
        const steering = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const coasting = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const config = { ...CONFIG, accel: 0, grip: 3, steerGripScale: 0.2, downforceGrip: 0 };

        updateSimulation(steering, 0.05, config, OPEN_TRACK, []);
        updateSimulation(coasting, 0.05, config, OPEN_TRACK, []);

        expect(Math.abs(steering.velocity.x)).toBeGreaterThan(Math.abs(coasting.velocity.x));
    });

    it('clamps speed growth while steering through the slip-speed gate hysteresis', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 6, y: 14 },
            angle: 0.8,
            keys: { left: false, right: true },
            slipSpeedGateClamp: false
        });
        const speedBefore = Math.hypot(state.velocity.x, state.velocity.y);
        const config = {
            ...CONFIG,
            accel: 200,
            grip: 0.2,
            highSpeedSteerTrim: 0,
            downforceGrip: 0,
            maxSpeed: 310
        };

        updateSimulation(state, 1 / 60, config, OPEN_TRACK, []);

        expect(state.slipSpeedGateClamp).toBe(true);
        expect(state.cachedSpeed).toBeLessThanOrEqual(speedBefore + 1e-6);
    });

    it('clears slip-speed gate clamp when steering stops', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 10 },
            angle: 0,
            keys: { left: false, right: false },
            slipSpeedGateClamp: true
        });

        updateSimulation(state, 0.05, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(state.slipSpeedGateClamp).toBe(false);
    });

    it('initializes non-finite angular velocity and decays spin when not steering', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            angularVelocity: Number.NaN,
            keys: { left: false, right: false }
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(Number.isFinite(state.angularVelocity)).toBe(true);
        expect(Math.abs(state.angularVelocity)).toBeLessThan(1e-6);
    });

    it('respects custom angularResponse tuning', () => {
        const slowResponse = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            angularVelocity: 0,
            keys: { left: false, right: true }
        });
        const fastResponse = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            angularVelocity: 0,
            keys: { left: false, right: true }
        });
        const base = { ...CONFIG, accel: 0, grip: 0, turnRate: 4 };

        updateSimulation(slowResponse, 0.1, { ...base, angularResponse: 4 }, OPEN_TRACK, []);
        updateSimulation(fastResponse, 0.1, { ...base, angularResponse: 48 }, OPEN_TRACK, []);

        expect(Math.abs(fastResponse.angularVelocity)).toBeGreaterThan(Math.abs(slowResponse.angularVelocity));
    });

    it('decrements wall impact and contact release timers during play', () => {
        const state = createTestSimState({
            wallImpactCooldownRemaining: 0.25,
            wallContactReleaseRemaining: 0.18,
            velocity: { x: 0, y: 0 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(state.wallImpactCooldownRemaining).toBeCloseTo(0.15);
        expect(state.wallContactReleaseRemaining).toBeCloseTo(0.08);
    });
});

describe('updateSimulation — wall contact edge branches', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const SWEEP_WALL = [VERTICAL_WALL(0.5)];

    it('detects swept wall hits when the next center would otherwise clear the barrier', () => {
        const state = createTestSimState({
            pos: { x: 0.22, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0
        });
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            carRadius: 0.275,
            carCollisionHalfLength: 0
        };

        const events = updateSimulation(state, 0.1, config, OPEN_TRACK, SWEEP_WALL);

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(0.5);
        expect(state.pos.x).toBeGreaterThan(0.1);
        expect(state.pos.x).not.toBeCloseTo(1.42, 1);
    });

    it('resolves contacts against degenerate point walls', () => {
        const pointWall = [{
            start: { x: 0.5, y: 0 },
            end: { x: 0.5, y: 0 },
            dx: 0,
            dy: 0,
            lenSq: 0
        }];
        const state = createTestSimState({
            pos: { x: 0.2, y: 0 },
            velocity: { x: 4, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.3, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            pointWall
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeCloseTo(0.2, 1);
        expect(state.velocity.x).toBeLessThan(4);
    });

    it('prefers the deeper penetrating wall when inward speeds tie at a corner', () => {
        const cornerWalls = [
            { ...VERTICAL_WALL(5), lenSq: 400 },
            {
                start: { x: 0, y: 5 },
                end: { x: 10, y: 5 },
                dx: 10,
                dy: 0,
                lenSq: 100
            }
        ];
        const state = createTestSimState({
            pos: { x: 4.74, y: 4.74 },
            velocity: { x: 3, y: 3 },
            angle: Math.PI / 4
        });
        const config = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 };

        const events = updateSimulation(state, 0.01, config, OPEN_TRACK, cornerWalls);

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(5);
        expect(state.pos.y).toBeLessThan(5);
    });

    it('uses custom wall-scrape severity weights from config', () => {
        const verticalWall = [{
            start: { x: 5, y: 10 },
            end: { x: 5, y: 20 },
            dx: 0,
            dy: 10,
            lenSq: 100
        }];
        const shallow = createTestSimState({
            pos: { x: 4.51, y: 15 },
            velocity: { x: 0.1, y: 5 },
            angle: Math.atan2(5, 0.1)
        });
        const deep = createTestSimState({
            pos: { x: 4.8, y: 15 },
            velocity: { x: 0.1, y: 5 },
            angle: Math.atan2(5, 0.1)
        });
        const slowDeep = createTestSimState({
            pos: { x: 4.8, y: 15 },
            velocity: { x: 0.05, y: 0.5 },
            angle: Math.atan2(0.5, 0.05)
        });
        const scrapeConfig = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 };

        const shallowEvents = updateSimulation(shallow, 0.1, scrapeConfig, OPEN_TRACK, verticalWall);
        const shallowSeverity = shallowEvents.wallImpact.severity;
        const deepEvents = updateSimulation(deep, 0.1, scrapeConfig, OPEN_TRACK, verticalWall);
        const speedOnlySlow = updateSimulation(
            slowDeep,
            0.1,
            {
                ...scrapeConfig,
                wallScrapeSpeedSeverityWeight: 1,
                wallScrapeDepthSeverityWeight: 0
            },
            OPEN_TRACK,
            verticalWall
        );
        const speedOnlySeverity = speedOnlySlow.wallImpact.severity;
        const depthOnlySlow = updateSimulation(
            createTestSimState({
                pos: { x: 4.8, y: 15 },
                velocity: { x: 0.05, y: 0.5 },
                angle: Math.atan2(0.5, 0.05)
            }),
            0.1,
            {
                ...scrapeConfig,
                wallScrapeSpeedSeverityWeight: 0,
                wallScrapeDepthSeverityWeight: 1
            },
            OPEN_TRACK,
            verticalWall
        );

        expect(deepEvents.wallImpact.severity).toBeGreaterThan(shallowSeverity);
        expect(depthOnlySlow.wallImpact.severity).toBeGreaterThan(speedOnlySeverity);
        expect(speedOnlySlow.wallImpact.impactKph).toBeLessThan(60);
    });

    it('suppresses inward velocity during active wall contact without issuing another scrape', () => {
        const wall = [VERTICAL_WALL(5, 10, 20)];
        const state = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 2, y: 0 },
            angle: 0,
            wallContactActive: true,
            wallImpactCooldownRemaining: 0.2
        });

        const events = updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 },
            OPEN_TRACK,
            wall
        );

        expect(events.wallImpact).toBeNull();
        expect(state.velocity.x).toBeLessThanOrEqual(0);
        expect(state.particles).toHaveLength(0);
    });

    it('skips scrape resolution when inward speed is not positive', () => {
        const wall = [VERTICAL_WALL(5, 10, 20)];
        const state = createTestSimState({
            pos: { x: 4.55, y: 15 },
            velocity: { x: -2, y: 0 },
            angle: Math.PI,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.5 },
            OPEN_TRACK,
            wall
        );

        expect(events.wallImpact).toBeNull();
        expect(state.pos.x).toBeLessThan(5);
    });

    it('zeros rotational velocity when scrape suppression detects inward spin at the contact point', () => {
        const state = createTestSimState({
            pos: { x: 4.73, y: 15 },
            velocity: { x: 0, y: 0 },
            angle: Math.PI / 2,
            angularVelocity: 6,
            wallContactActive: true,
            wallImpactCooldownRemaining: 0.2
        });
        const wall = [{
            start: { x: 5, y: 10 },
            end: { x: 5, y: 20 },
            dx: 0,
            dy: 10,
            lenSq: 100
        }];

        updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.3 },
            OPEN_TRACK,
            wall
        );

        expect(state.angularVelocity).toBe(0);
    });

    it('selects the lower-index wall segment when penetration and inward speed tie', () => {
        const parallelWalls = [
            {
                start: { x: 5, y: 0 },
                end: { x: 5, y: 10 },
                dx: 0,
                dy: 10,
                lenSq: 100
            },
            {
                start: { x: 5.02, y: 0 },
                end: { x: 5.02, y: 10 },
                dx: 0,
                dy: 10,
                lenSq: 100
            }
        ];
        const state = createTestSimState({
            pos: { x: 4.7, y: 5 },
            velocity: { x: 2, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 },
            OPEN_TRACK,
            parallelWalls
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(5);
    });

    it('handles axis-aligned car movement against a zero-length segment parameterization', () => {
        const degenerateAxis = [{
            start: { x: 1, y: 1 },
            end: { x: 1, y: 1 },
            dx: 0,
            dy: 0,
            lenSq: 0
        }];
        const state = createTestSimState({
            pos: { x: 0.6, y: 1 },
            velocity: { x: 3, y: 0 },
            angle: 0,
            angularVelocity: 0
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, carRadius: 0.35, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            degenerateAxis
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.velocity.x).toBeLessThan(3);
    });

    it('clears wallContactActive after release timer expires without contact', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 1, y: 0 },
            angle: 0,
            wallContactActive: true,
            wallContactReleaseRemaining: 0.01
        });

        updateSimulation(state, 0.02, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(state.wallContactActive).toBe(false);
        expect(state.wallContactReleaseRemaining).toBe(0);
    });

    it('offsets spark particles around the impact point using random spread', () => {
        const lowSpread = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4
        });
        const highSpread = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4
        });
        const wall = [{
            start: { x: 0, y: 0 },
            end: { x: 0, y: 4 },
            dx: 0,
            dy: 4,
            lenSq: 16
        }];
        const config = { ...CONFIG, accel: 0, carRadius: 0.5 };

        vi.spyOn(Math, 'random').mockReturnValue(0);
        updateSimulation(lowSpread, 0.1, config, OPEN_TRACK, wall);
        vi.mocked(Math.random).mockReturnValue(1);
        updateSimulation(highSpread, 0.1, config, OPEN_TRACK, wall);

        expect(lowSpread.particles[0].x).not.toBeCloseTo(highSpread.particles[0].x);
        expect(lowSpread.particles[0].y).not.toBeCloseTo(highSpread.particles[0].y);
    });
});

describe('updateSimulation — visual and history branches', () => {
    it('does not write route trace samples when routeTraceStrokeStyle is null', () => {
        const state = createTestSimState({
            routeTraceStrokeStyle: null,
            trailTimer: 0.1,
            velocity: { x: 4, y: 0 },
            angle: 0,
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.06, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(state.routeTrace.length).toBe(0);
        expect(state.trailTimer).toBeCloseTo(0.1);
    });

    it('writes skid marks only above slip and speed thresholds', () => {
        const barelySlipping = createTestSimState({
            angle: 0,
            velocity: { x: 4, y: 1.1 },
            pos: { x: 0, y: 0 }
        });
        const fastEnough = createTestSimState({
            angle: 0,
            velocity: { x: 4, y: 2.5 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(barelySlipping, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        updateSimulation(fastEnough, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(barelySlipping.skidMarks.length).toBe(0);
        expect(fastEnough.skidMarks.length).toBe(1);
    });

    it('resets checkpointPassed and other transient events each tick', () => {
        const state = createTestSimState({
            currentTime: 1.25,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const first = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);
        expect(first.checkpointPassed).not.toBeNull();

        state.velocity = { x: 0, y: 0 };
        const second = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);
        expect(second.checkpointPassed).toBeNull();
    });
});
