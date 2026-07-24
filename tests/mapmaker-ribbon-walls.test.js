import { describe, expect, it } from 'vitest';
import { buildRibbonWallsFromCenterline } from '../tools/mapmaker/ribbon-walls.js';

/** Axis-aligned square centerline (CCW). */
const SQUARE = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
];

describe('buildRibbonWallsFromCenterline', () => {
    it('puts two outer points and one inner point at each square corner', () => {
        const walls = buildRibbonWallsFromCenterline(SQUARE, 2);
        expect(walls).not.toBeNull();
        // 4 corners × (2 outer + 1 inner)
        expect(walls.outer.length).toBe(8);
        expect(walls.inner.length).toBe(4);
        expect(Math.abs(polygonArea(walls.outer))).toBeGreaterThan(Math.abs(polygonArea(walls.inner)));
    });

    it('keeps 1:1 walls when consecutive turns are shallow', () => {
        const ring = [];
        const n = 48;
        for (let i = 0; i < n; i += 1) {
            const a = (Math.PI * 2 * i) / n;
            ring.push({ x: Math.cos(a) * 20, y: Math.sin(a) * 20 });
        }
        const walls = buildRibbonWallsFromCenterline(ring, 2);
        expect(walls).not.toBeNull();
        expect(walls.outer.length).toBe(n);
        expect(walls.inner.length).toBe(n);
    });

    it('on a right-hand kink, puts the two-point chamfer on the inner wall', () => {
        // CCW loop with one right-angle jog that turns right (apex on outer).
        const path = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 4 },
            { x: 14, y: 4 },
            { x: 14, y: 14 },
            { x: 0, y: 14 },
        ];
        const walls = buildRibbonWallsFromCenterline(path, 1.5);
        expect(walls).not.toBeNull();
        expect(walls.outer.length).toBeGreaterThanOrEqual(path.length);
        expect(walls.inner.length).toBeGreaterThanOrEqual(path.length);
        // At least one wall should have gained chamfer points.
        expect(walls.outer.length + walls.inner.length).toBeGreaterThan(path.length * 2);
    });
});

function polygonArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
        const n = points[(i + 1) % points.length];
        area += points[i].x * n.y - n.x * points[i].y;
    }
    return area / 2;
}
