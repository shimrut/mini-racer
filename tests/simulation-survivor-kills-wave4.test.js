import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import {
    CONTACT_EPSILON,
    createSegment,
    getSafeContactNormal,
    updateSimulation,
} from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 100, y: 100 }, p2: { x: 110, y: 100 } },
    checkpoints: [],
};

const VERTICAL_WALL = (x, yMin = -20, yMax = 20) => ({
    start: { x, y: yMin },
    end: { x, y: yMax },
    dx: 0,
    dy: yMax - yMin,
    lenSq: (yMax - yMin) ** 2,
});

describe('simulation survivor kills wave4 — contact normals', () => {
    it('flips the contact normal when the safe point is on the wrong side', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 0, y: 10 });
        const wallPoint = { x: 0, y: 5 };
        const bodyPoint = { x: 1, y: 5 };
        const distance = 1;
        // Body is to the right, but safe point is to the left → flip.
        const normal = getSafeContactNormal(
            { x: -1, y: 5 },
            segment,
            wallPoint,
            bodyPoint,
            distance,
        );

        expect(normal.x).toBeCloseTo(-1, 10);
        expect(normal.y).toBeCloseTo(0, 10);
    });

    it('keeps the contact normal when the safe point already matches body side', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 0, y: 10 });
        const normal = getSafeContactNormal(
            { x: 2, y: 5 },
            segment,
            { x: 0, y: 5 },
            { x: 1, y: 5 },
            1,
        );

        expect(normal.x).toBeCloseTo(1, 10);
        expect(normal.y).toBeCloseTo(0, 10);
    });

    it('uses the body vector when the safe point coincides with an endpoint', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const wallPoint = { x: 0, y: 0 };
        const normal = getSafeContactNormal(
            wallPoint,
            segment,
            wallPoint,
            { x: 0, y: 2 },
            0,
        );

        expect(normal.x).toBeCloseTo(0, 10);
        expect(normal.y).toBeCloseTo(1, 10);
    });

    it('falls back to the segment perpendicular for a degenerate zero-length segment', () => {
        const segment = { start: { x: 3, y: 4 }, end: { x: 3, y: 4 }, dx: 0, dy: 0, lenSq: 0 };
        const normal = getSafeContactNormal(
            { x: 3, y: 4 },
            segment,
            { x: 3, y: 4 },
            { x: 3, y: 4 },
            0,
        );

        expect(normal).toEqual({ x: 1, y: 0 });
    });
});

describe('simulation survivor kills wave4 — scrape and collision hash', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('ignores scrape when inwardSpeed is zero or negative', () => {
        const wall = VERTICAL_WALL(1);
        const state = createTestSimState({
            pos: { x: 0.7, y: 0 },
            prevPos: { x: 0.7, y: 0 },
            velocity: { x: 0, y: 8 },
            angle: Math.PI / 2,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
        });

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
                wallContactPadding: 0.001,
            },
            OPEN_TRACK,
            [wall],
        );

        // Sliding parallel / non-penetrating should not emit scrape.
        expect(events.wallImpact).toBeNull();
    });

    it('emits scrape severity using weighted speed and depth contributions', () => {
        const wall = VERTICAL_WALL(1);
        const state = createTestSimState({
            pos: { x: 0.5, y: 0 },
            prevPos: { x: 0.5, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });

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
                wallContactPadding: 0.001,
                wallScrapeReferenceImpactKph: 150,
                wallScrapeSpeedSeverityWeight: 0.8,
                wallScrapeDepthSeverityWeight: 0.2,
                wallImpactCooldownSec: 0.12,
            },
            OPEN_TRACK,
            [wall],
        );

        expect(events.wallImpact).not.toBeNull();
        expect(events.wallImpact.kind).toBe('scrape');
        expect(events.wallImpact.severity).toBeGreaterThan(0);
        expect(events.wallImpact.severity).toBeLessThanOrEqual(1);
        expect(events.wallImpact.impactKph).toBeGreaterThan(0);
        expect(state.wallImpactCooldownRemaining).toBeCloseTo(0.12, 10);
        expect(state.particles.length).toBeGreaterThan(0);
    });

    it('suppresses repeat scrape while wall contact is still active', () => {
        const wall = VERTICAL_WALL(1);
        const state = createTestSimState({
            pos: { x: 0.5, y: 0 },
            prevPos: { x: 0.5, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0,
            wallContactActive: true,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });

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
        expect(state.particles).toHaveLength(0);
    });

    it('queries collision hash cells with extent padding and returns stamped candidates', () => {
        const segment = VERTICAL_WALL(1);
        segment.queryStamp = 0;
        const collisionData = {
            cellSize: 2,
            cells: new Map([['0,0', [segment]]]),
            segments: [segment],
            candidateSegments: [],
            queryStamp: 0,
        };
        const state = createTestSimState({
            pos: { x: 0.5, y: 0 },
            prevPos: { x: 0.5, y: 0 },
            velocity: { x: 10, y: 0 },
            angle: 0,
            collisionHash: collisionData,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
        });

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
            [],
        );

        expect(collisionData.queryStamp).toBeGreaterThan(0);
        expect(events.wallImpact === null || events.wallImpact.kind === 'scrape').toBe(true);
    });

    it('falls back to the full segment list when the hash query finds no cells', () => {
        const segment = VERTICAL_WALL(50);
        const collisionData = {
            cellSize: 2,
            cells: new Map(),
            segments: [segment],
            candidateSegments: [],
            queryStamp: 0,
        };
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            prevPos: { x: 0, y: 0 },
            velocity: { x: 1, y: 0 },
            angle: 0,
            collisionHash: collisionData,
        });

        updateSimulation(
            state,
            1 / 60,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0, carRadius: 0.2 },
            OPEN_TRACK,
            [],
        );

        // No nearby cells → fallback to segments array (still no contact at x=50).
        expect(state.pos.x).toBeGreaterThan(0);
        expect(collisionData.queryStamp).toBeGreaterThan(0);
    });
});

describe('simulation survivor kills wave4 — skid and history gates', () => {
    it('does not lay skid marks below the minimum speed or slip ratio', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 1, y: 0 },
            angle: 0,
            keys: { left: true, right: false },
            skidMarks: {
                length: 0,
                push: vi.fn(),
            },
        });

        updateSimulation(
            state,
            1 / 60,
            {
                ...CONFIG,
                accel: 0,
                maxSpeed: 50,
                grip: 0,
                downforceGrip: 0,
                steerResponse: 0,
            },
            OPEN_TRACK,
            [],
        );

        expect(state.skidMarks.push).not.toHaveBeenCalled();
    });

    it('records run history only when the car moved beyond the rounding epsilon', () => {
        const push = vi.fn();
        const state = createTestSimState({
            pos: { x: 5, y: 5 },
            prevPos: { x: 5, y: 5 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            runHistoryTimer: 0,
            runHistory: {
                length: 1,
                get: () => ({ x: 5, y: 5 }),
                push,
            },
        });

        updateSimulation(
            state,
            1 / 60,
            { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 },
            OPEN_TRACK,
            [],
        );

        // Stationary within 0.001 → no history sample.
        expect(push).not.toHaveBeenCalled();
    });

    it('applies reverse braking only while forwardSpeed is negative', () => {
        const dt = 1 / 60;
        const brakePower = 200;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: -2, y: 0 },
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

        // Braking pulls reverse velocity toward zero (not past into forward boost).
        expect(state.velocity.x).toBeGreaterThan(-2);
        expect(state.velocity.x).toBeLessThanOrEqual(0);
        expect(state.velocity.x).toBeCloseTo(
            Math.min(0, -2 + (brakePower / KPH_PER_WORLD_UNIT) * dt),
            8,
        );
    });

    it('keeps CONTACT_EPSILON as a positive epsilon used by contact selection', () => {
        expect(CONTACT_EPSILON).toBeGreaterThan(0);
        expect(CONTACT_EPSILON).toBeLessThan(0.01);
    });
});
