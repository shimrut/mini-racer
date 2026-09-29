import { describe, expect, it } from 'vitest';
import { CONFIG } from '../game/config.js';
import { distance } from '../tools/geometry.js';
import { CAR_LENGTH, snapLineBuildPoint } from '../tools/mapmaker/line-build.js';

describe('Line Build car-length snap', () => {
    it('uses the ghost car length', () => {
        expect(CAR_LENGTH).toBe((CONFIG.carCollisionHalfLength + CONFIG.carRadius) * 2);
        expect(CAR_LENGTH).toBeCloseTo(1.23, 5);
    });

    it('keeps the first click where it lands', () => {
        expect(snapLineBuildPoint(null, { x: 4, y: -2 })).toEqual({ x: 4, y: -2 });
    });

    it('ignores a click closer than half a car length', () => {
        const from = { x: 0, y: 0 };
        expect(snapLineBuildPoint(from, { x: CAR_LENGTH * 0.49, y: 0 })).toBeNull();
        expect(snapLineBuildPoint(from, from)).toBeNull();
    });

    it('lands on the nearest whole car length', () => {
        const from = { x: 1, y: 2 };
        const one = snapLineBuildPoint(from, { x: 1 + CAR_LENGTH * 1.4, y: 2 });
        const two = snapLineBuildPoint(from, { x: 1 + CAR_LENGTH * 1.6, y: 2 });
        expect(one).toEqual({ x: 1 + CAR_LENGTH, y: 2 });
        expect(two).toEqual({ x: 1 + CAR_LENGTH * 2, y: 2 });
        expect(distance(from, two)).toBeCloseTo(CAR_LENGTH * 2, 8);
    });

    it('keeps the pointer direction on a diagonal', () => {
        const from = { x: 0, y: 0 };
        const snapped = snapLineBuildPoint(from, { x: 3, y: 3 });
        expect(snapped.x).toBeCloseTo(snapped.y, 8);
        expect(distance(from, snapped)).toBeCloseTo(CAR_LENGTH * 3, 8);
    });
});
