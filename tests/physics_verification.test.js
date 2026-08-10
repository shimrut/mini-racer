import { describe, it, expect } from 'vitest';
import { simulateStraightLine } from '../game/car/handling.js';

describe('Physics Realistic Model', () => {
    it('should reach ~94 km/h in 2 seconds with accel=50, maxSpeed=220', () => {
        const config = { accel: 50, maxSpeed: 220 };
        const targetSpeed = 93.6;
        const result = simulateStraightLine(config, { targetSpeed });
        expect(result.time).toBeCloseTo(2.0, 1);
    });

    it('should take ~2.15 seconds to reach 100 km/h with accel=50, maxSpeed=220', () => {
        const config = { accel: 50, maxSpeed: 220 };
        const targetSpeed = 100;
        const result = simulateStraightLine(config, { targetSpeed });
        expect(result.time).toBeCloseTo(2.15, 1);
    });

    it('should have independent max speed regardless of acceleration', () => {
        const config1 = { accel: 50, maxSpeed: 220 };
        const config2 = { accel: 150, maxSpeed: 220 };

        const res1 = simulateStraightLine(config1, { maxTime: 20 });
        const res2 = simulateStraightLine(config2, { maxTime: 20 });

        expect(res1.speed * 20).toBeGreaterThan(215);
        expect(res2.speed * 20).toBeGreaterThan(215);
        expect(res1.speed * 20).toBeLessThanOrEqual(220);
        expect(res2.speed * 20).toBeLessThanOrEqual(220);
    });

    it('should accelerate slower as speed increases (drag)', () => {
        const config = { accel: 50, maxSpeed: 220 };

        const v1 = simulateStraightLine(config, { maxTime: 1.0 }).speed;
        const v2 = simulateStraightLine(config, { maxTime: 2.0 }).speed;
        const v3 = simulateStraightLine(config, { maxTime: 3.0 }).speed;

        const dv1 = v1;
        const dv2 = v2 - v1;
        const dv3 = v3 - v2;

        expect(dv2).toBeLessThan(dv1);
        expect(dv3).toBeLessThan(dv2);
        console.log(`Acceleration decay: ${dv1.toFixed(3)} -> ${dv2.toFixed(3)} -> ${dv3.toFixed(3)}`);
    });
});
