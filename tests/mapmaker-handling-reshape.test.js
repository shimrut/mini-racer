import { describe, expect, it } from 'vitest';
import { CONFIG } from '../game/config.js';
import { DEFAULT_PHYSICS_TUNING, KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import {
    estimateArrivalSpeeds,
    lockRadiusAtSpeed,
    reshapeLoopForHandling,
    speedAfterDistance,
    speedForLockRadius,
} from '../tools/mapmaker/handling-reshape.js';
import { buildRibbonWallsFromCenterline } from '../tools/mapmaker/ribbon-walls.js';

const TRACK_WIDTH = 7 * CONFIG.carRadius * 2;

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function square(side) {
    return [
        { x: 0, y: 0 },
        { x: side, y: 0 },
        { x: side, y: side },
        { x: 0, y: side },
    ];
}

function chicaneLoop() {
    return [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 2.2 },
        { x: 11, y: 2.2 },
        { x: 11, y: 14 },
        { x: 0, y: 14 },
    ];
}

describe('handling reshape', () => {
    it('matches the car lock radius at 200 kph', () => {
        const speed = 200 / KPH_PER_WORLD_UNIT;
        expect(lockRadiusAtSpeed(speed, DEFAULT_PHYSICS_TUNING)).toBeCloseTo(2.71, 1);
        expect(speedForLockRadius(2.71, DEFAULT_PHYSICS_TUNING) * KPH_PER_WORLD_UNIT).toBeCloseTo(200, 0);
    });

    it('reaches about 200 kph after 3.4u from a standstill', () => {
        const speed = speedAfterDistance(0, 3.4, DEFAULT_PHYSICS_TUNING);
        expect(speed * KPH_PER_WORLD_UNIT).toBeGreaterThan(190);
        expect(speed * KPH_PER_WORLD_UNIT).toBeLessThan(215);
    });

    it('arrives faster after a long run-in than a short one', () => {
        const shortArrival = estimateArrivalSpeeds(square(3), TRACK_WIDTH).arrivals[1];
        const longArrival = estimateArrivalSpeeds(square(20), TRACK_WIDTH).arrivals[1];
        expect(longArrival).toBeGreaterThan(shortArrival);
        const long = reshapeLoopForHandling(square(20), TRACK_WIDTH);
        expect(long.filletRadii[1]).toBeGreaterThan(TRACK_WIDTH / 2);
    });

    it('lengthens a short sharp inbound so arrival is no longer a crawl', () => {
        const source = square(2.2);
        const reshaped = reshapeLoopForHandling(source, TRACK_WIDTH);
        const inbound = distance(reshaped.points[0], reshaped.points[1]);
        expect(inbound).toBeGreaterThan(distance(source[0], source[1]));
        const { arrivals } = estimateArrivalSpeeds(reshaped.points, TRACK_WIDTH);
        expect(arrivals[1] * KPH_PER_WORLD_UNIT).toBeGreaterThan(170);
    });

    it('eases a tight opposite pair that would not fit in the lane', () => {
        const source = chicaneLoop();
        const before = estimateArrivalSpeeds(source, TRACK_WIDTH).turns;
        const reshaped = reshapeLoopForHandling(source, TRACK_WIDTH);
        const after = estimateArrivalSpeeds(reshaped.points, TRACK_WIDTH).turns;
        expect(Math.abs(after[1].turnAngle) + Math.abs(after[2].turnAngle))
            .toBeLessThan(Math.abs(before[1].turnAngle) + Math.abs(before[2].turnAngle));
    });

    it('still builds a constant-width ribbon after reshape', () => {
        const { points, filletRadii } = reshapeLoopForHandling(square(8), TRACK_WIDTH);
        const walls = buildRibbonWallsFromCenterline(points, TRACK_WIDTH / 2, filletRadii);
        expect(walls).not.toBeNull();
        expect(walls.inner.length).toBeGreaterThanOrEqual(3);
        expect(walls.outer.length).toBeGreaterThanOrEqual(3);
    });
});
