import { describe, expect, it } from 'vitest';
import {
    buildPerpendicularLaneGate,
    closestPointOnPolygon,
    extendGatePastWalls,
    firstRayPolygonHit,
    GATE_WALL_OVERHANG,
} from '../tools/mapmaker/lane-gate.js';

const OUTER = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
];
const INNER = [
    { x: 2, y: 2 },
    { x: 8, y: 2 },
    { x: 8, y: 8 },
    { x: 2, y: 8 },
];

describe('Mapmaker perpendicular lane gates', () => {
    it('finds the closest point on a polygon edge', () => {
        const hit = closestPointOnPolygon({ x: 5, y: -1 }, OUTER);
        expect(hit.closest).toEqual({ x: 5, y: 0 });
        expect(hit.segmentIndex).toBe(0);
    });

    it('ray hits the first inner wall across a lane', () => {
        const hit = firstRayPolygonHit({ x: 5, y: 0 }, { x: 0, y: 1 }, INNER);
        expect(hit.point.x).toBeCloseTo(5, 3);
        expect(hit.point.y).toBeCloseTo(2, 3);
        expect(hit.along).toBeCloseTo(2, 3);
    });

    it('builds a short vertical gate across a horizontal outer wall', () => {
        const gate = buildPerpendicularLaneGate({ x: 5, y: 1 }, OUTER, INNER);
        expect(gate).not.toBeNull();
        expect(Math.abs(gate.p1.x - gate.p2.x)).toBeLessThan(0.001);
        expect(distanceLike(gate)).toBeCloseTo(2 + GATE_WALL_OVERHANG * 2, 3);
        expect(Math.min(gate.p1.y, gate.p2.y)).toBeCloseTo(-GATE_WALL_OVERHANG, 3);
        expect(Math.max(gate.p1.y, gate.p2.y)).toBeCloseTo(2 + GATE_WALL_OVERHANG, 3);
    });

    it('builds a short horizontal gate across a vertical outer wall', () => {
        const gate = buildPerpendicularLaneGate({ x: 9, y: 5 }, OUTER, INNER);
        expect(gate).not.toBeNull();
        expect(Math.abs(gate.p1.y - gate.p2.y)).toBeLessThan(0.001);
        expect(distanceLike(gate)).toBeCloseTo(2 + GATE_WALL_OVERHANG * 2, 3);
        expect(Math.min(gate.p1.x, gate.p2.x)).toBeCloseTo(8 - GATE_WALL_OVERHANG, 3);
        expect(Math.max(gate.p1.x, gate.p2.x)).toBeCloseTo(10 + GATE_WALL_OVERHANG, 3);
    });

    it('extends wall-to-wall gates past both walls', () => {
        const extended = extendGatePastWalls(
            { x: 5, y: 0 },
            { x: 5, y: 2 },
            0.75,
        );
        expect(extended.p1.y).toBeCloseTo(-0.75, 5);
        expect(extended.p2.y).toBeCloseTo(2.75, 5);
        expect(extended.p1.x).toBeCloseTo(5, 5);
        expect(extended.p2.x).toBeCloseTo(5, 5);
    });

    it('does not invent long diagonals between unrelated closest points', () => {
        const gate = buildPerpendicularLaneGate({ x: 1, y: 1 }, OUTER, INNER);
        expect(gate).not.toBeNull();
        expect(distanceLike(gate)).toBeLessThan(3.5 + GATE_WALL_OVERHANG * 2);
        const dx = Math.abs(gate.p1.x - gate.p2.x);
        const dy = Math.abs(gate.p1.y - gate.p2.y);
        expect(Math.min(dx, dy)).toBeLessThan(0.75);
    });

    it('slides around a corner without teleporting across the track', () => {
        const seeds = [
            { x: 5, y: 1 },
            { x: 8, y: 1 },
            { x: 9.2, y: 1 },
            { x: 9.5, y: 1.5 },
            { x: 9, y: 3 },
            { x: 9, y: 5 },
        ];
        let previousMid = null;
        seeds.forEach((seed) => {
            const gate = buildPerpendicularLaneGate(seed, OUTER, INNER, {
                previousMidpoint: previousMid,
            });
            expect(gate).not.toBeNull();
            const mid = {
                x: (gate.p1.x + gate.p2.x) / 2,
                y: (gate.p1.y + gate.p2.y) / 2,
            };
            expect(mid.x).toBeGreaterThan(4);
            expect(mid.y).toBeLessThan(6);
            if (previousMid) {
                const jump = Math.hypot(mid.x - previousMid.x, mid.y - previousMid.y);
                expect(jump).toBeLessThan(3.5);
            }
            previousMid = mid;
        });
    });

    it('returns null when walls are incomplete', () => {
        expect(buildPerpendicularLaneGate({ x: 5, y: 5 }, OUTER, [])).toBeNull();
    });
});

function distanceLike(gate) {
    return Math.hypot(gate.p1.x - gate.p2.x, gate.p1.y - gate.p2.y);
}
