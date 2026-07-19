import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import {
    CONTACT_EPSILON,
    createSegment,
    getBodyPointVelocity,
    getClosestSegmentPair,
    getSafeContactNormal,
    isStrictlyFasterInward,
    selectDeepestOverlap,
    selectWallContact,
    updateSimulation,
} from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 100, y: 100 }, p2: { x: 110, y: 100 } },
    checkpoints: [],
};

const CHECKPOINT_TRACK = {
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
    checkpoints: [
        { p1: { x: 0, y: -0.1 }, p2: { x: 10, y: -0.1 } },
        { p1: { x: 0, y: -0.3 }, p2: { x: 10, y: -0.3 } },
    ],
};

const VERTICAL_WALL = (x, yMin = -20, yMax = 20) => ({
    start: { x, y: yMin },
    end: { x, y: yMax },
    dx: 0,
    dy: yMax - yMin,
    lenSq: (yMax - yMin) ** 2,
});

function contact(overrides) {
    return {
        inwardSpeed: 0,
        penetration: 0,
        segmentIndex: 0,
        normal: { x: -1, y: 0 },
        ...overrides,
    };
}

describe('simulation survivor kills wave6 — pair distance and normals', () => {
    it('keeps the first candidate when endpoint distances tie within epsilon (L120)', () => {
        const left = createSegment({ x: 0, y: 0 }, { x: 0, y: 4 });
        const right = createSegment({ x: 3, y: 0 }, { x: 3, y: 4 });
        const pair = getClosestSegmentPair(left, right);

        expect(pair.distance).toBeCloseTo(3, 10);
        expect(pair.first.x).toBeCloseTo(0, 10);
        expect(pair.first.y).toBeCloseTo(0, 10);
        expect(pair.second.x).toBeCloseTo(3, 10);
        expect(pair.second.y).toBeCloseTo(0, 10);
    });

    it('uses the segment fallback when distance equals CONTACT_EPSILON exactly (L128)', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const wallPoint = { x: 0, y: 0 };
        const normal = getSafeContactNormal(
            { x: 0, y: 2 },
            segment,
            wallPoint,
            { x: 0, y: 5 },
            CONTACT_EPSILON,
        );

        expect(normal.x).toBeCloseTo(0, 10);
        expect(normal.y).toBeCloseTo(1, 10);
    });

    it('detects endpoint contact when the wall point matches segment.start (L142)', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const wallPoint = { x: 0, y: 0 };
        const normal = getSafeContactNormal(
            wallPoint,
            segment,
            wallPoint,
            { x: 0, y: 4 },
            0,
        );

        expect(normal.x).toBeCloseTo(0, 10);
        expect(normal.y).toBeCloseTo(1, 10);
    });

    it('flips the segment perpendicular when the safe point is on the inward side (L162)', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const wallPoint = { x: 5, y: 0 };
        const normal = getSafeContactNormal(
            { x: 5, y: -2 },
            segment,
            wallPoint,
            { x: 5, y: 1 },
            0,
        );

        expect(normal.x).toBeCloseTo(0, 10);
        expect(normal.y).toBeCloseTo(-1, 10);
    });

    it('getBodyPointVelocity subtracts the rotational cross term on Y (L169-L173)', () => {
        const velocity = { x: 0, y: 0 };
        const offset = { x: 2, y: 0 };
        const angularVelocity = 3;

        expect(getBodyPointVelocity(velocity, angularVelocity, offset)).toEqual({
            x: 0,
            y: angularVelocity * offset.x,
        });
    });
});

describe('simulation survivor kills wave6 — contact selection boundaries', () => {
    it('isStrictlyFasterInward requires inwardSpeed strictly beyond epsilon (L293)', () => {
        const base = contact({ inwardSpeed: 2 });
        const tied = contact({ inwardSpeed: 2 + CONTACT_EPSILON * 0.5 });

        expect(isStrictlyFasterInward(tied, base)).toBe(false);
        expect(isStrictlyFasterInward(
            contact({ inwardSpeed: 2 + CONTACT_EPSILON * 2 }),
            base,
        )).toBe(true);
    });

    it('selectDeepestOverlap ignores equal-depth contacts that are not strictly deeper (L323)', () => {
        const first = contact({ penetration: 1.5, segmentIndex: 0, normal: { x: -1, y: 0 } });
        const barelyDeeper = contact({
            penetration: 1.5 + CONTACT_EPSILON * 0.25,
            segmentIndex: 1,
            normal: { x: 0, y: 1 },
        });

        expect(selectDeepestOverlap([first, barelyDeeper])).toBe(first);
    });

    it('selectDeepestOverlap prefers lower segment index on penetration ties (L325-L326)', () => {
        const higher = contact({ penetration: 2, segmentIndex: 5, normal: { x: -1, y: 0 } });
        const lower = contact({
            penetration: 2 + CONTACT_EPSILON * 0.5,
            segmentIndex: 1,
            normal: { x: 0, y: 1 },
        });

        expect(selectDeepestOverlap([higher, lower])).toBe(lower);
    });

    it('selectWallContact keeps the first contact when inwardSpeed ties within epsilon (L304)', () => {
        const first = contact({ inwardSpeed: 3, penetration: 5, segmentIndex: 0 });
        const tied = contact({
            inwardSpeed: 3 + CONTACT_EPSILON * 0.25,
            penetration: 5,
            segmentIndex: 1,
        });

        expect(selectWallContact([first, tied])).toBe(first);
    });
});

describe('simulation survivor kills wave6 — swept contacts and suppression', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('resolves swept nose hits using normal * (radius + padding) minus axis offset (L382-L385)', () => {
        const wall = VERTICAL_WALL(0);
        const carRadius = 0.35;
        const padding = 0.001;
        const halfLength = 0.4;
        const state = createTestSimState({
            pos: { x: 1.1, y: 0 },
            prevPos: { x: 1.1, y: 0 },
            velocity: { x: -50, y: 0 },
            angle: Math.PI,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });

        updateSimulation(
            state,
            0.04,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                carRadius,
                carCollisionHalfLength: halfLength,
                wallContactPadding: padding,
                wallScrapeReferenceImpactKph: 150,
            },
            OPEN_TRACK,
            [wall],
        );

        expect(state.pos.x).toBeGreaterThan(carRadius + padding - 0.02);
        expect(state.pos.x).toBeLessThan(1);
    });

    it('suppresses inward velocity during repeat wall contact instead of scraping again (L411-L419, L724)', () => {
        const wall = VERTICAL_WALL(1);
        const state = createTestSimState({
            pos: { x: 0.55, y: 0 },
            prevPos: { x: 0.55, y: 0 },
            velocity: { x: 8, y: 0 },
            angle: 0,
            wallContactActive: true,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });
        const beforeX = state.velocity.x;

        const events = updateSimulation(
            state,
            1 / 60,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                carRadius: 0.4,
                carCollisionHalfLength: 0,
            },
            OPEN_TRACK,
            [wall],
        );

        expect(events.wallImpact).toBeNull();
        expect(state.velocity.x).toBeLessThan(beforeX);
        expect(state.velocity.x).toBeLessThanOrEqual(0);
    });

    it('uses center-only sweep offsets when collision half-length is exactly zero (L255)', () => {
        const wall = [{
            start: { x: 5, y: 8 },
            end: { x: 5, y: 12 },
            dx: 0,
            dy: 4,
            lenSq: 16,
        }];
        const zero = createTestSimState({
            pos: { x: 4.7, y: 10 },
            velocity: { x: 10, y: 0 },
            angle: 0,
        });
        const positive = createTestSimState({
            pos: { x: 4.7, y: 10 },
            velocity: { x: 10, y: 0 },
            angle: 0,
        });
        const base = { ...CONFIG, accel: 0, grip: 0, carRadius: 0.275 };

        updateSimulation(zero, 0.05, { ...base, carCollisionHalfLength: 0 }, OPEN_TRACK, wall);
        updateSimulation(positive, 0.05, { ...base, carCollisionHalfLength: 0.3 }, OPEN_TRACK, wall);

        expect(positive.pos.x).not.toBeCloseTo(zero.pos.x, 2);
    });
});

describe('simulation survivor kills wave6 — collision hash and sparks', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('expands hash queries with min/max bounds and cell-size division (L469-L476)', () => {
        const near = VERTICAL_WALL(0.5);
        const far = VERTICAL_WALL(50);
        const collisionData = {
            cellSize: 2,
            cells: new Map([
                ['0,0', [near]],
                ['25,0', [far]],
            ]),
            segments: [near, far],
            candidateSegments: [],
            queryStamp: 0,
        };
        const state = createTestSimState({
            pos: { x: 0.2, y: 0 },
            prevPos: { x: 0.2, y: 0 },
            velocity: { x: 6, y: 0 },
            angle: 0,
            collisionHash: collisionData,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
        });

        updateSimulation(
            state,
            0.05,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                carRadius: 0.4,
                carCollisionHalfLength: 0,
            },
            OPEN_TRACK,
            [],
        );

        expect(collisionData.candidateSegments).toEqual([near]);
        expect(collisionData.candidateSegments).not.toContain(far);
    });

    it('places scrape sparks using spread = 0.5 and (random - 0.5) offsets (L42-L43)', () => {
        const state = createTestSimState({
            pos: { x: 0.5, y: 0 },
            prevPos: { x: 0.5, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });
        const wall = VERTICAL_WALL(1);
        const spread = 0.5;

        vi.spyOn(Math, 'random').mockReturnValue(0);
        updateSimulation(
            state,
            0.05,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                carRadius: 0.4,
                carCollisionHalfLength: 0,
                wallScrapeReferenceImpactKph: 5,
            },
            OPEN_TRACK,
            [wall],
        );

        expect(state.particles.length).toBeGreaterThan(0);
        const dt = 0.05;
        const sparkDrift = Math.cos(0) * (2 + 0 * 5) * dt;
        expect(state.particles[0].x - state.pos.x).toBeCloseTo(-spread * 0.5 + sparkDrift, 10);
        expect(state.particles[0].y - state.pos.y).toBeCloseTo(-spread * 0.5 + Math.sin(0) * 2 * dt, 10);
    });

    it('returns early when wallSegments is an empty array (L344)', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 4, y: 0 },
            angle: 0,
        });
        const before = state.pos.x;

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0 },
            OPEN_TRACK,
            [],
        );

        expect(events.wallImpact).toBeNull();
        expect(state.pos.x).toBeGreaterThan(before);
    });
});

describe('simulation survivor kills wave6 — thrust and grip formulas', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('applies dragFactor = 1 - speedRatio^2 when thrusting below the ceiling (L598-L603)', () => {
        const dt = 1 / 60;
        const accel = 180;
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const speedRatio = 0.5 / safeMax;
        const dragFactor = 1 - speedRatio ** 2;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0.5 },
            angle: Math.PI / 2,
            keys: { left: false, right: false },
        });

        updateSimulation(
            state,
            dt,
            { ...CONFIG, accel, grip: 0, downforceGrip: 0, highSpeedSteerTrim: 0 },
            OPEN_TRACK,
            [],
        );

        expect(state.velocity.y).toBeCloseTo(
            0.5 + (accel / KPH_PER_WORLD_UNIT) * dragFactor * dt,
            8,
        );
    });

    it('blocks thrust when lateral speed consumes the longitudinal budget (L594)', () => {
        const dt = 1 / 60;
        const safeMax = 1;
        const lateral = safeMax * 0.99;
        const forward = 0.2;
        const longitudinalLimit = Math.sqrt(safeMax * safeMax - lateral * lateral);
        const withThrust = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: forward, y: lateral },
            angle: 0,
            keys: { left: false, right: false },
        });
        const withoutThrust = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: forward, y: lateral },
            angle: 0,
            keys: { left: false, right: false },
        });

        updateSimulation(
            withThrust,
            dt,
            {
                ...CONFIG,
                accel: 200,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: safeMax * KPH_PER_WORLD_UNIT,
                highSpeedSteerTrim: 0,
            },
            OPEN_TRACK,
            [],
        );
        updateSimulation(
            withoutThrust,
            dt,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: safeMax * KPH_PER_WORLD_UNIT,
                highSpeedSteerTrim: 0,
            },
            OPEN_TRACK,
            [],
        );

        expect(forward).toBeGreaterThan(longitudinalLimit);
        expect(withThrust.velocity.x).toBeCloseTo(withoutThrust.velocity.x, 8);
    });

    it('applies reverse braking only while forwardSpeed stays negative (L606)', () => {
        const dt = 1 / 60;
        const brakePower = 240;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: -1.5, y: 0 },
            angle: 0,
            keys: { left: false, right: false },
        });

        updateSimulation(
            state,
            dt,
            {
                ...CONFIG,
                accel: 0,
                brakePower,
                grip: 0,
                downforceGrip: 0,
                maxSpeed: 50,
            },
            OPEN_TRACK,
            [],
        );

        expect(state.velocity.x).toBeCloseTo(
            Math.min(0, -1.5 + (brakePower / KPH_PER_WORLD_UNIT) * dt),
            8,
        );
        expect(state.velocity.x).toBeLessThanOrEqual(0);
    });

    it('multiplies grip by downforce * speedRatio^2 when downforce is positive (L617)', () => {
        const dt = 0.05;
        const gripBase = 3;
        const downforce = 0.4;
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const speed = safeMax * 0.8;
        const speedRatio = speed / safeMax;
        const expectedGrip = gripBase + gripBase * downforce * speedRatio * speedRatio;
        const without = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: speed * 0.3, y: speed * 0.7 },
            angle: 0,
        });
        const withDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: speed * 0.3, y: speed * 0.7 },
            angle: 0,
        });

        updateSimulation(
            without,
            dt,
            { ...CONFIG, accel: 0, grip: gripBase, downforceGrip: 0, highSpeedSteerTrim: 0 },
            OPEN_TRACK,
            [],
        );
        updateSimulation(
            withDownforce,
            dt,
            { ...CONFIG, accel: 0, grip: gripBase, downforceGrip: downforce, highSpeedSteerTrim: 0 },
            OPEN_TRACK,
            [],
        );

        const withoutLat = Math.abs(without.velocity.y);
        const withLat = Math.abs(withDownforce.velocity.y);
        const ratioWithout = withoutLat / Math.hypot(without.velocity.x, without.velocity.y);
        const ratioWith = withLat / Math.hypot(withDownforce.velocity.x, withDownforce.velocity.y);

        expect(expectedGrip).toBeGreaterThan(gripBase);
        expect(ratioWith).toBeLessThan(ratioWithout);
    });

    it('does not scale velocity when cachedSpeed equals allowedSpeed exactly (L650)', () => {
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: safeMax },
            angle: Math.PI / 2,
            keys: { left: false, right: false },
        });

        updateSimulation(
            state,
            1 / 60,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0, highSpeedSteerTrim: 0 },
            OPEN_TRACK,
            [],
        );

        expect(state.velocity.y).toBeCloseTo(safeMax, 10);
        expect(state.cachedSpeed).toBeCloseTo(safeMax, 10);
    });

    it('treats tractionSlipRatio as zero when speed is at or below 0.001 (L587)', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0.001, y: 0 },
            angle: 0,
            keys: { left: false, right: true },
            slipSpeedGateClamp: false,
        });

        updateSimulation(
            state,
            0.01,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0, turnRate: 0, highSpeedSteerTrim: 0 },
            OPEN_TRACK,
            [],
        );

        expect(state.slipSpeedGateClamp).toBe(false);
    });
});

describe('simulation survivor kills wave6 — slip gate and steer trim', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('activates slip clamp at slip exactly 0.11 and clears at 0.055 (L639, L641)', () => {
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            downforceGrip: 0,
            turnRate: 0,
            highSpeedSteerTrim: 0,
        };
        const onState = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 9.939, y: 1.1 },
            angle: 0,
            keys: { left: false, right: true },
            slipSpeedGateClamp: false,
        });
        const offState = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 9.985, y: 0.55 },
            angle: 0,
            keys: { left: false, right: true },
            slipSpeedGateClamp: true,
        });

        updateSimulation(onState, 0.01, config, OPEN_TRACK, []);
        updateSimulation(offState, 0.01, config, OPEN_TRACK, []);

        expect(onState.slipSpeedGateClamp).toBe(true);
        expect(offState.slipSpeedGateClamp).toBe(false);
    });

    it('applies steer trim only when highSpeedSteerTrim is strictly positive (L558)', () => {
        const zeroTrim = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true },
        });
        const activeTrim = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: 0,
            keys: { left: false, right: true },
        });
        const base = { ...CONFIG, accel: 0, grip: 0, turnRate: 4 };

        updateSimulation(zeroTrim, 0.1, { ...base, highSpeedSteerTrim: 0 }, OPEN_TRACK, []);
        updateSimulation(activeTrim, 0.1, { ...base, highSpeedSteerTrim: 0.5 }, OPEN_TRACK, []);

        expect(Math.abs(activeTrim.angle)).toBeLessThan(Math.abs(zeroTrim.angle));
    });
});

describe('simulation survivor kills wave6 — skid, trace, and history', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('lays skid marks when sideSlip / speed exceeds 0.28 and speed exceeds 2.5 (L754-L757)', () => {
        const write = vi.fn(() => ({ x: 0, y: 0, cos: 0, sin: 0 }));
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 4, y: 2 },
            angle: Math.PI / 4,
            keys: { left: true, right: false },
            skidMarks: { write },
        });
        const vx = Math.cos(state.angle);
        const vy = Math.sin(state.angle);
        const sideSlip = Math.abs((-vy * state.velocity.x) + (vx * state.velocity.y));
        const speed = Math.hypot(state.velocity.x, state.velocity.y);
        const slipRatio = sideSlip / speed;

        updateSimulation(
            state,
            1 / 60,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0, turnRate: 6 },
            OPEN_TRACK,
            [],
        );

        expect(slipRatio).toBeGreaterThan(0.28);
        expect(speed).toBeGreaterThan(2.5);
        expect(write).toHaveBeenCalled();
    });

    it('records run history when rear-axle movement reaches the 0.001 rounding threshold (L781)', () => {
        const write = vi.fn(() => ({ x: 0, y: 0 }));
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0.02, y: 0 },
            angle: 0,
            runHistoryTimer: 0.049,
            runHistory: {
                length: 0,
                last: () => null,
                write,
            },
        });

        updateSimulation(
            state,
            0.001,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0, carRearAxleOffset: 0 },
            OPEN_TRACK,
            [],
        );

        expect(write).toHaveBeenCalled();
    });

    it('uses the slower route-trace interval when frameSkip is enabled (L767)', () => {
        const write = vi.fn(() => ({ x: 0, y: 0 }));
        const full = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 8, y: 0 },
            angle: 0,
            frameSkip: 0,
            routeTraceStrokeStyle: '#fff',
            trailTimer: 0.049,
            routeTrace: { write },
        });
        const skipped = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 8, y: 0 },
            angle: 0,
            frameSkip: 1,
            routeTraceStrokeStyle: '#fff',
            trailTimer: 0.049,
            routeTrace: { write },
        });

        updateSimulation(
            full,
            0.002,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 },
            OPEN_TRACK,
            [],
        );
        updateSimulation(
            skipped,
            0.002,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 },
            OPEN_TRACK,
            [],
        );

        expect(full.trailTimer).toBeLessThan(0.05);
        expect(skipped.trailTimer).toBeCloseTo(0.051, 3);
    });

    it('does not trigger win when checkpoints remain even after crossing the finish line (L699)', () => {
        const state = createTestSimState({
            currentTime: 3,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0,
            lapCheckpointTimesSec: [],
        });

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 },
            CHECKPOINT_TRACK,
            [],
        );

        expect(events.checkpointPassed).not.toBeNull();
        expect(events.winTriggered).toBe(false);
        expect(state.status).toBe('playing');
    });
});
