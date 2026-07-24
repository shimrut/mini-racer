import { describe, expect, it } from 'vitest';
import {
    getStartLineAxis,
    pickStartHeading,
    snapStartPose,
} from '../tools/mapmaker/start-pose.js';

describe('Mapmaker start pose', () => {
    const verticalStartLine = {
        p1: { x: 10, y: 0 },
        p2: { x: 10, y: 6 },
    };

    it('builds an across/forward axis for the start line', () => {
        const axis = getStartLineAxis(verticalStartLine);
        expect(axis.mid).toEqual({ x: 10, y: 3 });
        expect(Math.abs(axis.across.x)).toBeLessThan(0.001);
        expect(Math.abs(Math.abs(axis.across.y) - 1)).toBeLessThan(0.001);
    });

    it('picks the perpendicular heading closest to the preferred angle', () => {
        const axis = getStartLineAxis(verticalStartLine);
        expect(pickStartHeading(axis, 0)).toBeCloseTo(0, 5);
        expect(Math.abs(pickStartHeading(axis, Math.PI))).toBeCloseTo(Math.PI, 5);
    });

    it('faces the start line when the seed is on the left', () => {
        const pose = snapStartPose({ x: 7, y: 4 }, verticalStartLine);
        expect(pose).not.toBeNull();
        // Nose points toward +X (the line), not away from it.
        expect(pose.startAngle).toBeCloseTo(0, 5);
        expect(pose.startPos.x).toBeLessThan(10);
        expect(pose.startPos.y).toBeCloseTo(3, 5);
        expect(pose.along).toBeLessThan(0);
    });

    it('faces the start line when the seed is on the right', () => {
        const pose = snapStartPose({ x: 13, y: 4 }, verticalStartLine);
        expect(pose).not.toBeNull();
        expect(Math.abs(pose.startAngle)).toBeCloseTo(Math.PI, 5);
        expect(pose.startPos.x).toBeGreaterThan(10);
        expect(pose.along).toBeLessThan(0);
    });

    it('keeps a minimum standoff behind the gate', () => {
        const pose = snapStartPose({ x: 10, y: 3 }, verticalStartLine, {
            preferredAngle: 0,
        });
        expect(Math.abs(pose.startPos.x - 10)).toBeCloseTo(1, 5);
        expect(pose.startPos.y).toBeCloseTo(3, 5);
        expect(pose.along).toBeCloseTo(-1, 5);
    });
});
