import { describe, expect, it } from 'vitest';
import {
    buildRibbonWallsFromCenterline,
    filletCenterline,
} from '../tools/mapmaker/ribbon-walls.js';

/** Axis-aligned square centerline (CCW). */
const SQUARE = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
];

describe('buildRibbonWallsFromCenterline', () => {
    it('keeps lane width steady through a square corner', () => {
        const halfWidth = 2;
        const walls = buildRibbonWallsFromCenterline(SQUARE, halfWidth);
        expect(walls).not.toBeNull();

        // Bottom-left corner fillet center is at (2, 2) for R = halfWidth.
        const cornerCenter = { x: 2, y: 2 };
        const outerNearCorner = walls.outer.filter(
            (point) => distance(point, cornerCenter) < halfWidth * 2.2,
        );
        expect(outerNearCorner.length).toBeGreaterThanOrEqual(3);

        for (const point of outerNearCorner) {
            // Outer arc sits at 2 * halfWidth from the fillet center.
            expect(distance(point, cornerCenter)).toBeCloseTo(halfWidth * 2, 1);
        }

        // Inner collapses near the fillet center (apex).
        const innerNear = walls.inner
            .map((point) => distance(point, cornerCenter))
            .sort((a, b) => a - b)[0];
        expect(innerNear).toBeLessThan(0.15);

        // Straight bottom edge: outer at y=-2, inner apexes at y=2 → width 4.
        const outerBottom = walls.outer.find((point) => Math.abs(point.y + halfWidth) < 0.05 && point.x > 3 && point.x < 7)
            || walls.outer.find((point) => Math.abs(point.y + halfWidth) < 0.05);
        expect(outerBottom).toBeTruthy();
        expect(outerBottom.y).toBeCloseTo(-halfWidth, 1);
        const innerBottom = walls.inner.find((point) => Math.abs(point.y - halfWidth) < 0.05);
        expect(innerBottom).toBeTruthy();
        expect(innerBottom.y - outerBottom.y).toBeCloseTo(halfWidth * 2, 1);
    });

    it('fillets sharp corners before offsetting', () => {
        const samples = filletCenterline(SQUARE, 2);
        expect(samples.length).toBeGreaterThan(SQUARE.length);
    });

    it('keeps paired walls on a dense gentle ring', () => {
        const ring = [];
        const n = 48;
        for (let i = 0; i < n; i += 1) {
            const a = (Math.PI * 2 * i) / n;
            ring.push({ x: Math.cos(a) * 20, y: Math.sin(a) * 20 });
        }
        const walls = buildRibbonWallsFromCenterline(ring, 2);
        expect(walls).not.toBeNull();
        expect(walls.outer.length).toBeGreaterThanOrEqual(n - 2);
        expect(walls.inner.length).toBeGreaterThanOrEqual(n - 2);
        expect(Math.abs(walls.outer.length - walls.inner.length)).toBeLessThanOrEqual(2);
    });
});

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
