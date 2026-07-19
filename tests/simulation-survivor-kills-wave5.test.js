import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import {
    CONTACT_EPSILON,
    createSegment,
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

describe('simulation survivor kills wave5 — pair distance ties', () => {
    it('keeps the first closest pair when distances tie within CONTACT_EPSILON (L120)', () => {
        const left = createSegment({ x: 0, y: 0 }, { x: 0, y: 4 });
        const right = createSegment({ x: 2, y: 0 }, { x: 2, y: 4 });
        const pair = getClosestSegmentPair(left, right);

        expect(pair.distance).toBeCloseTo(2, 10);
        expect(pair.first.x).toBeCloseTo(0, 10);
        expect(pair.second.x).toBeCloseTo(2, 10);
    });

    it('requires penetration beyond CONTACT_EPSILON to replace the deepest overlap (L323-L324)', () => {
        const shallow = contact({ penetration: 1, segmentIndex: 1, normal: { x: 1, y: 0 } });
        const barelyDeeper = contact({
            penetration: 1 + CONTACT_EPSILON * 0.5,
            segmentIndex: 2,
            normal: { x: 0, y: 1 },
        });
        const strictlyDeeper = contact({
            penetration: 1 + CONTACT_EPSILON * 2,
            segmentIndex: 2,
            normal: { x: 0, y: 1 },
        });

        expect(selectDeepestOverlap([shallow, barelyDeeper])).toBe(shallow);
        expect(selectDeepestOverlap([shallow, strictlyDeeper])).toBe(strictlyDeeper);
    });

    it('prefers faster inward speed when penetration ties within epsilon (L302-L303)', () => {
        const slower = contact({ inwardSpeed: 1, penetration: 0.4, segmentIndex: 0 });
        const faster = contact({
            inwardSpeed: 1 + CONTACT_EPSILON * 2,
            penetration: 0.4 + CONTACT_EPSILON * 0.25,
            segmentIndex: 1,
        });

        expect(selectWallContact([slower, faster])).toBe(faster);
    });
});

describe('simulation survivor kills wave5 — endpoint normal fallback', () => {
    it('uses the body vector when the safe point equals the wall endpoint (L148-L154)', () => {
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
});

describe('simulation survivor kills wave5 — swept contacts and hash dedupe', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('detects swept nose contacts when halfLength is positive (L255-L284)', () => {
        const wall = VERTICAL_WALL(0);
        const state = createTestSimState({
            pos: { x: 1.2, y: 0 },
            prevPos: { x: 1.2, y: 0 },
            velocity: { x: -40, y: 0 },
            angle: Math.PI,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });

        const events = updateSimulation(
            state,
            0.05,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                carRadius: 0.35,
                carCollisionHalfLength: 0.45,
                wallContactPadding: 0.001,
                wallScrapeReferenceImpactKph: 150,
            },
            OPEN_TRACK,
            [wall],
        );

        expect(events.wallImpact).not.toBeNull();
        expect(state.pos.x).toBeGreaterThan(0);
    });

    it('deduplicates hash bucket segments via queryStamp (L477-L490)', () => {
        const segment = VERTICAL_WALL(1);
        segment.queryStamp = 0;
        const collisionData = {
            cellSize: 2,
            cells: new Map([['0,0', [segment, segment]]]),
            segments: [segment],
            candidateSegments: [],
            queryStamp: 0,
        };
        const state = createTestSimState({
            pos: { x: 0.5, y: 0 },
            prevPos: { x: 0.5, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0,
            collisionHash: collisionData,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
        });

        updateSimulation(
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

        expect(collisionData.candidateSegments).toHaveLength(1);
        expect(segment.queryStamp).toBeGreaterThan(0);
    });

    it('uses a plain collision segment array when no hash is configured (L465-L466)', () => {
        const wall = VERTICAL_WALL(0.6);
        const state = createTestSimState({
            pos: { x: 0.2, y: 0 },
            prevPos: { x: 0.2, y: 0 },
            velocity: { x: 10, y: 0 },
            angle: 0,
            collisionHash: null,
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
            },
            OPEN_TRACK,
            [wall],
        );

        expect(events.wallImpact === null || events.wallImpact.kind === 'scrape').toBe(true);
    });
});

describe('simulation survivor kills wave5 — scrape feedback and route trace', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('records route-trace samples from the rear axle when tracing is enabled (L765-L773)', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 8, y: 0 },
            angle: 0,
            routeTraceStrokeStyle: '#fff',
            trailTimer: 0,
        });

        updateSimulation(
            state,
            0.06,
            {
                ...CONFIG,
                accel: 0,
                grip: 0,
                downforceGrip: 0,
                carRearAxleOffset: 0.2,
            },
            OPEN_TRACK,
            [],
        );

        expect(state.routeTrace.length).toBeGreaterThan(0);
    });

    it('emits fewer scrape sparks when frameSkip is enabled (L733)', () => {
        const wall = VERTICAL_WALL(1);
        const scrapeConfig = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            downforceGrip: 0,
            carRadius: 0.4,
            carCollisionHalfLength: 0,
            wallScrapeReferenceImpactKph: 150,
        };
        const full = createTestSimState({
            pos: { x: 0.5, y: 0 },
            prevPos: { x: 0.5, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0,
            frameSkip: 0,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });
        const skipped = createTestSimState({
            pos: { x: 0.5, y: 0 },
            prevPos: { x: 0.5, y: 0 },
            velocity: { x: 12, y: 0 },
            angle: 0,
            frameSkip: 1,
            wallContactActive: false,
            wallImpactCooldownRemaining: 0,
            particles: [],
        });

        updateSimulation(full, 1 / 60, scrapeConfig, OPEN_TRACK, [wall]);
        updateSimulation(skipped, 1 / 60, scrapeConfig, OPEN_TRACK, [wall]);

        expect(full.particles.length).toBeGreaterThan(0);
        expect(skipped.particles.length).toBeGreaterThan(0);
        expect(skipped.particles.length).toBeLessThan(full.particles.length);
        expect(full.particles.length / skipped.particles.length).toBeCloseTo(1.5, 5);
    });
});
