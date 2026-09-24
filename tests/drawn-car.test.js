import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { DrawnCar } from '../game/car/drawn-car.js';
import { FORMULA_CAR } from '../game/car/drawn-car/formula.js';
import { paintTones } from '../game/car/drawn-car/paint.js';

const FRAME = 1 / 60;
const FULL_LOCK = (FORMULA_CAR.steering.maxAngleDeg * Math.PI) / 180;

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
        expect(car.roll).toBe(0);
        expect(car.lastSpeedKph).toBeNull();
    });
});

describe('drawn car tires', () => {
    it('rolls the tires by the distance the car moves at low speed', () => {
        const car = new DrawnCar();
        // 3 px/s on a 55 px box is 6 car units per second.
        car.update(FRAME, { speedPx: 3, size: 55 });
        expect(car.roll).toBeCloseTo(0.1, 6);
    });

    it('limits the roll step at high speed, so the wheel never looks like it turns backward', () => {
        const car = new DrawnCar();
        car.update(FRAME, { speedPx: 620, size: 52 });
        expect(car.roll).toBeCloseTo(FORMULA_CAR.wheelSpin.maxStepPerFrame, 6);
        drive(car, 30, { speedPx: 620, size: 52 });
        expect(car.rollBlur).toBeGreaterThan(0.95);
    });
});

describe('drawn car brake light', () => {
    it('stays dark when the car keeps its speed or goes faster', () => {
        const car = new DrawnCar();
        drive(car, 60, (i) => ({ speedKph: 100 + i * 5 }));
        drive(car, 60, { speedKph: 310 });
        expect(car.brake).toBe(0);
    });

    it('comes on when the car loses speed quickly, then goes dark again', () => {
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

    it('comes on at once on the start grid', () => {
        const car = new DrawnCar();
        car.update(0.1, { holding: true });
        expect(car.brake).toBe(1);
    });

    it('does not come on for the speed drop of a reset', () => {
        const car = new DrawnCar();
        drive(car, 10, { speedKph: 300 });
        car.resetMotion();
        car.update(FRAME, { speedKph: 0 });
        expect(car.brake).toBe(0);
    });
});

describe('drawn car parts and skins', () => {
    const ids = (car) => car.placements.map((placement) => placement.id);

    it('draws a mirrored part on the two sides and only the front tires and their hubs steer', () => {
        const car = new DrawnCar();
        expect(ids(car).filter((id) => id === 'frontWing')).toHaveLength(2);
        expect(car.placements.filter((placement) => placement.steers).map((placement) => placement.id))
            .toEqual(['frontTire', 'frontTire', 'frontHub', 'frontHub']);
    });

    it('turns each front tire and its hub in place, on the center of the tire', () => {
        const car = new DrawnCar();
        for (const placement of car.placements.filter((p) => p.steers)) {
            expect(placement.pivot).toEqual([0, 0]);
        }
    });

    it('lets a skin change the livery, the paint of an area, the material of one part, and hide a part', () => {
        const car = new DrawnCar(FORMULA_CAR, {
            livery: { main: '#1e6fe8' },
            decals: { rearWingEnds: 'accent', frontWingTips: '#00ff00' },
            parts: {
                gearbox: { colors: { frame: '#ffffff' } },
                noseStripe: { hidden: true },
            },
        });
        const byId = (id) => car.placements.find((placement) => placement.id === id);
        const paint = byId('body').paint;
        expect(paint('body', 'main').base).toBe('#1e6fe8');
        expect(paint('rearWingEnds').base).toBe(FORMULA_CAR.livery.accent);
        expect(paint('frontWingTips').base).toBe('#00ff00');
        expect(paint('centerStripe')).toBeNull();
        expect(byId('gearbox').colors.frame).toBe('#ffffff');
        expect(byId('rearWing').colors.frame).toBe(FORMULA_CAR.colors.frame);
        expect(byId('noseStripe')).toBeUndefined();
    });

    it('uses the default paint when a skin names a color that does not exist', () => {
        const car = new DrawnCar(FORMULA_CAR, { decals: { rearWing: 'acent', rearWingEnds: 'acent' } });
        const paint = car.placements[0].paint;
        expect(paint('rearWing', 'main').base).toBe(FORMULA_CAR.livery.main.base);
        expect(paint('rearWingEnds')).toBeNull();
    });

    it('makes the shadow, deep shadow and highlight tones from one color', () => {
        expect(paintTones('#ff0000')).toEqual({ base: '#ff0000', shade: '#b80000', deep: '#990000', light: '#ff3838' });
        expect(paintTones({ base: '#ff0000', shade: '#123456' }).shade).toBe('#123456');
        expect(paintTones('red')).toBeNull();
    });

    it('keeps the parts that do not move together, and draws each moving part alone', () => {
        const car = new DrawnCar();
        for (const run of car.runs) {
            if (!run.still) expect(run.placements).toHaveLength(1);
        }
        expect(car.runs.filter((run) => run.still).length).toBeLessThan(car.placements.length / 2);
    });

    it('has no picture when there is no canvas, and does not fail', () => {
        const car = new DrawnCar();
        expect(car.sprite).toBeNull();
        expect(() => car.draw({ drawImage() {} }, 52)).not.toThrow();
    });
});

describe('drawn car pictures', () => {
    const PPU = 4;
    let savedDocument;

    beforeAll(() => {
        savedDocument = globalThis.document;
        globalThis.document = { createElement: () => createCanvas(1, 1) };
    });

    afterAll(() => {
        globalThis.document = savedDocument;
    });

    // The color of the car picture at a point in car units.
    function pixel(canvas, x, y) {
        const center = canvas.width / 2;
        const data = canvas.getContext('2d').getImageData(Math.round(center + x * PPU), Math.round(center + y * PPU), 1, 1).data;
        return { r: data[0], g: data[1], b: data[2], a: data[3] };
    }

    it('paints each decal area with the color that the skin gives it', () => {
        const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        const plain = new DrawnCar(FORMULA_CAR, {}, { pixelsPerUnit: PPU });
        const skinned = new DrawnCar(FORMULA_CAR, {
            livery: { main: '#1e6fe8', accent: '#ff6a00', tertiary: '#b6ff3a' },
            decals: { rearWingEnds: 'accent', frontWingTips: '#00ff00', sidePodStripes: 'tertiary', noseStripe: null },
        }, { pixelsPerUnit: PPU });
        const rearWingEnd = [-45, -15.5];
        const frontWingTip = [40, -17];
        const sidePod = [-3, -15.6];
        const noseStripe = [36.5, 0];

        expect(hex(pixel(plain.sprite, ...rearWingEnd))).toBe(FORMULA_CAR.livery.main.base);
        expect(hex(pixel(plain.sprite, ...noseStripe))).toBe(FORMULA_CAR.livery.accent);

        expect(hex(pixel(skinned.sprite, ...rearWingEnd))).toBe('#ff6a00');
        expect(hex(pixel(skinned.sprite, ...frontWingTip))).toBe('#00ff00');
        expect(hex(pixel(skinned.sprite, ...sidePod))).toBe('#b6ff3a');
        expect(hex(pixel(skinned.sprite, ...noseStripe))).toBe('#1e6fe8');
    });

    it('shows the brake light dark at rest and bright red when the car brakes', () => {
        const car = new DrawnCar(FORMULA_CAR, {}, { pixelsPerUnit: PPU });
        const behindWing = [-51.6, 0];
        expect(pixel(car.sprite, ...behindWing).r).toBeLessThan(140);

        car.update(0.1, { holding: true });
        const lit = pixel(car.renderFrame(), ...behindWing);
        expect(lit.r).toBeGreaterThan(220);
    });

    it('turns the front tire in place: its center stays and its outer edge swings', () => {
        const width = FORMULA_CAR.parts.find((part) => part.id === 'frontTire').settings.width;
        const probe = [];
        const recorder = {
            moves: true,
            defaults: {},
            draw(ctx) {
                // A point of the part, in car units from the car center.
                const m = ctx.getTransform();
                const half = FORMULA_CAR.boxSize / 2;
                const at = (x, y) => [
                    (m.a * x + m.c * y + m.e) / PPU - half,
                    (m.b * x + m.d * y + m.f) / PPU - half,
                ];
                probe.push({ center: at(0, 0), outer: at(0, -width / 2) });
            },
        };
        const car = new DrawnCar(FORMULA_CAR, { parts: { frontTire: { part: recorder } } }, { pixelsPerUnit: PPU });
        car.renderFrame();
        drive(car, 30, { steer: 1 });
        car.renderFrame();

        // The left tire is the one on the negative y side.
        const [straight, turned] = probe.filter((entry) => entry.center[1] < 0).slice(-2);
        expect(turned.center[0]).toBeCloseTo(straight.center[0], 4);
        expect(turned.center[1]).toBeCloseTo(straight.center[1], 4);
        // Full right lock swings the outer edge forward by half the width * sin(angle).
        expect(turned.outer[0] - straight.outer[0]).toBeCloseTo((width / 2) * Math.sin(FULL_LOCK), 2);
    });

    it('turns the hub with its tire, and keeps the arms still', () => {
        const car = new DrawnCar(FORMULA_CAR, {}, { pixelsPerUnit: PPU });
        // The rear end of the hub oval of the left front tire, and a point on
        // the front arm, clear of the tire.
        const hubEnd = [21.5, -18.6];
        const arm = [22, -12];
        const straightArm = pixel(car.sprite, ...arm);
        const straightHub = pixel(car.sprite, ...hubEnd);

        drive(car, 30, { steer: 1 });
        const frame = car.renderFrame();
        expect(pixel(frame, ...arm)).toEqual(straightArm);
        expect(pixel(frame, ...hubEnd)).not.toEqual(straightHub);
    });
});
