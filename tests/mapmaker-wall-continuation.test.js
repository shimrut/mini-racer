import { describe, expect, it } from 'vitest';
import { buildRibbonWallsFromCenterline } from '../tools/mapmaker/ribbon-walls.js';
import { cornerShot, wallContinuations } from '../tools/mapmaker/wall-continuation.js';

const CAR_WIDTH = 0.55;
const ROAD = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 0, y: 10 },
];
const HOLE = [
    { x: 0, y: 4 }, { x: 40, y: 4 }, { x: 40, y: 10 }, { x: 0, y: 10 },
];

describe('corner shots', () => {
    it('fits when the straight shot stays on the road', () => {
        const shot = cornerShot(ROAD, HOLE, { x: 5, y: 2 }, { x: 30, y: 2 }, CAR_WIDTH);
        expect(shot.fits).toBe(true);
        expect(shot.blocked).toBeNull();
        expect(shot.clear).toHaveLength(4);
    });

    it('turns red where the straight shot leaves the road', () => {
        const shot = cornerShot(ROAD, HOLE, { x: 5, y: 2 }, { x: 30, y: 8 }, CAR_WIDTH);
        expect(shot.fits).toBe(false);
        expect(shot.clear).toHaveLength(4);
        expect(shot.blocked).toHaveLength(4);
    });

    it('links the corners of a square with shots the car can drive', () => {
        const outer = [
            { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
        ];
        const inner = [
            { x: 4, y: 4 }, { x: 16, y: 4 }, { x: 16, y: 16 }, { x: 4, y: 16 },
        ];
        const shots = wallContinuations(outer, inner, CAR_WIDTH);
        expect(shots).toHaveLength(4);
        expect(shots.every((shot) => shot.fits)).toBe(true);
    });

    it('links a drawn square the same way', () => {
        const walls = buildRibbonWallsFromCenterline([
            { x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 14 }, { x: 0, y: 14 },
        ], 3.85 / 2);
        const shots = wallContinuations(walls.outer, walls.inner, CAR_WIDTH);
        expect(shots.length).toBe(4);
        expect(shots.every((shot) => shot.fits)).toBe(true);
    });
});
