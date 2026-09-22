import { describe, expect, it } from 'vitest';
import { updateSimulation } from '../game/race/simulation.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../game/track/runtime.js';
import { CONFIG } from '../game/config.js';
import { TRACKS } from '../game/track/tracks.js';
import { createTestSimState, TEST_TRACK } from './helpers/sim-state.js';

const HEAVY_TRACK_RUNTIME = buildCollisionRuntime(buildTrackGeometry(TRACKS.alloyRing));
const REFERENCE_SEGMENT = HEAVY_TRACK_RUNTIME.collisionSegments[0];
const HASH_TEST_WALL = {
    start: { x: 0.5, y: -1 },
    end: { x: 0.5, y: 1 },
    dx: 0,
    dy: 2,
    lenSq: 4
};
const FAR_AWAY_WALL = {
    start: { x: 50, y: -1 },
    end: { x: 50, y: 1 },
    dx: 0,
    dy: 2,
    lenSq: 4
};
const HASH_EDGE_WALLS = [
    {
        start: { x: 1.1, y: 0.9 },
        end: { x: 1.1, y: 1.3 },
        dx: 0,
        dy: 0.4,
        lenSq: 0.16
    },
    {
        start: { x: 0.9, y: 1.1 },
        end: { x: 1.3, y: 1.1 },
        dx: 0.4,
        dy: 0,
        lenSq: 0.16
    },
    {
        start: { x: 0.7, y: 1.1 },
        end: { x: 0.9, y: 1.1 },
        dx: 0.2,
        dy: 0,
        lenSq: 0.04
    },
    {
        start: { x: 1.1, y: 0.7 },
        end: { x: 1.1, y: 0.9 },
        dx: 0,
        dy: 0.2,
        lenSq: 0.04
    }
];

function getSegmentFrame(segment) {
    const length = Math.hypot(segment.dx, segment.dy) || 1;
    const tangent = { x: segment.dx / length, y: segment.dy / length };
    const normal = { x: -tangent.y, y: tangent.x };
    const midpoint = {
        x: (segment.start.x + segment.end.x) / 2,
        y: (segment.start.y + segment.end.y) / 2
    };

    return { midpoint, tangent, normal };
}

function createComparableState(overrides = {}, collisionHash = null) {
    return createTestSimState({
        currentTime: 2,
        collisionHash,
        ...structuredClone(overrides)
    });
}

function captureOutcome(state, events) {
    return {
        status: state.status,
        currentTime: Number(state.currentTime.toFixed(6)),
        pos: {
            x: Number(state.pos.x.toFixed(6)),
            y: Number(state.pos.y.toFixed(6))
        },
        velocity: {
            x: Number(state.velocity.x.toFixed(6)),
            y: Number(state.velocity.y.toFixed(6))
        },
        cachedSpeed: Number(state.cachedSpeed.toFixed(6)),
        angularVelocity: Number(state.angularVelocity.toFixed(6)),
        wallImpactCooldownRemaining: Number(state.wallImpactCooldownRemaining.toFixed(6)),
        wallContactActive: state.wallContactActive,
        wallContactReleaseRemaining: Number(state.wallContactReleaseRemaining.toFixed(6)),
        nextCheckpointIndex: state.nextCheckpointIndex,
        particles: state.particles.length,
        routeTracePoints: state.routeTrace.length,
        skidMarks: state.skidMarks.length,
        events: {
            wallImpact: events.wallImpact,
            winTriggered: events.winTriggered,
            challengeLapCompleted: events.challengeLapCompleted,
        }
    };
}

function runScenario(overrides = {}) {
    const withoutHash = createComparableState(overrides, null);
    const withHash = createComparableState(overrides, HEAVY_TRACK_RUNTIME.collisionHash);

    const plainEvents = updateSimulation(withoutHash, 1 / 60, CONFIG, TEST_TRACK, HEAVY_TRACK_RUNTIME.collisionSegments);
    const hashedEvents = updateSimulation(withHash, 1 / 60, CONFIG, TEST_TRACK, HEAVY_TRACK_RUNTIME.collisionSegments);

    expect(captureOutcome(withHash, hashedEvents)).toEqual(captureOutcome(withoutHash, plainEvents));
}

describe('collision hash broadphase', () => {
    it('matches the existing full-segment collision result for wall impacts', () => {
        const { midpoint, normal } = getSegmentFrame(REFERENCE_SEGMENT);
        const speed = 18;

        runScenario({
            pos: {
                x: midpoint.x - normal.x * 0.22,
                y: midpoint.y - normal.y * 0.22
            },
            prevPos: {
                x: midpoint.x - normal.x * 0.22,
                y: midpoint.y - normal.y * 0.22
            },
            velocity: {
                x: normal.x * speed,
                y: normal.y * speed
            },
            angle: Math.atan2(normal.y, normal.x)
        });
    });

    it('matches the existing full-segment collision result for clear movement near a wall', () => {
        const { midpoint, tangent, normal } = getSegmentFrame(REFERENCE_SEGMENT);
        const speed = 10;

        runScenario({
            pos: {
                x: midpoint.x - normal.x * 1.2,
                y: midpoint.y - normal.y * 1.2
            },
            prevPos: {
                x: midpoint.x - normal.x * 1.2,
                y: midpoint.y - normal.y * 1.2
            },
            velocity: {
                x: tangent.x * speed,
                y: tangent.y * speed
            },
            angle: Math.atan2(tangent.y, tangent.x)
        });
    });

    it('uses nearby hash buckets and deduplicates repeated segment references', () => {
        const collisionHash = {
            cells: new Map([
                ['0,0', [HASH_TEST_WALL]],
                ['1,0', [HASH_TEST_WALL]]
            ]),
            segments: [FAR_AWAY_WALL],
            cellSize: 1,
            queryStamp: 0,
            candidateSegments: []
        };
        const state = createTestSimState({
            collisionHash,
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 0 },
            angle: 0
        });

        const events = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, wallScrapeReferenceImpactKph: 100, carRadius: 0.1 }, TEST_TRACK, []);

        expect(collisionHash.queryStamp).toBe(1);
        expect(collisionHash.candidateSegments).toEqual([HASH_TEST_WALL]);
        expect(events.wallImpact).toMatchObject({ kind: 'scrape', severity: 1 });
        expect(state.status).toBe('playing');
    });

    it('includes hash buckets touched only by the oriented collision-body expansion', () => {
        const collisionHash = {
            cells: new Map([
                ['1,1', [HASH_EDGE_WALLS[0], HASH_EDGE_WALLS[1]]],
                ['0,1', [HASH_EDGE_WALLS[2]]],
                ['1,0', [HASH_EDGE_WALLS[3]]]
            ]),
            segments: [FAR_AWAY_WALL],
            cellSize: 1,
            queryStamp: 0,
            candidateSegments: []
        };
        const state = createTestSimState({
            collisionHash,
            pos: { x: 1.1, y: 1.1 },
            velocity: { x: 0, y: 0 },
            angle: 0
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 0, carRadius: 0.25 }, TEST_TRACK, []);

        expect(collisionHash.candidateSegments).toEqual([
            HASH_EDGE_WALLS[3],
            HASH_EDGE_WALLS[2],
            HASH_EDGE_WALLS[0],
            HASH_EDGE_WALLS[1]
        ]);
        expect(state.particles.length).toBe(0);
        expect(state.pos.x).not.toBeCloseTo(1.1);
    });

    it('falls back to full collision segments when the swept hash range is empty', () => {
        const collisionHash = {
            cells: new Map(),
            segments: [HASH_TEST_WALL],
            cellSize: 1,
            queryStamp: 0,
            candidateSegments: []
        };
        const state = createTestSimState({
            collisionHash,
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 0 },
            angle: 0
        });

        const events = updateSimulation(state, 0.1, { ...CONFIG, accel: 0, wallScrapeReferenceImpactKph: 100, carRadius: 0.1 }, TEST_TRACK, []);

        expect(collisionHash.candidateSegments).toEqual([]);
        expect(events.wallImpact).toMatchObject({ kind: 'scrape', severity: 1 });
        expect(state.status).toBe('playing');
    });
});
