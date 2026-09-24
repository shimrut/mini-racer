import { describe, expect, it } from 'vitest';
import { DRAWN_CAR_DESIGN, DrawnCar, mergeDesign } from '../game/car/drawn-car.js';

const FRAME = 1 / 60;
const FULL_LOCK = (DRAWN_CAR_DESIGN.steering.maxAngleDeg * Math.PI) / 180;

function drive(car, frames, state) {
    for (let i = 0; i < frames; i += 1) {
        car.update(FRAME, typeof state === 'function' ? state(i) : state);
    }
}

describe('drawn car steering', () => {
    it('turns the front wheels to full lock and back', () => {
        const car = new DrawnCar();
        drive(car, 30, { steer: 1 });
        expect(car.steerAngle).toBeCloseTo(FULL_LOCK, 3);
        drive(car, 30, { steer: -1 });
        expect(car.steerAngle).toBeCloseTo(-FULL_LOCK, 3);
        drive(car, 30, { steer: 0 });
        expect(Math.abs(car.steerAngle)).toBeLessThan(0.001);
    });

    it('does not move when the frame time is 0', () => {
        const car = new DrawnCar();
        car.update(0, { steer: 1, speedPx: 600, speedKph: 300 });
        expect(car.steerAngle).toBe(0);
        expect(car.treadOffset).toBe(0);
        expect(car.lastSpeedKph).toBeNull();
    });
});

describe('drawn car treads', () => {
    it('rolls the treads by the distance the car moves at low speed', () => {
        const car = new DrawnCar();
        // 3 px/s on a 55 px box is 6 car units per second.
        car.update(FRAME, { speedPx: 3, size: 55 });
        expect(car.treadOffset).toBeCloseTo(0.1, 6);
    });

    it('limits the tread step at high speed, so the wheel never looks like it turns backward', () => {
        const car = new DrawnCar();
        const { spacing, maxStepPerFrame } = DRAWN_CAR_DESIGN.treads;
        car.update(FRAME, { speedPx: 620, size: 52 });
        expect(car.treadOffset).toBeCloseTo(spacing * maxStepPerFrame, 6);
        drive(car, 30, { speedPx: 620, size: 52 });
        expect(car.treadBlur).toBeGreaterThan(0.95);
    });
});

describe('drawn car brake lights', () => {
    it('stays dark when the car keeps its speed or goes faster', () => {
        const car = new DrawnCar();
        drive(car, 60, (i) => ({ speedKph: 100 + i * 5 }));
        drive(car, 60, { speedKph: 310 });
        expect(car.brake).toBe(0);
    });

    it('lights up when the car loses speed quickly, then goes dark again', () => {
        const car = new DrawnCar();
        drive(car, 10, { speedKph: 300 });
        // 150 km/h per second, as in a hard turn at top speed.
        drive(car, 12, (i) => ({ speedKph: 300 - (i + 1) * 2.5 }));
        expect(car.brake).toBe(1);
        drive(car, 30, { speedKph: 270 });
        expect(car.brake).toBe(0);
    });

    it('ignores a small loss of speed', () => {
        const car = new DrawnCar();
        drive(car, 10, { speedKph: 300 });
        // 30 km/h per second, as when a long turn settles.
        drive(car, 30, (i) => ({ speedKph: 300 - (i + 1) * 0.5 }));
        expect(car.brake).toBe(0);
    });

    it('holds the lights on at once on the start grid', () => {
        const car = new DrawnCar();
        car.update(0.1, { holding: true });
        expect(car.brake).toBe(1);
    });

    it('does not light up for the speed drop of a reset', () => {
        const car = new DrawnCar();
        drive(car, 10, { speedKph: 300 });
        car.resetMotion();
        car.update(FRAME, { speedKph: 0 });
        expect(car.brake).toBe(0);
    });
});

describe('drawn car design', () => {
    it('keeps every value that a change does not give', () => {
        const design = mergeDesign(DRAWN_CAR_DESIGN, { colors: { paint: '#1e6fe8' }, steering: { maxAngleDeg: 30 } });
        expect(design.colors.paint).toBe('#1e6fe8');
        expect(design.colors.stripe).toBe(DRAWN_CAR_DESIGN.colors.stripe);
        expect(design.steering.maxAngleDeg).toBe(30);
        expect(design.steering.responseSec).toBe(DRAWN_CAR_DESIGN.steering.responseSec);
        expect(design.body.points).toBe(DRAWN_CAR_DESIGN.body.points);
        expect(Object.isFrozen(design.colors)).toBe(true);
    });

    it('has no picture when there is no canvas, and does not fail', () => {
        const car = new DrawnCar();
        expect(car.sprite).toBeNull();
        expect(() => car.draw({ drawImage() {} }, 52)).not.toThrow();
    });
});
