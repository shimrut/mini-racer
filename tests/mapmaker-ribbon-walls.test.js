import { describe, expect, it } from 'vitest';
import { smoothPoly } from '../game/track/runtime.js';
import {
    buildRibbonWallsFromCenterline,
    filletCenterline,
    findCornerWallGroups,
    fitCurvesToCorners,
    inflateTightBends,
} from '../tools/mapmaker/ribbon-walls.js';

const SQUARE = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
];

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function makeLoopWithTightCorner(tightRadius) {
    const points = [];
    for (let x = 0; x <= 40; x += 2) {
        points.push({ x, y: 0 });
    }
    for (let i = 0; i <= 12; i += 1) {
        const a = -Math.PI / 2 + (Math.PI / 2) * (i / 12);
        points.push({
            x: 40 + Math.cos(a) * tightRadius,
            y: tightRadius + Math.sin(a) * tightRadius,
        });
    }
    for (let y = 4; y <= 30; y += 2) {
        points.push({ x: 40 + tightRadius, y });
    }
    for (let x = 40; x >= 0; x -= 2) {
        points.push({ x, y: 30 });
    }
    for (let y = 30; y >= 0; y -= 2) {
        points.push({ x: 0, y });
    }
    return points;
}

describe('buildRibbonWallsFromCenterline', () => {
    it('keeps lane width steady through a square corner', () => {
        const halfWidth = 2;
        const walls = buildRibbonWallsFromCenterline(SQUARE, halfWidth);
        expect(walls).not.toBeNull();

        const cornerCenter = { x: 2, y: 2 };
        const outerNearCorner = walls.outer.filter(
            (point) => distance(point, cornerCenter) < halfWidth * 2.2,
        );
        expect(outerNearCorner.length).toBeGreaterThanOrEqual(3);
        for (const point of outerNearCorner) {
            expect(distance(point, cornerCenter)).toBeCloseTo(halfWidth * 2, 0);
        }

        const innerNear = walls.inner
            .map((point) => distance(point, cornerCenter))
            .sort((a, b) => a - b)[0];
        expect(innerNear).toBeLessThan(0.2);
    });

    it('inflates a freehand corner tighter than half width and keeps walls simple', () => {
        const halfWidth = 2;
        const centerline = makeLoopWithTightCorner(0.7);
        const inflated = inflateTightBends(centerline, halfWidth);
        const minLocal = inflated.reduce((best, point, index, arr) => {
            const prev = arr[(index - 1 + arr.length) % arr.length];
            const next = arr[(index + 1) % arr.length];
            const a = distance(point, next);
            const b = distance(prev, next);
            const c = distance(prev, point);
            const area2 = Math.abs(
                (point.x - prev.x) * (next.y - prev.y) - (point.y - prev.y) * (next.x - prev.x),
            );
            if (area2 < 1e-8) {
                return best;
            }
            return Math.min(best, (a * b * c) / area2);
        }, Infinity);
        expect(minLocal).toBeGreaterThanOrEqual(halfWidth * 0.9);

        const walls = buildRibbonWallsFromCenterline(centerline, halfWidth);
        expect(walls).not.toBeNull();
        expect(walls.inner.length).toBeGreaterThanOrEqual(3);
        expect(walls.outer.length).toBeGreaterThanOrEqual(3);
    });

    it('fillets sharp corners before offsetting', () => {
        const samples = filletCenterline(SQUARE, 2);
        expect(samples.length).toBeGreaterThan(SQUARE.length);
    });

    it('can fillet one corner wider than the others', () => {
        const tight = filletCenterline(SQUARE, [2, 2, 2, 2]);
        const open = filletCenterline(SQUARE, [2, 4, 2, 2]);
        const origin = { x: 10, y: 0 };
        const nearestTight = Math.min(...tight.map((sample) => distance(sample.point, origin)));
        const nearestOpen = Math.min(...open.map((sample) => distance(sample.point, origin)));
        expect(nearestOpen).toBeGreaterThan(nearestTight);
    });
});

const ROAD_WIDTH = 3.85;
const L_SHAPE = [
    { x: 0, y: 0 },
    { x: 24.6, y: 0 },
    { x: 24.6, y: 12.3 },
    { x: 12.3, y: 12.3 },
    { x: 12.3, y: 24.6 },
    { x: 0, y: 24.6 },
];

function distanceToLoop(point, loop) {
    return Math.min(...loop.map((start, index) => {
        const end = loop[(index + 1) % loop.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) {
            return distance(point, start);
        }
        const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
        return distance(point, { x: start.x + dx * t, y: start.y + dy * t });
    }));
}

function widestRaceRoad(walls, cornerRadius) {
    const outer = smoothPoly(walls.outer, cornerRadius);
    const inner = smoothPoly(walls.inner, cornerRadius);
    return Math.max(
        ...outer.map((point) => distanceToLoop(point, inner)),
        ...inner.map((point) => distanceToLoop(point, outer)),
    );
}

describe('fitCurvesToCorners', () => {
    const drawn = buildRibbonWallsFromCenterline(L_SHAPE, ROAD_WIDTH / 2);

    it('keeps the race road one width wide through rounded corners', () => {
        expect(widestRaceRoad(drawn, 5)).toBeGreaterThan(ROAD_WIDTH * 1.3);
        for (const cornerRadius of [0, 1.5, 3, 5]) {
            const fitted = fitCurvesToCorners(drawn.outer, drawn.inner, cornerRadius, ROAD_WIDTH);
            expect(widestRaceRoad(fitted, cornerRadius)).toBeLessThan(ROAD_WIDTH * 1.02);
        }
    });

    it('uses more curve points for rounder corners', () => {
        const counts = [0, 1.5, 3, 5].map((cornerRadius) => {
            const fitted = fitCurvesToCorners(drawn.outer, drawn.inner, cornerRadius, ROAD_WIDTH);
            return fitted.outer.length + fitted.inner.length;
        });
        expect(counts[0]).toBe(drawn.outer.length + drawn.inner.length);
        expect(counts[1]).toBeGreaterThan(counts[0]);
        expect(counts[3]).toBeGreaterThan(counts[1]);
    });

    it('returns to the same walls when a setting is chosen again', () => {
        const sharp = fitCurvesToCorners(drawn.outer, drawn.inner, 0, ROAD_WIDTH);
        let walls = drawn;
        for (const cornerRadius of [5, 1.5, 3, 0]) {
            walls = fitCurvesToCorners(walls.outer, walls.inner, cornerRadius, ROAD_WIDTH);
        }
        for (const path of ['outer', 'inner']) {
            expect(walls[path]).toHaveLength(drawn[path].length);
            walls[path].forEach((point, index) => {
                expect(distance(point, drawn[path][index])).toBeLessThan(1e-9);
                expect(distance(point, sharp[path][index])).toBeLessThan(1e-9);
            });
        }
    });

    it('leaves hand-shaped curves alone', () => {
        const outer = drawn.outer.map((point) => ({ x: point.x + 0.3, y: point.y + 0.2 }));
        const fitted = fitCurvesToCorners(outer, drawn.inner, 5, ROAD_WIDTH);
        expect(fitted.outer).toEqual(outer);
        expect(fitted.inner).toEqual(drawn.inner);
    });

    it('refits one Draw curve to its local wall-corner radius', () => {
        const local = {
            outer: drawn.outer.map((point) => ({ ...point })),
            inner: drawn.inner.map((point) => ({ ...point })),
        };
        const group = findCornerWallGroups(local.outer, local.inner, ROAD_WIDTH)[0];
        local[group.pivot.path][group.pivot.index].cornerRadius = 5;
        const fitted = fitCurvesToCorners(local.outer, local.inner, 3, ROAD_WIDTH);
        const uniform = fitCurvesToCorners(drawn.outer, drawn.inner, 3, ROAD_WIDTH);
        expect(fitted[group.facing.path]).not.toEqual(uniform[group.facing.path]);
        expect(widestRaceRoad(fitted, 3)).toBeLessThan(ROAD_WIDTH * 1.02);
    });
});
