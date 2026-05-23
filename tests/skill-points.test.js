import { describe, expect, it } from 'vitest';
import {
    applySkillPointAllocation,
    calculateSkillPointEffects,
    DEFAULT_SKILL_POINT_ALLOCATION,
    getSkillPointDisplayValues,
    getSkillPointStatDisplay,
    getSkillPointsUsed,
    getSkillPointTopSpeedKph,
    isDefaultSkillPointAllocation,
    normalizeSkillPointAllocation
} from '../game/car/skill-points.js';

describe('skill point tuning', () => {
    it('normalizes allocations to the 5 point budget', () => {
        expect(normalizeSkillPointAllocation({ accel: 10, speed: 10, grip: 10, brake: 10 })).toEqual({
            accel: 2,
            speed: 1,
            handling: 2
        });

        expect(normalizeSkillPointAllocation({ accel: 2, speed: 0, grip: 2, brake: 1 })).toEqual({
            accel: 2,
            speed: 0,
            handling: 0
        });
    });

    it('detects the default allocation after normalization', () => {
        expect(isDefaultSkillPointAllocation(DEFAULT_SKILL_POINT_ALLOCATION)).toBe(true);
        expect(isDefaultSkillPointAllocation({ accel: 2, speed: 1, handling: 2 })).toBe(true);
        expect(isDefaultSkillPointAllocation({ accel: 3, speed: 1, handling: 1 })).toBe(false);
        expect(isDefaultSkillPointAllocation({ accel: 10, speed: 10, grip: 10, brake: 10 })).toBe(true);
    });

    it('keeps skill point effects as deltas from the default baseline', () => {
        const balanced = calculateSkillPointEffects({ accel: 2, speed: 1, handling: 2 });
        const speedHeavy = calculateSkillPointEffects({ accel: 0, speed: 5, handling: 0 });

        expect(balanced).toEqual({ accel: 0, speed: 0, grip: 0, brake: 0 });
        expect(speedHeavy.speed).toBe(50);
        expect(speedHeavy.accel).toBeLessThan(0);
        expect(speedHeavy.grip).toBeLessThan(0);
        expect(speedHeavy.brake).toBeLessThan(0);
    });

    it('maps speed points to the configured top speed per level', () => {
        const base = { maxSpeed: 348 };
        expect(getSkillPointTopSpeedKph({ accel: 0, speed: 0, handling: 0 }, base)).toBe(328);
        expect(getSkillPointTopSpeedKph({ accel: 2, speed: 1, handling: 2 }, base)).toBe(348);
        expect(getSkillPointTopSpeedKph({ accel: 0, speed: 5, handling: 0 }, base)).toBe(398);
    });

    it('applies allocation effects to the driving physics config', () => {
        const tuned = applySkillPointAllocation(
            { accel: 100, maxSpeed: 200, grip: 2, brakePower: 80, turnRate: 4 },
            { accel: 0, speed: 5, handling: 0 }
        );

        expect(tuned.maxSpeed).toBe(250);
        expect(tuned.accel).toBe(0);
        expect(tuned.grip).toBeCloseTo(1.28);
        expect(tuned.brakePower).toBe(60);
        expect(tuned.skillPoints).toEqual({ accel: 0, speed: 5, handling: 0 });
    });

    it('makes accel and handling points visibly affect their race stats', () => {
        const base = { accel: 100, maxSpeed: 300, grip: 2, brakePower: 80, turnRate: 4 };
        const low = applySkillPointAllocation(base, DEFAULT_SKILL_POINT_ALLOCATION);
        const tuned = applySkillPointAllocation(base, { accel: 5, speed: 0, handling: 0 });

        expect(tuned.accel).toBe(low.accel + 80 + 90 + 100);
        expect(tuned.grip).toBeCloseTo(low.grip - 2 * 0.36);
        expect(tuned.brakePower).toBe(low.brakePower - 20);
        expect(tuned.turnRate).toBeLessThan(low.turnRate);
    });

    it('shows linear per-point stat changes for accel and handling', () => {
        const base = { accel: 100, maxSpeed: 300, grip: 2, brakePower: 80, turnRate: 4 };
        const accelOne = getSkillPointDisplayValues(base, { accel: 1, speed: 0, handling: 0 });
        const accelTwo = getSkillPointDisplayValues(base, { accel: 2, speed: 0, handling: 0 });
        const accelThree = getSkillPointDisplayValues(base, { accel: 3, speed: 0, handling: 0 });

        expect(accelOne.accelNumber).toMatch(/^\d+\.\d{2}s$/);
        expect(accelTwo.accelNumber).toMatch(/^\d+\.\d{2}s$/);
        expect(accelThree.accelNumber).toMatch(/^\d+\.\d{2}s$/);
        expect(Number.parseFloat(accelTwo.accelNumber)).toBeLessThan(Number.parseFloat(accelOne.accelNumber));
        expect(Number.parseFloat(accelThree.accelNumber)).toBeLessThan(Number.parseFloat(accelTwo.accelNumber));

        const hOne = getSkillPointDisplayValues(base, { accel: 0, speed: 0, handling: 1 });
        const hTwo = getSkillPointDisplayValues(base, { accel: 0, speed: 0, handling: 2 });
        const hThree = getSkillPointDisplayValues(base, { accel: 0, speed: 0, handling: 3 });
        expect(Number(hTwo.handlingNumber) - Number(hOne.handlingNumber)).toBe(1);
        expect(Number(hThree.handlingNumber) - Number(hTwo.handlingNumber)).toBe(1);
    });

    it('formats tuned values for the garage rows instead of abstract percentages', () => {
        const values = getSkillPointDisplayValues(
            { accel: 100, maxSpeed: 200, grip: 2, brakePower: 80, turnRate: 4 },
            { accel: 2, speed: 3, handling: 0 }
        );

        expect(values.accel).toMatch(/^\d+\.\d{2}s$/);
        expect(values.accelNumber).toBe(values.accel);
        expect(values.speed).toBe(values.speedNumber);
        expect(values.handling).toBe('-2');
    });

    it('keeps accel display readable when only speed points change', () => {
        const base = { accel: 100, maxSpeed: 300, grip: 2, brakePower: 80, turnRate: 4 };
        const lowSpeed = getSkillPointDisplayValues(base, { accel: 2, speed: 0, handling: 2 });
        const highSpeed = getSkillPointDisplayValues(base, { accel: 2, speed: 3, handling: 0 });

        expect(lowSpeed.accel).toMatch(/^\d+\.\d{2}s$/);
        expect(highSpeed.accel).toMatch(/^\d+\.\d{2}s$/);
        expect(lowSpeed.speed).not.toBe(highSpeed.speed);
        expect(lowSpeed.accel).toBe(highSpeed.accel);
    });

    it('counts used skill points through one helper', () => {
        expect(getSkillPointsUsed({ accel: 2, speed: 1, handling: 2 })).toBe(5);
        expect(getSkillPointsUsed({ accel: 3, speed: 3, handling: 3 })).toBe(5);
    });

    it('formats stat labels consistently for garage and pause UI', () => {
        const values = getSkillPointDisplayValues(
            { accel: 100, maxSpeed: 200, grip: 2, brakePower: 80, turnRate: 4 },
            { accel: 2, speed: 3, handling: 0 }
        );
        expect(getSkillPointStatDisplay('accel', values)).toBe(values.accel);
        expect(getSkillPointStatDisplay('speed', values)).toBe(values.speed);
        expect(getSkillPointStatDisplay('handling', values)).toBe(values.handling);
    });

    it('shows handling as a direct point rating', () => {
        const values = getSkillPointDisplayValues(
            { accel: 100, maxSpeed: 200, grip: 2, brakePower: 80, turnRate: 4 },
            { accel: 0, speed: 0, handling: 5 }
        );

        expect(values.handling).toBe('+3');
    });
});
