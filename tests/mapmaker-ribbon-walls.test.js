import { describe, expect, it } from 'vitest';
import {
    buildRibbonWallsFromCenterline,
    filletCenterline,
    inflateTightBends,
} from '../tools/mapmaker/ribbon-walls.js';

/** Axis-aligned square centerline (CCW). */
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
