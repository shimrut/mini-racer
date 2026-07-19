import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import {
    DEFAULT_TRACK_KEY,
    hasTrack,
    TRACK_CATALOG,
    TRACK_SCHEDULE_KEYS,
} from '../game/track/catalog.js';
import { TRACKS } from '../game/track/tracks.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../game/track/runtime.js';

function expectFinitePoint(point) {
    expect(Number.isFinite(point?.x)).toBe(true);
    expect(Number.isFinite(point?.y)).toBe(true);
}

function expectPointClose(actual, expected) {
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
}

function segmentsIntersect(a, b, c, d) {
    const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const current = polygon[i];
        const previous = polygon[j];
        const crosses = ((current.y > point.y) !== (previous.y > point.y))
            && (point.x < ((previous.x - current.x) * (point.y - current.y)) / ((previous.y - current.y) || 1e-9) + current.x);
        if (crosses) inside = !inside;
    }
    return inside;
}

function toKebabCase(trackKey) {
    return trackKey.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function hashTrackRegistry(trackRegistry) {
    return createHash('sha256')
        .update(JSON.stringify(trackRegistry))
        .digest('hex');
}

describe('track runtime integrity', () => {
    it('keeps the compatibility registry ordered by the complete schedule', () => {
        expect(Object.keys(TRACKS)).toEqual(TRACK_SCHEDULE_KEYS);
        expect(new Set(TRACK_SCHEDULE_KEYS)).toEqual(new Set(Object.keys(TRACK_CATALOG)));
        expect(new Set(TRACK_SCHEDULE_KEYS).size).toBe(TRACK_SCHEDULE_KEYS.length);
        Object.entries(TRACK_CATALOG).forEach(([trackKey, metadata]) => {
            expect(metadata.name.trim(), `${trackKey} needs a player-facing name`).not.toBe('');
            expect(TRACKS[trackKey]?.name).toBe(metadata.name);
        });
    });

    it('keeps exactly one kebab-case definition file for every catalog track', () => {
        const definitionFiles = readdirSync(
            new URL('../game/track/definitions/', import.meta.url),
        )
            .filter((filename) => filename.endsWith('.js'))
            .sort();
        const expectedFiles = TRACK_SCHEDULE_KEYS
            .map((trackKey) => `${toKebabCase(trackKey)}.js`)
            .sort();

        expect(definitionFiles).toEqual(expectedFiles);
    });

    it('preserves existing track data while intentionally extending the registry', () => {
        const firstNewTrackIndex = TRACK_SCHEDULE_KEYS.indexOf('numberZero');
        expect(firstNewTrackIndex).toBeGreaterThan(0);
        expect(TRACK_SCHEDULE_KEYS.slice(firstNewTrackIndex)).toEqual([
            'numberZero',
            'numberOne',
            'numberTwo',
            'numberThree',
            'numberFour',
            'numberFive',
            'numberSix',
        ]);

        const existingTrackRegistry = Object.fromEntries(
            TRACK_SCHEDULE_KEYS
                .slice(0, firstNewTrackIndex)
                .map((trackKey) => [trackKey, TRACKS[trackKey]]),
        );
        expect(hashTrackRegistry(existingTrackRegistry)).toBe(
            '923415f865de38edd3737e9c035dfa657e392c3d12143f29a38f8bbc491f14f8',
        );
        expect(hashTrackRegistry(TRACKS)).toBe(
            '39800bd2b79dab5689ba00ffc4fea5315c8d6569aaafc863173c2e85deeef050',
        );
    });

    it('keeps Kettle Run nested and its lap gates ordered for a complete timed lap', () => {
        const track = TRACKS.kettleRun;
        track.inner.forEach((point) => {
            expect(pointInPolygon(point, track.outer)).toBe(true);
        });

        const centerline = track.outer.map((outerPoint, index) => ({
            x: (outerPoint.x + track.inner[index].x) / 2,
            y: (outerPoint.y + track.inner[index].y) / 2
        }));

        const events = [];
        let checkpointIndex = 0;
        for (let index = 0; index < centerline.length; index += 1) {
            const current = centerline[index];
            const next = centerline[(index + 1) % centerline.length];
            const checkpoint = track.checkpoints[checkpointIndex];
            if (checkpoint && segmentsIntersect(current, next, checkpoint.p1, checkpoint.p2)) {
                events.push(`cp-${checkpointIndex}`);
                checkpointIndex += 1;
            }
            if (segmentsIntersect(current, next, track.startLine.p1, track.startLine.p2)) {
                events.push(`finish-${checkpointIndex}`);
                checkpointIndex = 0;
            }
        }

        expect(events).toEqual(['finish-0', 'cp-0', 'cp-1', 'cp-2']);
    });

    it('keeps every scheduled track mapped to a real playable definition', () => {
        expect(TRACK_SCHEDULE_KEYS.length).toBeGreaterThan(0);
        expect(DEFAULT_TRACK_KEY).toBe(TRACK_SCHEDULE_KEYS[0]);
        TRACK_SCHEDULE_KEYS.forEach((trackKey) => {
            expect(hasTrack(trackKey), `${trackKey} is missing from the catalog`).toBe(true);
            expect(TRACKS[trackKey], `${trackKey} is missing from TRACKS`).toBeTruthy();
        });
    });

    it('keeps track definitions complete enough to start, validate, and collide', () => {
        Object.entries(TRACKS).forEach(([trackKey, track]) => {
            expect(track.name, `${trackKey} is missing a player-facing name`).toBeTruthy();
            expect(track.outer.length, `${trackKey} needs an outer boundary`).toBeGreaterThanOrEqual(3);
            expect(track.inner.length, `${trackKey} needs an inner boundary`).toBeGreaterThanOrEqual(3);
            expectFinitePoint(track.startPos);
            expectFinitePoint(track.startLine?.p1);
            expectFinitePoint(track.startLine?.p2);
            expect(Number.isFinite(track.startAngle), `${trackKey} needs a start angle`).toBe(true);

            track.outer.forEach(expectFinitePoint);
            track.inner.forEach(expectFinitePoint);
            (track.checkpoints || []).forEach((checkpoint) => {
                expectFinitePoint(checkpoint.p1);
                expectFinitePoint(checkpoint.p2);
            });

            const geometry = buildTrackGeometry(track);
            const runtime = buildCollisionRuntime(geometry);
            expect(runtime.collisionSegments.length, `${trackKey} needs collision walls`).toBeGreaterThan(0);
            expect(runtime.collisionHash.cells.size, `${trackKey} needs hashed collision cells`).toBeGreaterThan(0);
            runtime.collisionSegments.forEach((segment) => {
                expectFinitePoint(segment.start);
                expectFinitePoint(segment.end);
                expect(Number.isFinite(segment.lenSq)).toBe(true);
                expect(segment.lenSq).toBeGreaterThan(0);
            });
        });
    });

    it('deduplicates only truly overlapping boundary points before smoothing', () => {
        const track = {
            outer: [
                { x: 0, y: 0 },
                { x: 0.005, y: 0.005 },
                { x: 0.016, y: 0.005 },
                { x: 0.02, y: 4 },
                { x: 4, y: 4 },
                { x: 4, y: 0 }
            ],
            inner: [
                { x: 1, y: 1 },
                { x: 1.005, y: 3 },
                { x: 3, y: 3 },
                { x: 3, y: 1 }
            ],
            cornerRadius: 0
        };

        const geometry = buildTrackGeometry(track);

        expect(geometry.outer).toHaveLength(30);
        expect(geometry.inner).toHaveLength(24);
        expectPointClose(geometry.outer[0], { x: 0.005, y: 0.005 });
        expectPointClose(geometry.inner[0], { x: 1, y: 1 });
    });

    it('keeps exact threshold-separated point pairs as a simple unsmoothed profile', () => {
        const track = {
            outer: [
                { x: 0, y: 0 },
                { x: 0.01, y: 0 }
            ],
            inner: [
                { x: 0, y: 0 },
                { x: 0, y: 0.01 }
            ],
            cornerRadius: 3
        };

        const geometry = buildTrackGeometry(track);

        expect(geometry.outer).toHaveLength(2);
        expect(geometry.outer).toEqual(track.outer);
        expect(geometry.inner).toHaveLength(2);
        expect(geometry.inner).toEqual(track.inner);
    });

    it('smooths a valid three-point boundary instead of treating it as a raw polyline', () => {
        const track = {
            outer: [
                { x: 0, y: 0 },
                { x: 8, y: 0 },
                { x: 0, y: 6 }
            ],
            inner: [
                { x: 2, y: 1 },
                { x: 5, y: 1 },
                { x: 2, y: 4 }
            ],
            cornerRadius: 1
        };

        const geometry = buildTrackGeometry(track);

        expect(geometry.outer).toHaveLength(18);
        expectPointClose(geometry.outer[0], { x: 0, y: 1 });
        expectPointClose(geometry.outer[5], { x: 1, y: 0 });
        expectPointClose(geometry.outer[6], { x: 7, y: 0 });
        expectPointClose(geometry.outer[17], { x: 0, y: 5 });
    });

    it('rounds square track corners with the expected quadratic samples', () => {
        const track = {
            outer: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 }
            ],
            inner: [
                { x: 3, y: 3 },
                { x: 7, y: 3 },
                { x: 7, y: 7 },
                { x: 3, y: 7 }
            ],
            cornerRadius: 2
        };

        const geometry = buildTrackGeometry(track);
        const expectedOuter = [
            { x: 0, y: 2 },
            { x: 0.08, y: 1.28 },
            { x: 0.32, y: 0.72 },
            { x: 0.72, y: 0.32 },
            { x: 1.28, y: 0.08 },
            { x: 2, y: 0 },
            { x: 8, y: 0 },
            { x: 8.72, y: 0.08 },
            { x: 9.28, y: 0.32 },
            { x: 9.68, y: 0.72 },
            { x: 9.92, y: 1.28 },
            { x: 10, y: 2 },
            { x: 10, y: 8 },
            { x: 9.92, y: 8.72 },
            { x: 9.68, y: 9.28 },
            { x: 9.28, y: 9.68 },
            { x: 8.72, y: 9.92 },
            { x: 8, y: 10 },
            { x: 2, y: 10 },
            { x: 1.28, y: 9.92 },
            { x: 0.72, y: 9.68 },
            { x: 0.32, y: 9.28 },
            { x: 0.08, y: 8.72 },
            { x: 0, y: 8 }
        ];

        expect(geometry.outer).toHaveLength(expectedOuter.length);
        geometry.outer.forEach((point, index) => {
            expectPointClose(point, expectedOuter[index]);
        });
    });

    it('builds collision segments and hash buckets from true segment bounds', () => {
        const geometry = {
            outer: [
                { x: -1, y: -1 },
                { x: 7, y: 7 }
            ],
            inner: [
                { x: 12, y: 0 },
                { x: 12, y: 6 },
                { x: 18, y: 6 }
            ]
        };

        const runtime = buildCollisionRuntime(geometry);

        expect(runtime.collisionSegments).toHaveLength(5);
        expect(runtime.collisionHash).toMatchObject({
            cellSize: 6,
            segments: runtime.collisionSegments,
            candidateSegments: [],
            queryStamp: 0
        });
        expect(runtime.collisionSegments[0]).toEqual({
            start: { x: -1, y: -1 },
            end: { x: 7, y: 7 },
            minX: -1,
            maxX: 7,
            minY: -1,
            maxY: 7,
            dx: 8,
            dy: 8,
            lenSq: 128
        });

        expect([...runtime.collisionHash.cells.keys()].sort()).toEqual([
            '-1,-1',
            '-1,0',
            '-1,1',
            '0,-1',
            '0,0',
            '0,1',
            '1,-1',
            '1,0',
            '1,1',
            '2,0',
            '2,1',
            '3,0',
            '3,1'
        ]);
        expect(runtime.collisionHash.cells.get('-1,-1')).toEqual([
            runtime.collisionSegments[0],
            runtime.collisionSegments[1]
        ]);
        expect(runtime.collisionHash.cells.get('3,1')).toEqual([
            runtime.collisionSegments[3],
            runtime.collisionSegments[4]
        ]);
    });
});
