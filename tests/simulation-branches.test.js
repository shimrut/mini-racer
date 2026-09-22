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
            splitTimeSec: 1.265
        });
        expect(state.lapCheckpointTimesSec).toHaveLength(1);
        expect(state.lapCheckpointTimesSec[0]).toBe(1.265);
        expect(state.lapCheckpointTimesSec[0]).toBeLessThan(state.currentTime);
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

describe('updateSimulation — event snapshot and config fallbacks', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('clears every transient event field on the next tick', () => {
        const finishTrack = {
            startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
            checkpoints: []
        };
        const winState = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 2,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 20 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });
        const winEvents = updateSimulation(winState, 0.05, { ...CONFIG, accel: 0 }, finishTrack, []);
        expect(winEvents.winTriggered).toBe(true);
        expect(winEvents.winData).not.toBeNull();

        winState.velocity = { x: 0, y: 0 };
        const idleEvents = updateSimulation(winState, 0.05, { ...CONFIG, accel: 0 }, finishTrack, []);
        expect(idleEvents.winTriggered).toBe(false);
        expect(idleEvents.winData).toBeNull();
        expect(idleEvents.challengeLapCompleted).toBe(false);
        expect(idleEvents.challengeCompletedLapTime).toBeNull();
        expect(idleEvents.challengeProgressLaps).toBe(0);
        expect(idleEvents.wallImpact).toBeNull();
        expect(idleEvents.checkpointPassed).toBeNull();
    });

    it('treats missing grip and brakePower config as zero grip and default braking', () => {
        const noGrip = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 8 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const withGrip = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 8 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const reverse = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: -4, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const reverseDefault = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: -4, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const base = { ...CONFIG, accel: 0, grip: Number.NaN, brakePower: Number.NaN };

        updateSimulation(noGrip, 0.1, base, OPEN_TRACK, []);
        updateSimulation(withGrip, 0.1, { ...CONFIG, accel: 0, grip: 0, brakePower: 20 }, OPEN_TRACK, []);
        updateSimulation(reverse, 0.2, base, OPEN_TRACK, []);
        updateSimulation(reverseDefault, 0.2, { ...CONFIG, accel: 0, grip: 0, brakePower: 20 }, OPEN_TRACK, []);

        expect(noGrip.velocity.y).toBeCloseTo(withGrip.velocity.y);
        expect(reverse.velocity.x).toBeCloseTo(reverseDefault.velocity.x);
    });

    it('ignores invalid highSpeedSteerTrim and downforceGrip values', () => {
        const invalidTrim = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 14 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const noTrim = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 14 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const noDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 14, y: 8 },
            angle: 0
        });
        const withDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 14, y: 8 },
            angle: 0
        });
        const steerConfig = { ...CONFIG, accel: 0, grip: 0, turnRate: 3, highSpeedSteerTrim: Number.NaN };
        const gripConfig = { ...CONFIG, accel: 0, grip: 3, downforceGrip: Number.NaN };

        updateSimulation(invalidTrim, 0.1, steerConfig, OPEN_TRACK, []);
        updateSimulation(noTrim, 0.1, { ...steerConfig, highSpeedSteerTrim: 0 }, OPEN_TRACK, []);
        updateSimulation(noDownforce, 0.1, gripConfig, OPEN_TRACK, []);
        updateSimulation(withDownforce, 0.1, { ...gripConfig, downforceGrip: 0 }, OPEN_TRACK, []);

        expect(Math.abs(invalidTrim.angle)).toBeCloseTo(Math.abs(noTrim.angle));
        expect(Math.abs(noDownforce.velocity.y)).toBeCloseTo(Math.abs(withDownforce.velocity.y));
    });

    it('clamps steerGripScale and uses the default when the value is not finite', () => {
        const defaultScale = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const explicitDefault = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const clampedHigh = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const explicitHigh = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const base = { ...CONFIG, accel: 0, grip: 3, downforceGrip: 0 };

        updateSimulation(defaultScale, 0.05, { ...base, steerGripScale: Number.NaN }, OPEN_TRACK, []);
        updateSimulation(explicitDefault, 0.05, { ...base, steerGripScale: 0.45 }, OPEN_TRACK, []);
        updateSimulation(clampedHigh, 0.05, { ...base, steerGripScale: 5 }, OPEN_TRACK, []);
        updateSimulation(explicitHigh, 0.05, { ...base, steerGripScale: 1.5 }, OPEN_TRACK, []);

        expect(Math.abs(defaultScale.velocity.x)).toBeCloseTo(Math.abs(explicitDefault.velocity.x));
        expect(Math.abs(clampedHigh.velocity.x)).toBeCloseTo(Math.abs(explicitHigh.velocity.x));
    });
});

describe('updateSimulation — acceleration and slip-gate branches', () => {
    it('withholds forward thrust when accel is zero, speed is capped, or lateral slip consumes the budget', () => {
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const lateralY = Math.sqrt(Math.max(0, safeMax * safeMax - 25));
        const noAccel = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 4 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const atMax = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: safeMax },
            angle: 0,
            keys: { left: false, right: false }
        });
        const lateralBudget = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 5, y: lateralY },
            angle: 0,
            keys: { left: false, right: false }
        });
        const thrustAllowed = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const config = { ...CONFIG, grip: 0 };

        const noAccelBefore = noAccel.velocity.y;
        const atMaxBefore = atMax.velocity.y;
        const lateralBefore = lateralBudget.velocity.x;
        updateSimulation(noAccel, 0.05, { ...config, accel: 0 }, OPEN_TRACK, []);
        updateSimulation(atMax, 0.05, config, OPEN_TRACK, []);
        updateSimulation(lateralBudget, 0.05, config, OPEN_TRACK, []);
        updateSimulation(thrustAllowed, 0.05, config, OPEN_TRACK, []);

        expect(noAccel.velocity.y).toBeCloseTo(noAccelBefore);
        expect(atMax.velocity.y).toBeLessThanOrEqual(safeMax + 1e-6);
        expect(atMax.velocity.y).toBeCloseTo(atMaxBefore, 1);
        expect(lateralBudget.velocity.x).toBeCloseTo(lateralBefore, 1);
        expect(thrustAllowed.cachedSpeed).toBeGreaterThan(0);
    });

    it('reports zero slip ratio at near-zero speed and skips skid marks below thresholds', () => {
        const stopped = createTestSimState({
            angle: 0,
            velocity: { x: 0.0005, y: 0 },
            pos: { x: 0, y: 0 }
        });
        const belowSlipThreshold = createTestSimState({
            angle: 0,
            velocity: { x: 4, y: 1 },
            pos: { x: 0, y: 0 }
        });
        const belowSpeedThreshold = createTestSimState({
            angle: 0,
            velocity: { x: 0, y: 2.4 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(stopped, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        updateSimulation(belowSlipThreshold, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        updateSimulation(belowSpeedThreshold, 0.01, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(stopped.skidMarks.length).toBe(0);
        expect(belowSlipThreshold.skidMarks.length).toBe(0);
        expect(belowSpeedThreshold.skidMarks.length).toBe(0);
    });
});

describe('updateSimulation — checkpoint and collision-hash branches', () => {
    it('rebuilds lapCheckpointTimesSec when the prior value is not an array', () => {
        const state = createTestSimState({
            currentTime: 1.25,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0,
            lapCheckpointTimesSec: { bad: true }
        });

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);

        expect(Array.isArray(state.lapCheckpointTimesSec)).toBe(true);
        expect(state.lapCheckpointTimesSec).toHaveLength(1);
        expect(events.checkpointPassed).toEqual({
            index: 0,
            splitTimeSec: 1.265
        });
    });

    it('returns early from wall contact search when segment lists are empty or missing', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 0 },
            angle: 0
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);
        expect(state.pos.x).toBeCloseTo(0.3);

        state.pos = { x: 0, y: 0 };
        updateSimulation(state, 0.1, { ...CONFIG, accel: 0 }, OPEN_TRACK, null);
        expect(state.pos.x).toBeCloseTo(0.3);
    });

    it('queries negative hash cells when the car straddles bucket boundaries', () => {
        const leftBucketWall = VERTICAL_WALL(-0.5);
        const collisionHash = {
            cells: new Map([
                ['-1,0', [leftBucketWall]]
            ]),
            segments: [VERTICAL_WALL(50)],
            cellSize: 1,
            queryStamp: 0,
            candidateSegments: []
        };
        const state = createTestSimState({
            collisionHash,
            pos: { x: 0.1, y: 0 },
            velocity: { x: -2, y: 0 },
            angle: Math.PI
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.275 },
            OPEN_TRACK,
            []
        );

        expect(collisionHash.candidateSegments).toEqual([leftBucketWall]);
        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
    });
});

describe('updateSimulation — wall scrape config and contact resolution', () => {
    const SCRAPE_WALL = [{
        start: { x: 5, y: 10 },
        end: { x: 5, y: 20 },
        dx: 0,
        dy: 10,
        lenSq: 100
    }];

    it('uses scrape severity defaults when config weights and reference speed are invalid', () => {
        const state = createTestSimState({
            pos: { x: 4.8, y: 15 },
            velocity: { x: 0.1, y: 5 },
            angle: Math.atan2(5, 0.1)
        });
        const events = updateSimulation(
            state,
            0.1,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                carRadius: 0.5,
                wallScrapeReferenceImpactKph: 0,
                wallScrapeSpeedSeverityWeight: Number.NaN,
                wallScrapeDepthSeverityWeight: Number.NaN,
                wallScrapeMaxTangentialRetention: Number.NaN,
                wallScrapeMinTangentialRetention: Number.NaN,
                wallScrapeMinBounce: Number.NaN,
                wallScrapeMaxBounce: Number.NaN
            },
            OPEN_TRACK,
            SCRAPE_WALL
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(events.wallImpact.severity).toBeGreaterThan(0);
        expect(events.wallImpact.severity).toBeLessThanOrEqual(1);
        expect(state.wallImpactCooldownRemaining).toBeGreaterThan(0);
    });

    it('applies default wall padding and release timing from config fallbacks', () => {
        const state = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 2, y: 0 },
            angle: 0
        });

        updateSimulation(
            state,
            0.01,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                carRadius: 0.5,
                wallContactPadding: Number.NaN,
                wallContactReleaseSec: Number.NaN,
                wallImpactCooldownSec: Number.NaN
            },
            OPEN_TRACK,
            SCRAPE_WALL
        );

        expect(state.wallContactReleaseRemaining).toBeCloseTo(0.12);
        expect(state.wallContactActive).toBe(true);
    });

    it('detects nose-first swept hits when the center circle would clear the wall', () => {
        const state = createTestSimState({
            pos: { x: 4.55, y: 15 },
            velocity: { x: 8, y: 0 },
            angle: 0
        });
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            carRadius: 0.275,
            carCollisionHalfLength: 0.34
        };

        const events = updateSimulation(state, 0.05, config, OPEN_TRACK, SCRAPE_WALL);

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(5);
        expect(state.pos.x).toBeGreaterThan(4.2);
    });

    it('resolves stacked overlaps by pushing along the deepest penetrating normal', () => {
        const squeezeWalls = [
            {
                start: { x: 5, y: 14 },
                end: { x: 5, y: 16 },
                dx: 0,
                dy: 2,
                lenSq: 4
            },
            {
                start: { x: 4.8, y: 15 },
                end: { x: 6, y: 15 },
                dx: 1.2,
                dy: 0,
                lenSq: 1.44
            }
        ];
        const state = createTestSimState({
            pos: { x: 4.9, y: 15 },
            velocity: { x: 1, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.3, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            squeezeWalls
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(5);
    });

    it('scales velocity down to the configured max speed when it is exceeded', () => {
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: safeMax, y: safeMax },
            angle: 0.8,
            keys: { left: false, right: true }
        });
        const speedBefore = Math.hypot(state.velocity.x, state.velocity.y);

        updateSimulation(state, 1 / 60, {
            ...CONFIG,
            accel: 400,
            grip: 0.2,
            downforceGrip: 0,
            highSpeedSteerTrim: 0
        }, OPEN_TRACK, []);

        expect(speedBefore).toBeGreaterThan(safeMax);
        expect(state.cachedSpeed).toBeLessThanOrEqual(safeMax + 1e-9);
    });

    it('suppresses inward center velocity during active contact even without cooldown', () => {
        const state = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 3, y: 0 },
            angle: 0,
            wallContactActive: true,
            wallImpactCooldownRemaining: 0
        });

        const events = updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 },
            OPEN_TRACK,
            SCRAPE_WALL
        );

        expect(events.wallImpact).toBeNull();
        expect(state.velocity.x).toBeLessThanOrEqual(0);
    });

    it('offsets spark particles independently on both axes', () => {
        const lowX = createTestSimState({
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4
        });
        const highX = createTestSimState({
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

        vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.5);
        updateSimulation(lowX, 0.1, config, OPEN_TRACK, wall);

        vi.mocked(Math.random)
            .mockReturnValueOnce(1)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.5);
        updateSimulation(highX, 0.1, config, OPEN_TRACK, wall);

        expect(lowX.particles[0].x).not.toBeCloseTo(highX.particles[0].x);
        expect(lowX.particles[0].y).toBeCloseTo(highX.particles[0].y);
    });

    it('uses endpoint radial normals for corner scrapes against short segments', () => {
        const cornerSegment = [{
            start: { x: 0, y: 0 },
            end: { x: 0.05, y: 0 },
            dx: 0.05,
            dy: 0,
            lenSq: 0.0025
        }];
        const state = createTestSimState({
            pos: { x: -0.2, y: -0.2 },
            velocity: { x: 0.2, y: 0.2 },
            angle: Math.PI / 4
        });

        const events = updateSimulation(
            state,
            0.1,
            { ...CONFIG, accel: 0, carRadius: 0.5, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            cornerSegment
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.velocity.x).toBeLessThan(0.2);
        expect(state.velocity.y).toBeLessThan(0.2);
    });

    it('uses body-point separation when endpoint contacts have no safe-point offset', () => {
        const endpointWall = [{
            start: { x: 1, y: 1 },
            end: { x: 2, y: 1 },
            dx: 1,
            dy: 0,
            lenSq: 1,
        }];
        const state = createTestSimState({
            pos: { x: 1, y: 1.34 },
            velocity: { x: 0, y: -2 },
            angle: -Math.PI / 2,
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, carRadius: 0.35, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            endpointWall,
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.velocity.y).toBeGreaterThan(-2);
    });
});

describe('updateSimulation — route trace and run-history precision', () => {
    it('samples route trace on the fast interval when quality is high and frames are not skipped', () => {
        const state = createTestSimState({
            qualityLevel: 0,
            frameSkip: 0,
            trailTimer: 0.049,
            velocity: { x: 2, y: 0 },
            angle: 0,
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.002, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(state.routeTrace.length).toBe(1);
        expect(state.trailTimer).toBeCloseTo(0.001);
    });

    it('records run history when only the rounded Y coordinate changes enough', () => {
        const state = createTestSimState({
            angle: 0,
            velocity: { x: 0, y: 0 },
            pos: { x: 1.0004, y: 1 },
            runHistoryTimer: 0.04
        });

        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(state.runHistory.length).toBe(0);

        state.pos = { x: 1.0004, y: 1.002 };
        state.runHistoryTimer = 0.05;
        updateSimulation(state, 0.001, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(state.runHistory.length).toBe(1);
        expect(state.runHistory.last().y).toBe(1.002);
    });
});

describe('updateSimulation — mutation-survivor precision', () => {
    const dt = 1 / 60;
    const noGripConfig = { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('applies the exact standstill forward-acceleration delta (L578, L582, L583)', () => {
        const accel = 120;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });

        updateSimulation(state, dt, { ...noGripConfig, accel }, OPEN_TRACK, []);

        expect(state.velocity.x).toBeCloseTo((accel / KPH_PER_WORLD_UNIT) * dt, 8);
        expect(state.velocity.y).toBeCloseTo(0, 8);
    });

    it('tapers acceleration with the speed-ratio drag factor at half max speed (L582)', () => {
        const accel = 120;
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: safeMax * 0.5 },
            angle: Math.PI / 2,
            keys: { left: false, right: false }
        });
        const forwardBefore = state.velocity.y;

        updateSimulation(state, dt, { ...noGripConfig, accel }, OPEN_TRACK, []);

        const dragFactor = 1 - 0.5 ** 2;
        expect(state.velocity.y - forwardBefore).toBeCloseTo((accel / KPH_PER_WORLD_UNIT) * dragFactor * dt, 8);
    });

    it('withholds thrust once the longitudinal speed budget is exhausted (L574, L578)', () => {
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const lateralY = safeMax * 0.999;
        const longitudinalLimit = Math.sqrt(Math.max(0, safeMax * safeMax - lateralY * lateralY));
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: longitudinalLimit, y: lateralY },
            angle: 0,
            keys: { left: false, right: false }
        });
        const forwardBefore = state.velocity.x;

        updateSimulation(state, dt, { ...noGripConfig, accel: 120 }, OPEN_TRACK, []);

        expect(forwardBefore).toBeLessThan(longitudinalLimit + 1e-6);
        expect(state.velocity.x).toBeCloseTo(forwardBefore, 8);
    });

    it('applies the exact reverse-brake delta toward zero forward speed (L586, L587)', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: -2, y: 0 },
            angle: 0,
            keys: { left: false, right: false }
        });

        updateSimulation(state, 0.1, { ...noGripConfig, accel: 0, brakePower: 20 }, OPEN_TRACK, []);

        expect(state.velocity.x).toBeCloseTo(-2 + (20 / KPH_PER_WORLD_UNIT) * 0.1, 8);
        expect(state.velocity.x).toBeLessThanOrEqual(0);
    });

    it('uses full grip when coasting and steerGripScale while steering (L603)', () => {
        const coasting = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: false }
        });
        const steering = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 8 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const config = { ...noGripConfig, grip: 3, steerGripScale: 0.2, turnRate: 0 };

        updateSimulation(coasting, 0.05, config, OPEN_TRACK, []);
        updateSimulation(steering, 0.05, config, OPEN_TRACK, []);

        expect(Math.abs(steering.velocity.y)).toBeGreaterThan(Math.abs(coasting.velocity.y));
        expect(Math.abs(coasting.velocity.y)).toBeLessThan(8);
        expect(Math.abs(steering.velocity.y)).toBeLessThan(8);
    });

    it('does not rescale velocity while cached speed stays under the max-speed cap', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3, y: 4 },
            angle: 0,
            keys: { left: false, right: true }
        });

        updateSimulation(state, dt, {
            ...noGripConfig,
            turnRate: 0,
            highSpeedSteerTrim: 0
        }, OPEN_TRACK, []);

        expect(state.cachedSpeed).toBeCloseTo(5, 8);
        expect(state.velocity.x).toBeCloseTo(3, 6);
        expect(state.velocity.y).toBeCloseTo(4, 6);
    });

    it('requires skid slip and speed to exceed their strict thresholds (L735, L737)', () => {
        const exactBoundary = createTestSimState({
            angle: 0,
            velocity: { x: 2.4, y: 0.7 },
            pos: { x: 0, y: 0 }
        });
        const aboveBoundary = createTestSimState({
            angle: 0,
            velocity: { x: 2.41, y: 0.72 },
            pos: { x: 0, y: 0 }
        });

        updateSimulation(exactBoundary, 0.001, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);
        updateSimulation(aboveBoundary, 0.001, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(exactBoundary.cachedSpeed).toBeCloseTo(2.5, 8);
        expect(exactBoundary.skidMarks.length).toBe(0);
        expect(aboveBoundary.skidMarks.length).toBe(1);
        expect(aboveBoundary.cachedSpeed).toBeGreaterThan(2.5);
    });

    it('records run history when a rounded rear coordinate moves by exactly 0.001 (L761)', () => {
        const state = createTestSimState({
            velocity: { x: 0, y: 0 },
            pos: { x: 1, y: 1 },
            angle: 0,
            runHistoryTimer: 0.05
        });

        updateSimulation(state, 0.001, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);
        expect(state.runHistory.length).toBe(1);
        expect(state.runHistory.last()).toEqual({ x: 0.68, y: 1 });

        state.pos = { x: 1.001, y: 1 };
        state.runHistoryTimer = 0.05;
        updateSimulation(state, 0.001, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(state.runHistory.length).toBe(2);
        expect(state.runHistory.last()).toEqual({ x: 0.681, y: 1 });
    });

    it('treats wall overlap as contact only when distance is strictly inside the radius (L229)', () => {
        const wall = [{
            start: { x: 5, y: 0 },
            end: { x: 5, y: 10 },
            dx: 0,
            dy: 10,
            lenSq: 100
        }];
        const radius = 0.5;
        const config = { ...CONFIG, accel: 0, grip: 0, carRadius: radius, carCollisionHalfLength: 0 };
        const touching = createTestSimState({
            pos: { x: 4.5, y: 5 },
            velocity: { x: 0, y: 0 },
            angle: 0
        });
        const overlapping = createTestSimState({
            pos: { x: 4.501, y: 5 },
            velocity: { x: 1, y: 0 },
            angle: 0
        });

        const touchEvents = updateSimulation(touching, 0.01, config, OPEN_TRACK, wall);
        const touchImpact = touchEvents.wallImpact;
        const touchPos = { x: touching.pos.x, y: touching.pos.y };
        const overlapEvents = updateSimulation(overlapping, 0.01, config, OPEN_TRACK, wall);

        expect(touchImpact).toBeNull();
        expect(touchPos).toEqual({ x: 4.5, y: 5 });
        expect(overlapEvents.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(overlapping.pos.x).toBeLessThan(4.501);
    });

    it('stops nose-first swept hits earlier when collision half-length is positive (L255)', () => {
        const wall = [{
            start: { x: 5, y: 10 },
            end: { x: 5, y: 20 },
            dx: 0,
            dy: 10,
            lenSq: 100
        }];
        const zeroLength = createTestSimState({
            pos: { x: 4.55, y: 15 },
            velocity: { x: 8, y: 0 },
            angle: 0
        });
        const withLength = createTestSimState({
            pos: { x: 4.55, y: 15 },
            velocity: { x: 8, y: 0 },
            angle: 0
        });
        const base = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.275 };

        const zeroEvents = updateSimulation(zeroLength, 0.05, { ...base, carCollisionHalfLength: 0 }, OPEN_TRACK, wall);
        const lengthEvents = updateSimulation(withLength, 0.05, { ...base, carCollisionHalfLength: 0.34 }, OPEN_TRACK, wall);

        expect(zeroEvents.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(lengthEvents.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(withLength.pos.x).toBeLessThan(zeroLength.pos.x);
        expect(withLength.pos.x).toBeCloseTo(4.384, 3);
        expect(zeroLength.pos.x).toBeCloseTo(4.724, 3);
    });

    it('resolves scrape velocity from configured bounce and tangential retention (L435, L438-L440, L443)', () => {
        const wall = [{
            start: { x: 5, y: 10 },
            end: { x: 5, y: 20 },
            dx: 0,
            dy: 10,
            lenSq: 100
        }];
        const state = createTestSimState({
            pos: { x: 4.8, y: 15 },
            velocity: { x: 0.1, y: 5 },
            angle: Math.atan2(5, 0.1)
        });

        const events = updateSimulation(state, 0.1, {
            ...CONFIG,
            accel: 0,
            grip: 0,
            carRadius: 0.5,
            wallScrapeSpeedSeverityWeight: 0,
            wallScrapeDepthSeverityWeight: 1,
            wallScrapeMinTangentialRetention: 0.5,
            wallScrapeMaxTangentialRetention: 0.5,
            wallScrapeMinBounce: 0.1,
            wallScrapeMaxBounce: 0.1
        }, OPEN_TRACK, wall);

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.velocity.x).toBeCloseTo(-0.01, 6);
        expect(state.velocity.y).toBeCloseTo(2.5, 6);
    });

    it('skips scrape resolution during active wall contact but applies it on a fresh hit (L704, L706)', () => {
        const wall = [{
            start: { x: 5, y: 10 },
            end: { x: 5, y: 20 },
            dx: 0,
            dy: 10,
            lenSq: 100
        }];
        const config = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5 };
        const active = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 3, y: 0 },
            angle: 0,
            wallContactActive: true,
            wallImpactCooldownRemaining: 0,
            wallContactReleaseRemaining: 0.12
        });
        const fresh = createTestSimState({
            pos: { x: 4.6, y: 15 },
            velocity: { x: 3, y: 0 },
            angle: 0,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0
        });

        const activeEvents = updateSimulation(active, 0.01, config, OPEN_TRACK, wall);
        const activeImpact = activeEvents.wallImpact;
        const freshEvents = updateSimulation(fresh, 0.01, config, OPEN_TRACK, wall);

        expect(activeImpact).toBeNull();
        expect(active.wallContactActive).toBe(true);
        expect(active.velocity.x).toBeLessThanOrEqual(0);
        expect(freshEvents.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(fresh.velocity.x).toBeLessThan(3);
    });

    it('adds downforce grip only for positive finite downforce values (L596)', () => {
        const zeroDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 5 },
            angle: 0
        });
        const withDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 5 },
            angle: 0
        });
        const base = { ...CONFIG, accel: 0, grip: 2, downforceGrip: 0 };

        updateSimulation(zeroDownforce, 0.05, base, OPEN_TRACK, []);
        updateSimulation(withDownforce, 0.05, { ...base, downforceGrip: 1 }, OPEN_TRACK, []);

        expect(Math.abs(withDownforce.velocity.y)).toBeLessThan(Math.abs(zeroDownforce.velocity.y));
        expect(Math.abs(zeroDownforce.velocity.y)).toBeCloseTo(4.524187090179797, 6);
        expect(Math.abs(withDownforce.velocity.y)).toBeCloseTo(4.294816266757254, 6);
    });

    it('applies high-speed steer trim only when the trim value is positive and finite (L538)', () => {
        const noTrim = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const withTrim = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true }
        });
        const base = { ...CONFIG, accel: 0, grip: 0, turnRate: 3 };

        updateSimulation(noTrim, 0.1, { ...base, highSpeedSteerTrim: 0 }, OPEN_TRACK, []);
        updateSimulation(withTrim, 0.1, { ...base, highSpeedSteerTrim: 0.5 }, OPEN_TRACK, []);

        expect(noTrim.angle).toBeCloseTo(0.3, 6);
        expect(withTrim.angle).toBeCloseTo(0.21009365244536937, 6);
        expect(Math.abs(withTrim.angle)).toBeLessThan(Math.abs(noTrim.angle));
    });

    it('prefers the lower-index wall when inward speed and penetration tie (L302, L304, L305)', () => {
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
        expect(state.pos.x).toBeCloseTo(4.159, 3);
    });

    it('resets every transient event field returned from the module singleton (L8-L19)', () => {
        const finishTrack = {
            startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
            checkpoints: []
        };
        const winState = createTestSimState({
            currentTime: 2,
            pos: { x: 5, y: -0.01 },
            velocity: { x: 0, y: 20 },
            angle: Math.PI / 2
        });
        const winEvents = updateSimulation(winState, 0.05, { ...CONFIG, accel: 0 }, finishTrack, []);
        const winTriggered = winEvents.winTriggered;
        const winData = winEvents.winData;

        winState.velocity = { x: 0, y: 0 };
        const idleEvents = updateSimulation(winState, 0.05, { ...CONFIG, accel: 0 }, finishTrack, []);

        expect(winTriggered).toBe(true);
        expect(winData).not.toBeNull();
        expect(idleEvents.winTriggered).toBe(false);
        expect(idleEvents.winData).toBeNull();
        expect(idleEvents.challengeLapCompleted).toBe(false);
        expect(idleEvents.challengeCompletedLapTime).toBeNull();
        expect(idleEvents.challengeProgressLaps).toBe(0);
        expect(idleEvents.wallImpact).toBeNull();
        expect(idleEvents.checkpointPassed).toBeNull();
    });
});

describe('updateSimulation — collision-hash and lifecycle precision', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('falls back to hash segments when no bucket overlaps the query region (L458-L486)', () => {
        const fallbackWall = VERTICAL_WALL(50);
        const collisionHash = {
            cells: new Map([['99,99', [VERTICAL_WALL(99)]]]),
            segments: [fallbackWall],
            cellSize: 1,
            queryStamp: 0,
            candidateSegments: []
        };
        const state = createTestSimState({
            collisionHash,
            pos: { x: 49.7, y: 0 },
            velocity: { x: 4, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, carRadius: 0.5, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            []
        );

        expect(collisionHash.candidateSegments).toEqual([]);
        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(50);
    });

    it('returns an empty candidate list for null collision data (L325, L456-L457)', () => {
        const state = createTestSimState({
            collisionHash: null,
            pos: { x: 0, y: 0 },
            velocity: { x: 2, y: 0 },
            angle: 0
        });

        const events = updateSimulation(state, 0.1, { ...CONFIG, accel: 0 }, OPEN_TRACK, null);

        expect(events.wallImpact).toBeNull();
        expect(state.pos.x).toBeCloseTo(0.2);
    });

    it('skips scrape feedback when a valid finish and wall contact occur in the same tick (L700-L706)', () => {
        const finishTrack = {
            startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
            checkpoints: []
        };
        const sideWall = [VERTICAL_WALL(5, -2, 2)];
        const state = createTestSimState({
            currentTime: 2.5,
            pos: { x: 4.6, y: -0.2 },
            velocity: { x: 0, y: 12 },
            angle: Math.PI / 2
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.5, carCollisionHalfLength: 0 },
            finishTrack,
            sideWall
        );

        expect(events.winTriggered).toBe(true);
        expect(events.wallImpact).toBeNull();
        expect(state.status).toBe('won');
        expect(state.particles).toHaveLength(0);
    });

    it('does not advance race time while relaunch delay is active (L524-L527)', () => {
        const state = createTestSimState({
            currentTime: 1.5,
            relaunchDelayRemaining: 0.2,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const events = updateSimulation(state, 0.1, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);

        expect(state.currentTime).toBeCloseTo(1.5);
        expect(state.relaunchDelayRemaining).toBeCloseTo(0.1);
        expect(events.checkpointPassed).toBeNull();
        expect(events.winTriggered).toBe(false);
    });

    it('uses the slower route-trace interval when frameSkip is enabled (L747)', () => {
        const state = createTestSimState({
            frameSkip: 1,
            trailTimer: 0.079,
            velocity: { x: 2, y: 0 },
            angle: 0,
            pos: { x: 0, y: 0 }
        });

        updateSimulation(state, 0.002, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);

        expect(state.routeTrace.length).toBe(1);
        expect(state.trailTimer).toBeCloseTo(0.001);
    });

    it('caps retained spark particles at thirty when frameSkip is enabled (L713, L771)', () => {
        const state = createTestSimState({
            frameSkip: 1,
            pos: { x: -0.25, y: -0.25 },
            velocity: { x: 0.1, y: 0.1 },
            angle: Math.PI / 4,
            particles: Array.from({ length: 40 }, (_, index) => ({
                x: index,
                y: index,
                vx: 0,
                vy: 0,
                life: 0.5,
                maxLife: 0.5,
                color: '#fff',
                size: 2
            }))
        });
        const wall = [{
            start: { x: 0, y: 0 },
            end: { x: 0, y: 4 },
            dx: 0,
            dy: 4,
            lenSq: 16
        }];

        updateSimulation(state, 0.01, { ...CONFIG, accel: 0, carRadius: 0.5 }, OPEN_TRACK, wall);

        expect(state.particles.length).toBeLessThanOrEqual(30);
    });

    it('creates scrape sparks with deterministic spread offsets from Math.random (L42-L43)', () => {
        const state = createTestSimState({
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

        vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0);
        updateSimulation(state, 0.1, config, OPEN_TRACK, wall);

        expect(state.particles).toHaveLength(15);
        expect(state.particles[0].life).toBeGreaterThan(0);
        expect(state.particles[0].maxLife).toBeGreaterThanOrEqual(state.particles[0].life);
        expect(Number.isFinite(state.particles[0].vx)).toBe(true);
        expect(Number.isFinite(state.particles[0].vy)).toBe(true);
    });

    it('drops expired particles while keeping live ones (L775-L784)', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            particles: [
                { x: 0, y: 0, vx: 0, vy: 0, life: 0.01, maxLife: 0.2, color: '#fff', size: 2 },
                { x: 1, y: 1, vx: 0, vy: 0, life: 0.5, maxLife: 0.5, color: '#fff', size: 2 }
            ]
        });

        updateSimulation(state, 0.02, { ...CONFIG, accel: 0 }, OPEN_TRACK, []);

        expect(state.particles).toHaveLength(1);
        expect(state.particles[0].life).toBeCloseTo(0.48);
    });

    it('resolves stacked overlaps across multiple contact passes (L370-L396)', () => {
        const squeezeWalls = [
            {
                start: { x: 4.9, y: 4.5 },
                end: { x: 4.9, y: 5.5 },
                dx: 0,
                dy: 1,
                lenSq: 1
            },
            {
                start: { x: 4.5, y: 5.0 },
                end: { x: 5.5, y: 5.0 },
                dx: 1,
                dy: 0,
                lenSq: 1
            }
        ];
        const state = createTestSimState({
            pos: { x: 4.88, y: 4.98 },
            velocity: { x: 0.5, y: 0.5 },
            angle: Math.PI / 4
        });

        const events = updateSimulation(
            state,
            0.02,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.2, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            squeezeWalls
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(4.9);
        expect(state.pos.y).toBeLessThan(5.0);
    });

    it('queries hash buckets using the configured cell size (L464-L467)', () => {
        const bucketWall = VERTICAL_WALL(0.5);
        const collisionHash = {
            cells: new Map([['0,0', [bucketWall]]]),
            segments: [VERTICAL_WALL(50)],
            cellSize: 2,
            queryStamp: 0,
            candidateSegments: []
        };
        const state = createTestSimState({
            collisionHash,
            pos: { x: 0.2, y: 0 },
            velocity: { x: 4, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, carRadius: 0.5, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            []
        );

        expect(collisionHash.candidateSegments).toEqual([bucketWall]);
        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.pos.x).toBeLessThan(0.5);
    });

    it('uses the axis-aligned fallback normal for zero-length wall segments (L158-L166)', () => {
        const pointWall = [{
            start: { x: 2, y: 2 },
            end: { x: 2, y: 2 },
            dx: 0,
            dy: 0,
            lenSq: 0
        }];
        const state = createTestSimState({
            pos: { x: 1.6, y: 2 },
            velocity: { x: 3, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, carRadius: 0.35, carCollisionHalfLength: 0 },
            OPEN_TRACK,
            pointWall
        );

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(state.velocity.x).toBeLessThan(3);
        expect(state.pos.x).toBeLessThan(2);
    });

    it('snapshots every transient event field before the next idle tick (L8-L19, L512)', () => {
        const state = createTestSimState({
            currentTime: 1.25,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const active = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);
        const activeSnapshot = {
            winTriggered: active.winTriggered,
            winData: active.winData,
            challengeLapCompleted: active.challengeLapCompleted,
            challengeCompletedLapTime: active.challengeCompletedLapTime,
            challengeElapsedTime: active.challengeElapsedTime,
            challengeProgressLaps: active.challengeProgressLaps,
            challengeRequiredLaps: active.challengeRequiredLaps,
            challengeIsFinalLap: active.challengeIsFinalLap,
            wallImpact: active.wallImpact,
            checkpointPassed: active.checkpointPassed
        };

        state.velocity = { x: 0, y: 0 };
        const idle = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);

        expect(activeSnapshot.checkpointPassed).toEqual({
            index: 0,
            splitTimeSec: 1.265
        });
        expect(idle).toEqual({
            winTriggered: false,
            winData: null,
            challengeLapCompleted: false,
            challengeCompletedLapTime: null,
            challengeElapsedTime: null,
            challengeProgressLaps: 0,
            challengeRequiredLaps: 0,
            challengeIsFinalLap: false,
            wallImpact: null,
            checkpointPassed: null
        });
    });
});
