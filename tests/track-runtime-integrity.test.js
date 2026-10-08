import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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
const MEDAL_TIMES = JSON.parse(readFileSync(new URL('../game/medals/medal-times.json', import.meta.url), 'utf8'));

// From the v2.4.0 server bundle, checked against racer-v2-4 (e9a578eb); pins whole definitions, legacy fields too.
const V240_TRACK_CONTRACTS = [
    ['gunSlinger', 'e088f7afbf00b7b7aa1064a85bd2ec100307b8f57e0ce72fb63d485a76b89050', { author: 9.15, gold: 9.39, silver: 9.72, bronze: 10.03 }],
    ['brokenWing', 'e7c79e7b37bf692842b428dde318a9b9e9eb427634b8397dabfb0ab2cb8a6dc8', { author: 11.47, gold: 11.82, silver: 12.15, bronze: 12.41 }],
    ['twinWings', '648e054e784739b182f9c3672ae06d5ecf9b87fad322c81e304abb22db213e5d', { author: 10.71, gold: 10.96, silver: 11.22, bronze: 11.53 }],
    ['splitJaw', '7d59b5e236ad341c69789d38966bf3fe178836df8214c66bcf62efd2845b920c', { author: 15.05, gold: 15.25, silver: 15.55, bronze: 15.95 }],
    ['stoneGate', '668459c6b959cd15d399adc296fd7db9e48c8a4e577d45e413997ba0e19f03f1', { author: 7.42, gold: 7.69, silver: 7.91, bronze: 8.23 }],
    ['crakowBoot', '336a804037d459ee6d50798326e989cd4adde3d10b9f419dd620341dee859276', { author: 11.2, gold: 11.45, silver: 11.75, bronze: 12.1 }],
    ['slingshotRun', 'cb3dc9d43fe62001e5b94afc625727201ee02fd69a8e0548660cc3b9338e7193', { author: 8.41, gold: 8.72, silver: 9.03, bronze: 9.34 }],
    ['brokenAntler', 'cbe788705ca5666450902b87e543404dc256ff975058353cbd276d70748f4da4', { author: 9.75, gold: 9.91, silver: 10.22, bronze: 10.53 }],
    ['mantisBend', '08f40e9823151e696374fea60429af0313dcccd65624a9a6331bdbc2a28f6c4e', { author: 10.82, gold: 10.99, silver: 11.35, bronze: 11.71 }],
    ['monkeyWrench', 'e73246072966192f4579e8189f14fbf4e6c68d432a2605a7cbdb2f6343bede07', { author: 12.35, gold: 12.61, silver: 12.89, bronze: 13.11 }],
];

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

function hashRaceShape(track) {
    return hashTrackRegistry(Object.fromEntries(
        ['outer', 'inner', 'startLine', 'startPos', 'startAngle', 'checkpoints', 'cornerRadius']
            .map((key) => [key, track[key]]),
    ));
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
            'budapestRun',
            'bucharestScramble',
            'babylonRace',
            'centralDistrict',
            'smallSteps',
            'lapinLoop',
            'mountainPass',
            'sharkTail',
            'hookBend',
            'windingLane',
            'grandSlam',
            'dirtyDancing',
            'greyHarbor',
            'endlessLoop',
            'crescentValley',
            'seaCharger',
            'gunSlinger',
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
        // Eight tracks got their first shapes back; four later ones are now Mountain Pass, Shark Tail,
        // Hook Bend and Winding Lane. Fingerprints below add restorations, additions and the v2.4.0 restorations.
        const reshapedKeys = new Set(['doubleTrouble', 'monkeyWrench', 'sharkBite']);
        const addedKeys = new Set(catalogKeys.slice(catalogKeys.indexOf('puzzlePiece')));
        const withoutReshapedOrAdded = Object.fromEntries(
            Object.entries(TRACKS)
                .filter(([trackKey]) => !reshapedKeys.has(trackKey) && !addedKeys.has(trackKey)),
        );
        expect(hashTrackRegistry(withoutReshapedOrAdded)).toBe(
            'ba83b613cc5241c66275ddf6aa273611429bed6c31162d56577455a25fac8b05',
        );
        const throughSharkBite = Object.fromEntries(
            Object.entries(TRACKS).filter(([trackKey]) => !addedKeys.has(trackKey)),
        );
        expect(hashTrackRegistry(throughSharkBite)).toBe(
            '744984e326e68fa08b1a0c3353a66425cfb3a1f261a17ca00c4e842f92180867',
        );
        // The unchanged subset, without current edits and the separately pinned restorations.
        // The registry hash pins the excluded Dirt Snake, Wild Crest (9a1214b9), Broken Road, Ridge Runner (78f10d49).
        const latestReshapedKeys = new Set([
            'dirtValley', 'smallSteps', 'lapinLoop', 'centralDistrict', 'roughCut', 'hillsideScramble',
            'dirtSnake', 'wildCrest', 'brokenRoad', 'ridgeRunner',
            ...V240_TRACK_CONTRACTS.map(([trackKey]) => trackKey),
        ]);
        const latestAddedKeys = new Set(['grandSlam', 'dirtyDancing', 'greyHarbor', 'endlessLoop', 'crescentValley', 'seaCharger']);
        const unchangedSinceWindingLane = Object.fromEntries(
            Object.entries(TRACKS)
                .filter(([trackKey]) => !latestReshapedKeys.has(trackKey) && !latestAddedKeys.has(trackKey)),
        );
        expect(hashTrackRegistry(unchangedSinceWindingLane)).toBe(
            '7edec9d084b1ff0ee26b203a64bb002913b0aa52ac6c3e233d90b551692b059b',
        );
    });

    it.each(V240_TRACK_CONTRACTS)('keeps %s identical to production v2.4.0', (trackKey, expectedHash, medalRow) => {
        expect(hashTrackRegistry(TRACKS[trackKey])).toBe(expectedHash);
        expect(MEDAL_TIMES[trackKey]).toEqual(medalRow);
    });

    it('restores Gun Slinger at its v2.4.0 Daily position and preserves Water Pistol', () => {
        const index = TRACK_SCHEDULE_KEYS.indexOf('gunSlinger');
        expect(index).toBe(88); // Daily position 89 in v2.4.0.
        expect(TRACK_SCHEDULE_KEYS.slice(index - 1, index + 2)).toEqual([
            'windingRoad', 'gunSlinger', 'lightningHook',
        ]);
        expect(TRACK_SCHEDULE_KEYS.at(-1)).toBe('waterPistol');
        expect(hashTrackRegistry(TRACK_SCHEDULE_KEYS.filter((key) => (
            key !== 'gunSlinger' && key !== 'waterPistol'
        )))).toBe('fd4c78dbd38136623dc7155358ed3dfac8e2bab002765b39a56413e099e6fba2');
        // Pin every existing track, including Water Pistol, before this restoration.
        expect(hashTrackRegistry(Object.fromEntries(Object.entries(TRACKS)
            .filter(([key]) => key !== 'gunSlinger')))).toBe(
            '40f62fd7f1ba367e32766512b877a4aa014ff7c572d2506507e087ad9d255f4f',
        );
        expect(hashTrackRegistry(TRACKS)).toBe(
            '31e461881c505623ee939b3aa7a479acbdb277494658608c6433f1b23e06e1e0',
        );
    });

    // Original shapes: 0feab0e0 for Mountain Peak and Shark Fin, 0239dc89 for the other six; old metadata ignored.
    it.each([
        ['mountainPeak', 'e2a304522363a745bb8cdc19ea4ae638b12c6892502c19706ddfef50938a41a8'],
        ['sharkFin', 'ca6129fa8ea9fef14c634f347aafabd38a0bb5783f3e2f36ec878d128089900b'],
        ['crookedArrow', '7a2b2f92f9aa04eff1bb079e4f73ae8d70b2c9c7d508d5453439a200679f5135'],
        ['doubleTrouble', 'e8338c8dbc3fcfa35e8c5f3c45f93c9bb4a14457054330011fa8a29df0925b90'],
        ['hookLoop', '2748aeecf20f2d8fdbb2ee741a3c95cda985182631063f2bee2c849aba309dbc'],
        ['lightningHook', 'ae7e01bbd8ac099abc67413af8fec503a8671fb96e2435e4167703aa7d019111'],
        ['twistedClover', '65754998770cdf02a7b91e90b26e8b72a73546a9ed524b4f4e5c0b23ddfcc0e6'],
        ['windingRoad', 'e4b53042c0a51954dd43ace17f69647092108ad4b295628d6f63037d4b6952ac'],
    ])('keeps %s restored to its original race shape', (trackKey, expectedHash) => {
        expect(hashRaceShape(TRACKS[trackKey])).toBe(expectedHash);
    });

    // Saved variants match the later layouts at 439c4d76, before restoration.
    it.each([
        ['mountainPass', 'e351d9ef5e15e6f38bb00e54a2f704095875c8b59c86326ca67c93ed84e486f8'],
        ['sharkTail', '0acdfa1b2ef08112f356a4a552b0c282141115fa209643a4d0c0c64960ab0e3f'],
        ['hookBend', '3b8888f3d931d7fdfe6ef8e89dd538e82a168961afc80fd8ce8f6a039b08fd42'],
        ['windingLane', '5222611f6201fd013ed0e0f9aa7d1242e8ef9d45a6fa69d23f920ee1b8016b6b'],
    ])('keeps %s as the preserved later race shape', (trackKey, expectedHash) => {
        expect(hashRaceShape(TRACKS[trackKey])).toBe(expectedHash);
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

    // Campaign menus read surfaces from the catalog, so it must match the track ground.
    it('names the same ground in the catalog and in the track definition', () => {
        Object.entries(TRACK_CATALOG).forEach(([trackKey, metadata]) => {
            expect(metadata.ground ?? DEFAULT_TRACK_GROUND_KEY, `${trackKey} catalog ground`)
                .toBe(TRACKS[trackKey]?.ground ?? DEFAULT_TRACK_GROUND_KEY);
            expect(metadata.ground, `${trackKey} catalog should omit the default ground`)
                .not.toBe(DEFAULT_TRACK_GROUND_KEY);
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
