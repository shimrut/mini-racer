import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import {
    DEFAULT_TRACK_KEY,
    hasTrack,
    TRACK_CATALOG,
    TRACK_SCHEDULE_KEYS,
} from '../game/track/catalog.js';
import { CAMPAIGN_NUMBERS_SERIES_ID, getCampaignSeriesStages } from '../game/campaign/manifest.js';
import { TRACKS } from '../game/track/tracks.js';
import { CONFIG } from '../game/config.js';
import { DEFAULT_TRACK_GROUND_KEY, isTrackGroundKey } from '../game/track/grounds.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../game/track/runtime.js';

const NUMBERS_STAGES = getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID);

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

function distanceToPolygon(point, polygon) {
    let nearest = Infinity;
    for (let i = 0; i < polygon.length; i += 1) {
        const start = polygon[i];
        const end = polygon[(i + 1) % polygon.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lenSq = dx * dx + dy * dy || 1e-9;
        const t = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq));
        const distance = Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
        if (distance < nearest) nearest = distance;
    }
    return nearest;
}

function gateEndpointLeak(point, geometry) {
    const onDrivableSurface = pointInPolygon(point, geometry.outer)
        && !pointInPolygon(point, geometry.inner);
    if (!onDrivableSurface) return 0;
    return Math.min(
        distanceToPolygon(point, geometry.outer),
        distanceToPolygon(point, geometry.inner),
    );
}

function hashTrackRegistry(trackRegistry) {
    return createHash('sha256')
        .update(JSON.stringify(trackRegistry))
        .digest('hex');
}

describe('track runtime integrity', () => {
    it('keeps the complete compatibility registry with Daily as an ordered subset', () => {
        expect(Object.keys(TRACKS)).toEqual(Object.keys(TRACK_CATALOG));
        expect(TRACK_SCHEDULE_KEYS.every((trackKey) => hasTrack(trackKey))).toBe(true);
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
        const expectedFiles = Object.keys(TRACK_CATALOG)
            .map((trackKey) => `${toKebabCase(trackKey)}.js`)
            .sort();

        expect(definitionFiles).toEqual(expectedFiles);
    });

    it('preserves existing track data while intentionally extending the registry', () => {
        const catalogKeys = Object.keys(TRACK_CATALOG);
        const firstNewTrackIndex = catalogKeys.indexOf('mistfallCircuit');
        expect(firstNewTrackIndex).toBeGreaterThan(0);
        expect(catalogKeys.slice(firstNewTrackIndex)).toEqual([
            'mistfallCircuit',
            'numberEight',
            'numberNine',
            'analogAudio',
            'sundayMarket',
            'hardHitter',
            'roadRage',
            'yellowYard',
            'lunarLimbo',
            'blackstoneRun',
            'titanTown',
            'eulersNumber',
            'imaginaryNumber',
            'infinitePie',
            'centralDrop',
            'goldenRatio',
            'fedoraHat',
            'infinityIsle',
            'kangarooKyle',
            'quarterlyQuestion',
            'romanianRhapsody',
            'fairyLand',
            'felineFace',
            'darkMatter',
            'appleStrudel',
            'heavyMetal',
            'knifesEdge',
            'pocketRun',
            'crossCurrent',
            'squareDeal',
            'doubleHook',
            'doubleCrest',
            'heartsQueen',
            'aceSpades',
            'twistedLadder',
            'hairpinHook',
            'dragonLoop',
            'thorsHammer',
            'questionMark',
            'nestedRun',
            'mountainPeak',
            'sharkFin',
            'twistedClover',
            'hookLoop',
            'crookedArrow',
            'windingRoad',
            'waterPistol',
            'lightningHook',
            'doubleTrouble',
            'brokenWing',
            'twinWings',
            'squareRoot',
            'halfLife',
            'splitJaw',
            'chelseaBoots',
            'stoneGate',
            'crakowBoot',
            'slingshotRun',
            'brokenAntler',
            'mantisBend',
            'cloverLeaf',
            'safariCircuit',
            'monkeyWrench',
            'ovenMitt',
            'monkeyTail',
            'bottleOpener',
            'serpentHead',
            'bullShield',
            'battleHook',
            'thunderCat',
            'slateCircuit',
            'blackWater',
            'ravenRock',
            'sharkBite',
            'puzzlePiece',
            'castleWall',
            'blasterLoop',
            'canyonFold',
            'whistleRidge',
            'monoRail',
            'anchorPark',
            'puppetMaster',
            'sunsetTerrace',
            'anvilCircuit',
            'countryRoad',
            'snowCircuit',
            'gripCircuit',
            'middleWay',
            'waterCircuit',
            'spaceCircuit',
            'forestTrail',
            'hillsideScramble',
            'dirtLoop',
            'ridgeRunner',
            'brokenRoad',
            'roughCut',
            'dirtSnake',
            'wildCrest',
            'dirtValley',
            'warpedLoop',
        ]);
        const campaignTrackKeys = new Set(NUMBERS_STAGES.map((stage) => stage.trackKey));
        const existingCatalogKeys = catalogKeys.slice(0, firstNewTrackIndex);
        expect(TRACK_SCHEDULE_KEYS.filter((trackKey) => (
            existingCatalogKeys.includes(trackKey)
        ))).toEqual(
            existingCatalogKeys.filter((trackKey) => !campaignTrackKeys.has(trackKey)),
        );

        const intentionallyReviewedKeys = new Set([
            ...catalogKeys.slice(firstNewTrackIndex),
            'numberZero',
            'numberOne',
            'numberTwo',
            'numberThree',
            'numberFour',
            'numberFive',
            'numberSix',
            'numberSeven',
        ]);
        const unchangedTrackRegistry = Object.fromEntries(
            Object.entries(TRACKS)
                .filter(([trackKey]) => !intentionallyReviewedKeys.has(trackKey)),
        );
        expect(hashTrackRegistry(unchangedTrackRegistry)).toBe(
            '9a40e6ebe61cf1ad0814cb2ae8b05c1a61491386dfd0c6a27fd3a240f252701b',
        );

        const existingTrackRegistry = Object.fromEntries(
            catalogKeys
                .slice(0, firstNewTrackIndex)
                .map((trackKey) => [trackKey, TRACKS[trackKey]]),
        );
        expect(hashTrackRegistry(existingTrackRegistry)).toBe(
            'd5f930078b4bd671d6d50aa8a61cc1c08c74d0acdc14ade07d1f6fcd581d0576',
        );
        // Mountain Peak, Shark Fin, Twisted Clover, Hook Loop, Crooked Arrow and
        // Winding Road were reshaped on purpose on 2026-09-25. The next three hashes
        // include those shapes. They also include the reshapes of 2026-09-27: 12
        // Daily tracks, and Water Pistol in place of Gun Slinger, which was never live.
        // Hook Loop, Shark Fin, Twin Wings and Winding Road were reshaped again later
        // on 2026-09-27, before they were ever a live Daily day. On 2026-09-29,
        // Broken Antler got simpler corners, and Winding Road got rounder corners
        // and moved gates. The same day, every definition dropped the unused
        // drawWidth and lineSmoothing fields, so these hashes all moved.
        const reshapedKeys = new Set(['doubleTrouble', 'monkeyWrench', 'sharkBite']);
        const addedKeys = new Set(catalogKeys.slice(catalogKeys.indexOf('puzzlePiece')));
        const withoutReshapedOrAdded = Object.fromEntries(
            Object.entries(TRACKS)
                .filter(([trackKey]) => !reshapedKeys.has(trackKey) && !addedKeys.has(trackKey)),
        );
        expect(hashTrackRegistry(withoutReshapedOrAdded)).toBe(
            '9ec0d85ececf610060e786f1914ca01c46b280ea1430795b531727a6c82f95c7',
        );
        const throughSharkBite = Object.fromEntries(
            Object.entries(TRACKS).filter(([trackKey]) => !addedKeys.has(trackKey)),
        );
        expect(hashTrackRegistry(throughSharkBite)).toBe(
            '4c4654b67fc05b67be1ec7998ad78ff575efb0614bd6c89621c0377f75efdd31',
        );
        expect(hashTrackRegistry(TRACKS)).toBe(
            '150d591f413bd0d7b010504d6b1c70d2f76068fd3c45104e0734d2b11b236bb8',
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
            expect(track.checkpoints?.length ?? 0, `${trackKey} needs at least 3 checkpoints`).toBeGreaterThanOrEqual(3);

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

    it('names only a known, non-tarmac ground in a track definition', () => {
        Object.entries(TRACKS).forEach(([trackKey, track]) => {
            if (!Object.hasOwn(track, 'ground')) return;
            expect(isTrackGroundKey(track.ground), `${trackKey} has an unknown ground`).toBe(true);
            expect(track.ground, `${trackKey} should omit the default ground`).not.toBe(DEFAULT_TRACK_GROUND_KEY);
        });
    });

    it('keeps every lap gate sealed across the drivable corridor', () => {
        const carRadius = CONFIG.carRadius;
        expect(Number.isFinite(carRadius)).toBe(true);

        Object.entries(TRACKS).forEach(([trackKey, track]) => {
            const geometry = buildTrackGeometry(track);
            const gates = [
                ['startLine', track.startLine],
                ...(track.checkpoints || []).map((checkpoint, index) => [`checkpoint ${index}`, checkpoint]),
            ];

            gates.forEach(([gateName, gate]) => {
                const leak = Math.max(
                    gateEndpointLeak(gate.p1, geometry),
                    gateEndpointLeak(gate.p2, geometry),
                );
                expect(
                    leak,
                    `${trackKey} ${gateName} leaves a ${leak.toFixed(3)} gap a car center (radius ${carRadius}) could drive through`,
                ).toBeLessThanOrEqual(carRadius);
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
