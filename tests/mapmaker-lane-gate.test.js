import { describe, expect, it } from 'vitest';
import {
    buildPerpendicularLaneGate,
    closestPointOnPolygon,
} from '../tools/mapmaker/lane-gate.js';

/** Axis-aligned rectangular lane: outer 0..10, inner 2..8. */
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

    it('builds a vertical gate across a horizontal outer wall', () => {
        const gate = buildPerpendicularLaneGate({ x: 5, y: 1 }, OUTER, INNER);
        expect(gate).not.toBeNull();
        // Across a bottom horizontal wall, the gate should be vertical.
        expect(Math.abs(gate.p1.x - gate.p2.x)).toBeLessThan(0.001);
        expect(Math.min(gate.p1.y, gate.p2.y)).toBeCloseTo(0, 3);
        expect(Math.max(gate.p1.y, gate.p2.y)).toBeCloseTo(2, 3);
    });

    it('builds a horizontal gate across a vertical outer wall', () => {
        const gate = buildPerpendicularLaneGate({ x: 9, y: 5 }, OUTER, INNER);
        expect(gate).not.toBeNull();
        expect(Math.abs(gate.p1.y - gate.p2.y)).toBeLessThan(0.001);
        expect(Math.min(gate.p1.x, gate.p2.x)).toBeCloseTo(8, 3);
        expect(Math.max(gate.p1.x, gate.p2.x)).toBeCloseTo(10, 3);
    });

    it('returns null when walls are incomplete', () => {
        expect(buildPerpendicularLaneGate({ x: 5, y: 5 }, OUTER, [])).toBeNull();
    });
});
