import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import {
    CONTACT_EPSILON,
    createSegment,
    getBodyPointVelocity,
    getClosestSegmentPair,
    getSafeContactNormal,
    selectDeepestOverlap,
    selectWallContact,
    updateSimulation,
} from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 100, y: 100 }, p2: { x: 110, y: 100 } },
    checkpoints: [],
};

const WALL_AT = (x) => ({
    start: { x, y: -10 },
    end: { x, y: 10 },
    dx: 0,
    dy: 20,
    lenSq: 400,
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

describe('simulation survivor kills wave3 — pure helpers', () => {
    it('createSegment stores dx, dy, and lenSq from endpoints (L83-L86)', () => {
        const segment = createSegment({ x: 1, y: 2 }, { x: 4, y: 6 });

        expect(segment).toEqual({
            start: { x: 1, y: 2 },
            end: { x: 4, y: 6 },
            dx: 3,
            dy: 4,
            lenSq: 25,
        });
    });

    it('getBodyPointVelocity applies the rotational offset formula (L169-L173)', () => {
        const velocity = { x: 3, y: 4 };
        const bodyOffset = { x: 1, y: 2 };
        const angularVelocity = 0.5;

        expect(getBodyPointVelocity(velocity, angularVelocity, bodyOffset)).toEqual({
            x: 3 - angularVelocity * bodyOffset.y,
            y: 4 + angularVelocity * bodyOffset.x,
        });
    });

    it('getClosestSegmentPair returns distance zero for intersecting segments (L98-L101)', () => {
        const horizontal = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const vertical = createSegment({ x: 5, y: -5 }, { x: 5, y: 5 });

        const pair = getClosestSegmentPair(horizontal, vertical);

        expect(pair.distance).toBeCloseTo(0, 10);
        expect(pair.first).toEqual(pair.second);
    });

    it('getClosestSegmentPair picks the closest endpoint pair when segments do not intersect (L114-L124)', () => {
        const left = createSegment({ x: 0, y: 0 }, { x: 0, y: 10 });
        const right = createSegment({ x: 5, y: 0 }, { x: 5, y: 10 });

        const pair = getClosestSegmentPair(left, right);

        expect(pair.distance).toBeCloseTo(5, 10);
        expect(pair.first.x).toBeCloseTo(0, 10);
        expect(pair.second.x).toBeCloseTo(5, 10);
    });

    it('getSafeContactNormal uses the body-wall vector when distance exceeds epsilon (L128-L136)', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const wallPoint = { x: 5, y: 0 };
        const bodyPoint = { x: 5, y: 3 };
        const safePoint = { x: 5, y: 2 };

        const normal = getSafeContactNormal(safePoint, segment, wallPoint, bodyPoint, 3);

        expect(normal.x).toBeCloseTo(0, 10);
        expect(normal.y).toBeCloseTo(1, 10);
    });

    it('getSafeContactNormal flips the body-wall vector when the safe point is on the wrong side (L131-L134)', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const wallPoint = { x: 5, y: 0 };
        const bodyPoint = { x: 5, y: 3 };
        const safePoint = { x: 5, y: -1 };

        const normal = getSafeContactNormal(safePoint, segment, wallPoint, bodyPoint, 3);

        expect(normal.x).toBeCloseTo(0, 10);
        expect(normal.y).toBeCloseTo(-1, 10);
    });

    it('getSafeContactNormal falls back to the segment perpendicular when distance is zero (L158-L166)', () => {
        const segment = createSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
        const wallPoint = { x: 0, y: 0 };
        const bodyPoint = { x: 0, y: 1 };
        const safePoint = { x: 0, y: 2 };

        const normal = getSafeContactNormal(safePoint, segment, wallPoint, bodyPoint, 0);

        expect(normal.x).toBeCloseTo(0, 10);
        expect(normal.y).toBeCloseTo(1, 10);
    });

    it('getSafeContactNormal returns a unit X axis for degenerate zero-length segments (L158)', () => {
        const segment = createSegment({ x: 2, y: 3 }, { x: 2, y: 3 });

        const normal = getSafeContactNormal(
            { x: 3, y: 3 },
            segment,
            { x: 2, y: 3 },
            { x: 2, y: 4 },
            0,
        );

        expect(normal).toEqual({ x: 1, y: 0 });
    });
});

describe('simulation survivor kills wave3 — contact tie-break precision', () => {
    it('selectWallContact requires strictly greater penetration beyond epsilon (L302)', () => {
        const shallow = contact({ inwardSpeed: 1, penetration: 2, segmentIndex: 0 });
        const barelyDeeper = contact({
            inwardSpeed: 1,
            penetration: 2 + CONTACT_EPSILON * 0.5,
            segmentIndex: 1,
        });

        expect(selectWallContact([shallow, barelyDeeper])).toBe(shallow);
    });

    it('selectWallContact keeps the lower segment index when penetration ties within epsilon (L304-L305)', () => {
        const higherIndex = contact({
            inwardSpeed: 1,
            penetration: 2,
            segmentIndex: 4,
        });
        const lowerIndex = contact({
            inwardSpeed: 1,
            penetration: 2 + CONTACT_EPSILON * 0.25,
            segmentIndex: 1,
        });

        expect(selectWallContact([higherIndex, lowerIndex])).toBe(lowerIndex);
    });

    it('selectDeepestOverlap prefers lower segment index on penetration ties (L389-L390)', () => {
        const higherIndex = contact({ penetration: 3, segmentIndex: 9, normal: { x: -1, y: 0 } });
        const lowerIndex = contact({
            penetration: 3 + CONTACT_EPSILON * 0.25,
            segmentIndex: 2,
            normal: { x: 0, y: 1 },
        });

        expect(selectDeepestOverlap([higherIndex, lowerIndex])).toBe(lowerIndex);
    });
});

describe('simulation survivor kills wave3 — thrust and grip gates', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('withholds thrust when total speed is exactly at the configured ceiling (L578)', () => {
        const dt = 1 / 60;
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: safeMax },
            angle: Math.PI / 2,
            keys: { left: false, right: false },
        });
        const before = state.velocity.y;

        updateSimulation(
            state,
            dt,
            { ...CONFIG, accel: 200, grip: 0, downforceGrip: 0, highSpeedSteerTrim: 0 },
            OPEN_TRACK,
            [],
        );

        expect(state.velocity.y).toBeCloseTo(before, 10);
    });

    it('withholds thrust when forward speed equals the longitudinal budget (L578)', () => {
        const dt = 1 / 60;
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const lateralY = safeMax * 0.6;
        const longitudinalLimit = Math.sqrt(safeMax * safeMax - lateralY * lateralY);
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: longitudinalLimit, y: lateralY },
            angle: 0,
            keys: { left: false, right: false },
        });
        const beforeX = state.velocity.x;

        updateSimulation(
            state,
            dt,
            { ...CONFIG, accel: 200, grip: 0, downforceGrip: 0, highSpeedSteerTrim: 0 },
            OPEN_TRACK,
            [],
        );

        expect(beforeX).toBeCloseTo(longitudinalLimit, 8);
        expect(state.velocity.x).toBeCloseTo(beforeX, 8);
    });

    it('applies stronger lateral damping when downforceGrip is positive at speed (L612-L615)', () => {
        const dt = 0.05;
        const gripBase = 2;
        const downforce = 0.5;
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const speed = safeMax * 0.7;
        const without = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: speed * 0.4, y: speed * 0.6 },
            angle: 0,
        });
        const withDownforce = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: speed * 0.4, y: speed * 0.6 },
            angle: 0,
        });
        const baseConfig = {
            ...CONFIG,
            accel: 0,
            grip: gripBase,
            downforceGrip: 0,
            highSpeedSteerTrim: 0,
        };

        updateSimulation(without, dt, baseConfig, OPEN_TRACK, []);
        updateSimulation(withDownforce, dt, { ...baseConfig, downforceGrip: downforce }, OPEN_TRACK, []);

        const withoutLateral = Math.abs(without.velocity.y);
        const withLateral = Math.abs(withDownforce.velocity.y);
        expect(withLateral).toBeLessThan(withoutLateral);
        expect(without.velocity.y).not.toBeCloseTo(withDownforce.velocity.y, 8);
    });

    it('ignores downforce when the configured value is exactly zero (L612)', () => {
        const dt = 0.05;
        const stateA = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 4, y: 8 },
            angle: 0,
        });
        const stateB = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 4, y: 8 },
            angle: 0,
        });
        const base = { ...CONFIG, accel: 0, grip: 2, highSpeedSteerTrim: 0 };

        updateSimulation(stateA, dt, { ...base, downforceGrip: 0 }, OPEN_TRACK, []);
        updateSimulation(stateB, dt, { ...base, downforceGrip: -1 }, OPEN_TRACK, []);

        expect(stateB.velocity.x).toBeCloseTo(stateA.velocity.x, 10);
        expect(stateB.velocity.y).toBeCloseTo(stateA.velocity.y, 10);
    });
});

describe('simulation survivor kills wave3 — slip gate and scrape severity', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports scrape severity between speed-only and max-depth bounds (L427-L437)', () => {
        const carRadius = 0.275;
        const referenceImpactKph = 150;
        const speedWeight = 0.8;
        const depthWeight = 0.2;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 3.75, y: 0 },
            angle: 0,
        });
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            carRadius,
            carCollisionHalfLength: 0,
            wallScrapeReferenceImpactKph: referenceImpactKph,
            wallScrapeSpeedSeverityWeight: speedWeight,
            wallScrapeDepthSeverityWeight: depthWeight,
            wallScrapeMaxTangentialRetention: 0.85,
            wallScrapeMinTangentialRetention: 0.35,
            wallScrapeMinBounce: 0.05,
            wallScrapeMaxBounce: 0.15,
        };

        const events = updateSimulation(state, 0.05, config, OPEN_TRACK, [WALL_AT(0.2)]);

        const impactKph = events.wallImpact.impactKph;
        const speedSeverity = Math.min(1, impactKph / referenceImpactKph);
        const minSeverity = (speedSeverity * speedWeight) / (speedWeight + depthWeight);
        const maxSeverity = (speedSeverity * speedWeight + depthWeight) / (speedWeight + depthWeight);

        expect(events.wallImpact).toMatchObject({ kind: 'scrape' });
        expect(events.wallImpact.severity).toBeGreaterThanOrEqual(minSeverity - 0.01);
        expect(events.wallImpact.severity).toBeLessThanOrEqual(maxSeverity + 0.01);
        expect(events.wallImpact.severity).toBeGreaterThan(0.15);
        expect(events.wallImpact.severity).toBeLessThan(1);
    });
});

describe('simulation survivor kills wave3 — event reset and collision early exits', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('clears every transient event field after a wall scrape tick (L8-L19)', () => {
        const wall = WALL_AT(0.35);
        const state = createTestSimState({
            pos: { x: 0.05, y: 0 },
            velocity: { x: 8, y: 0 },
            angle: 0,
            particles: [],
        });
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            carRadius: 0.275,
            carCollisionHalfLength: 0,
            wallScrapeReferenceImpactKph: 5,
        };

        const active = updateSimulation(state, 0.05, config, OPEN_TRACK, [wall]);
        expect(active.wallImpact).toMatchObject({ kind: 'scrape' });

        state.velocity = { x: 0, y: 0 };
        const idle = updateSimulation(state, 0.05, config, OPEN_TRACK, []);

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
            checkpointPassed: null,
        });
    });

    it('skips wall contact resolution when collision segments are empty (L325, L344)', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 5, y: 0 },
            angle: 0,
        });
        const before = { ...state.pos };

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0 },
            OPEN_TRACK,
            null,
        );

        expect(events.wallImpact).toBeNull();
        expect(state.pos.x).toBeGreaterThan(before.x);
        expect(state.pos.y).toBeCloseTo(before.y, 10);
    });
});
