import { describe, expect, it } from 'vitest';
import { buildPerpendicularWallSpan } from '../tools/mapmaker/cross-track-snap.js';

const OUTER = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 0, y: 10 },
];

const INNER = [
    { x: 4, y: 3 },
    { x: 16, y: 3 },
    { x: 16, y: 7 },
    { x: 4, y: 7 },
];

describe('Mapmaker cross-track snap', () => {
    it('builds a wall-to-wall line perpendicular to the nearer wall', () => {
        const span = buildPerpendicularWallSpan({ x: 10, y: 0.2 }, OUTER, INNER);

        expect(span).not.toBeNull();
        expect(span.p1.y).toBeCloseTo(0, 5);
        expect(span.p2.y).toBeCloseTo(3, 5);
        expect(span.p1.x).toBeCloseTo(span.p2.x, 5);
    });

    it('keeps p1 on the outer wall and p2 on the inner wall', () => {
        const span = buildPerpendicularWallSpan({ x: 10, y: 6.8 }, OUTER, INNER);

        expect(span).not.toBeNull();
        expect(span.p1.y).toBeCloseTo(10, 5);
        expect(span.p2.y).toBeCloseTo(7, 5);
        expect(span.p1.x).toBeCloseTo(span.p2.x, 5);
    });

    it('returns null when walls are missing', () => {
        expect(buildPerpendicularWallSpan({ x: 1, y: 1 }, [], INNER)).toBeNull();
        expect(buildPerpendicularWallSpan({ x: 1, y: 1 }, OUTER, [])).toBeNull();
    });
});
