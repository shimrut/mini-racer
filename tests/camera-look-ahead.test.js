import { describe, expect, it } from 'vitest';
import { stepLookAhead } from '../game/race/engine-methods.js';

const DT = 1 / 60;
// Matches LOOK_AHEAD_MAX_TURN_RAD_PER_S in engine-methods.js.
const MAX_TURN_RAD_PER_S = 2.2;
const maxAngleStep = MAX_TURN_RAD_PER_S * DT;

const at = (x, y) => ({ x, y });
const mag = (v) => Math.hypot(v.x, v.y);

// The desktop framing offset on a 1280x720 viewport: min(cw, ch) / 5.
const FRAMING = 144;
// Mobile deliberately sits the car further back: min(cw, ch) / 2.5.
const MOBILE_FRAMING = 156;

describe('stepLookAhead — framing distance', () => {
    it('holds the offset distance through a 90 degree direction change', () => {
        // Target swings from "travelling +x" to "travelling +y" at the same speed.
        let look = at(FRAMING, 0);
        const desired = at(0, FRAMING);

        for (let i = 0; i < 240; i += 1) {
            look = stepLookAhead(look, desired, 0.065, maxAngleStep);
            expect(mag(look)).toBeCloseTo(FRAMING, 6);
        }
    });

    it('holds the deeper mobile offset through a full reversal', () => {
        let look = at(MOBILE_FRAMING, 0);
        const desired = at(-MOBILE_FRAMING, 0.0001);

        for (let i = 0; i < 240; i += 1) {
            look = stepLookAhead(look, desired, 0.03, maxAngleStep);
            expect(mag(look)).toBeCloseTo(MOBILE_FRAMING, 6);
        }
    });

    it('never dips toward centre mid-turn the way a cartesian lerp does', () => {
        const from = at(FRAMING, 0);
        const to = at(0, FRAMING);

        // A straight x/y lerp cuts the chord and loses ~29% of the offset.
        const cartesianHalfway = at(
            from.x + (to.x - from.x) * 0.5,
            from.y + (to.y - from.y) * 0.5,
        );
        expect(mag(cartesianHalfway)).toBeLessThan(FRAMING * 0.72);

        let look = from;
        let lowest = Infinity;
        for (let i = 0; i < 240; i += 1) {
            look = stepLookAhead(look, to, 0.065, maxAngleStep);
            lowest = Math.min(lowest, mag(look));
        }
        expect(lowest).toBeCloseTo(FRAMING, 6);
    });

    it('still tracks magnitude when the target offset itself changes', () => {
        // Accelerating: the offset grows toward the framing distance.
        let look = at(40, 0);
        for (let i = 0; i < 400; i += 1) {
            look = stepLookAhead(look, at(FRAMING, 0), 0.065, maxAngleStep);
        }
        expect(mag(look)).toBeCloseTo(FRAMING, 4);
    });
});

describe('stepLookAhead — rotation rate', () => {
    it('caps how far the bearing may turn in one frame', () => {
        const from = at(FRAMING, 0);
        const next = stepLookAhead(from, at(-FRAMING, 0.0001), 1, maxAngleStep);

        const turned = Math.abs(Math.atan2(next.y, next.x) - Math.atan2(from.y, from.x));
        expect(turned).toBeCloseTo(maxAngleStep, 10);
    });

    it('leaves gentle direction changes untouched by the cap', () => {
        const from = at(FRAMING, 0);
        const desired = at(FRAMING * Math.cos(0.004), FRAMING * Math.sin(0.004));

        const next = stepLookAhead(from, desired, 1, maxAngleStep);
        const turned = Math.atan2(next.y, next.x);

        // Well inside the per-frame budget, so the ease applies in full.
        expect(turned).toBeCloseTo(0.004, 10);
    });

    it('is frame-rate independent: two half-frames turn as far as one full frame', () => {
        const from = at(FRAMING, 0);
        const target = at(-FRAMING, 0.0001);
        const half = MAX_TURN_RAD_PER_S * (DT / 2);

        const once = stepLookAhead(from, target, 1, maxAngleStep);
        let twice = stepLookAhead(from, target, 1, half);
        twice = stepLookAhead(twice, target, 1, half);

        expect(Math.atan2(twice.y, twice.x)).toBeCloseTo(Math.atan2(once.y, once.x), 10);
    });
});

describe('stepLookAhead — edges', () => {
    it('adopts the target bearing immediately when starting from no offset', () => {
        const next = stepLookAhead(at(0, 0), at(0, FRAMING), 0.065, maxAngleStep);

        // No arc swept up from zero: the bearing is already straight up.
        expect(Math.atan2(next.y, next.x)).toBeCloseTo(Math.PI / 2, 10);
        expect(mag(next)).toBeCloseTo(FRAMING * 0.065, 6);
    });

    it('collapses to zero when the car stops and the target offset is zero', () => {
        let look = at(FRAMING, 0);
        for (let i = 0; i < 600; i += 1) {
            look = stepLookAhead(look, at(0, 0), 0.065, maxAngleStep);
        }
        expect(mag(look)).toBeCloseTo(0, 6);
    });

    it('keeps its bearing when the target offset is zero but the offset is not', () => {
        const next = stepLookAhead(at(FRAMING, 0), at(0, 0), 0.065, maxAngleStep);

        expect(Math.atan2(next.y, next.x)).toBeCloseTo(0, 10);
    });

    it('returns the origin when both current and desired are zero', () => {
        expect(stepLookAhead(at(0, 0), at(0, 0), 0.065, maxAngleStep)).toEqual({ x: 0, y: 0 });
    });
});
