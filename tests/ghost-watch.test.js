import { describe, expect, it } from 'vitest';
import {
    formatGhostWatchClock,
    getGhostWatchMotion,
    getGhostWatchTrailPoints,
} from '../game/ghost/ghost-watch.js';

function straightSamples({ speed = 10, count = 41, intervalMs = 50 } = {}) {
    return Array.from({ length: count }, (_, index) => ({
        timeMs: index * intervalMs,
        x: speed * (index * intervalMs) / 1000,
        y: 0,
        angle: 0,
    }));
}

describe('ghost watch motion', () => {
    it('reads the speed and the direction from the ghost points', () => {
        const motion = getGhostWatchMotion(straightSamples({ speed: 10 }), 1000);
        expect(motion.x).toBeCloseTo(10);
        expect(motion.velocity.x).toBeCloseTo(10);
        expect(motion.velocity.y).toBeCloseTo(0);
        expect(motion.speed).toBeCloseTo(10);
        expect(motion.steer).toBeCloseTo(0);
    });

    it('turns the heading change into steering against the turn rate', () => {
        const samples = straightSamples().map((sample) => ({
            ...sample,
            angle: 2 * sample.timeMs / 1000,
        }));
        expect(getGhostWatchMotion(samples, 1000, { turnRate: 4 }).steer).toBeCloseTo(0.5);
        expect(getGhostWatchMotion(samples, 1000, { turnRate: 1 }).steer).toBe(1);
        const left = samples.map((sample) => ({ ...sample, angle: -sample.angle }));
        expect(getGhostWatchMotion(left, 1000, { turnRate: 4 }).steer).toBeCloseTo(-0.5);
    });

    it('keeps a speed at the start and holds the last pose after the finish', () => {
        const samples = straightSamples({ speed: 10 });
        expect(getGhostWatchMotion(samples, 0).speed).toBeCloseTo(10);
        const end = getGhostWatchMotion(samples, 5000);
        expect(end.x).toBeCloseTo(20);
        expect(end.speed).toBe(0);
    });

    it('has no motion for a ghost without points', () => {
        expect(getGhostWatchMotion([], 0)).toBe(null);
    });

    it('draws the trail from the start to the car, at the rear axle', () => {
        const samples = straightSamples({ speed: 10 });
        const config = { carRearAxleOffset: 0.5 };
        expect(getGhostWatchTrailPoints(samples, 0, config)).toEqual([{ x: -0.5, y: 0 }]);
        const points = getGhostWatchTrailPoints(samples, 125, config);
        expect(points.map((point) => point.x)).toEqual([-0.5, 0, 0.5, 0.75]);
        expect(getGhostWatchTrailPoints(samples, 99_999, config)).toHaveLength(samples.length + 1);
        expect(getGhostWatchTrailPoints([], 100, config)).toEqual([]);
    });

    it('shows the clock as the race HUD does', () => {
        expect(formatGhostWatchClock(0)).toBe('0.000');
        expect(formatGhostWatchClock(12_345.4)).toBe('12.345');
        expect(formatGhostWatchClock(-5)).toBe('0.000');
    });
});
