import {
    clamp,
    estimateTimeToSpeed,
    normalizePhysicsConfig
} from './handling.js';

export const SKILL_POINT_TOTAL = 5;
export const SKILL_POINT_STORAGE_KEY = 'MiniRacerSkillPointAllocation';
/** Top speed delta (km/h) relative to base config for each speed skill point level (0–5). */
export const SKILL_POINT_SPEED_DELTAS = Object.freeze([-20, 0, 15, 30, 40, 50]);
export const SKILL_POINT_ACCEL_TARGET_KPH = 200;
export const DEFAULT_SKILL_POINT_ALLOCATION = Object.freeze({
    accel: 2,
    speed: 1,
    handling: 2
});

export const SKILL_POINT_DEFINITIONS = Object.freeze([
    Object.freeze({ key: 'accel', label: 'Acceleration' }),
    Object.freeze({ key: 'speed', label: 'Top speed' }),
    Object.freeze({ key: 'handling', label: 'Steering' })
]);

const ACCEL_GAIN_PER_POINT = Object.freeze([60, 70, 80, 90, 100]);

/** One handling point adjusts grip and brake power together in `applySkillPointAllocation`. */
const GRIP_GAIN_PER_HANDLING_POINT = 0.36;
const BRAKE_GAIN_PER_HANDLING_POINT = 10;
const TURN_RATE_GAIN_PER_HANDLING_POINT = 0.16;
const STEER_GRIP_SCALE_GAIN_PER_HANDLING_POINT = 0.03;
const ANGULAR_RESPONSE_GAIN_PER_HANDLING_POINT = 1.2;

function sumAllocation(allocation) {
    return SKILL_POINT_DEFINITIONS.reduce((total, { key }) => total + Math.trunc(allocation[key] || 0), 0);
}

export function getSkillPointsUsed(allocation = {}) {
    return sumAllocation(normalizeSkillPointAllocation(allocation));
}

export function getSkillPointStatDisplay(skillKey, statValues = {}) {
    if (skillKey === 'accel') return statValues.accelNumber || statValues.accel || '';
    if (skillKey === 'speed') return statValues.speedNumber || statValues.speed || '';
    return statValues.handlingNumber || statValues.handling || '';
}

export function normalizeSkillPointAllocation(allocation = {}) {
    const normalized = {};
    for (const { key } of SKILL_POINT_DEFINITIONS) {
        normalized[key] = clamp(Math.trunc(Number(allocation?.[key]) || 0), 0, SKILL_POINT_TOTAL);
    }

    let total = sumAllocation(normalized);
    if (total <= SKILL_POINT_TOTAL) return normalized;

    const fallback = { ...DEFAULT_SKILL_POINT_ALLOCATION };
    if (sumAllocation(fallback) === SKILL_POINT_TOTAL) {
        return fallback;
    }

    while (total > SKILL_POINT_TOTAL) {
        for (const { key } of [...SKILL_POINT_DEFINITIONS].reverse()) {
            if (normalized[key] <= 0 || total <= SKILL_POINT_TOTAL) continue;
            normalized[key] -= 1;
            total -= 1;
        }
    }

    return normalized;
}

export function isDefaultSkillPointAllocation(allocation) {
    const normalized = normalizeSkillPointAllocation(allocation);
    return SKILL_POINT_DEFINITIONS.every(
        ({ key }) => normalized[key] === DEFAULT_SKILL_POINT_ALLOCATION[key]
    );
}

export function readSkillPointAllocation() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return normalizeSkillPointAllocation(DEFAULT_SKILL_POINT_ALLOCATION);
    }

    try {
        const raw = window.localStorage.getItem(SKILL_POINT_STORAGE_KEY);
        if (!raw) return normalizeSkillPointAllocation(DEFAULT_SKILL_POINT_ALLOCATION);
        return normalizeSkillPointAllocation(JSON.parse(raw));
    } catch (error) {
        console.error('Error reading skill point allocation:', error);
        return normalizeSkillPointAllocation(DEFAULT_SKILL_POINT_ALLOCATION);
    }
}

export function writeSkillPointAllocation(allocation) {
    const normalized = normalizeSkillPointAllocation(allocation);
    if (typeof window === 'undefined' || !window.localStorage) {
        return normalized;
    }

    try {
        window.localStorage.setItem(SKILL_POINT_STORAGE_KEY, JSON.stringify(normalized));
    } catch (error) {
        console.error('Error writing skill point allocation:', error);
    }
    return normalized;
}

export function calculateSkillPointEffects(allocation = DEFAULT_SKILL_POINT_ALLOCATION) {
    const normalized = normalizeSkillPointAllocation(allocation);
    const handlingDelta = normalized.handling - DEFAULT_SKILL_POINT_ALLOCATION.handling;

    return Object.freeze({
        accel: ACCEL_GAIN_PER_POINT.slice(0, normalized.accel).reduce((sum, gain) => sum + gain, 0)
            - ACCEL_GAIN_PER_POINT.slice(0, DEFAULT_SKILL_POINT_ALLOCATION.accel).reduce((sum, gain) => sum + gain, 0),
        speed: SKILL_POINT_SPEED_DELTAS[normalized.speed],
        grip: handlingDelta * GRIP_GAIN_PER_HANDLING_POINT,
        brake: handlingDelta * BRAKE_GAIN_PER_HANDLING_POINT
    });
}

export function getSkillPointTopSpeedKph(
    allocation = DEFAULT_SKILL_POINT_ALLOCATION,
    baseConfig = {}
) {
    const tuning = normalizePhysicsConfig(baseConfig);
    const effects = calculateSkillPointEffects(allocation);
    return Math.max(0, tuning.maxSpeed + effects.speed);
}

export function applySkillPointAllocation(baseConfig = {}, allocation = DEFAULT_SKILL_POINT_ALLOCATION) {
    const tuning = normalizePhysicsConfig(baseConfig);
    const normalized = normalizeSkillPointAllocation(allocation);
    const effects = calculateSkillPointEffects(allocation);
    const handlingDelta = normalized.handling - DEFAULT_SKILL_POINT_ALLOCATION.handling;

    return {
        ...baseConfig,
        accel: Math.max(0, tuning.accel + effects.accel),
        maxSpeed: Math.max(0, tuning.maxSpeed + effects.speed),
        grip: Math.max(0, tuning.grip + effects.grip),
        brakePower: Math.max(0, tuning.brakePower + effects.brake),
        turnRate: Math.max(0, tuning.turnRate + (handlingDelta * TURN_RATE_GAIN_PER_HANDLING_POINT)),
        steerGripScale: clamp(
            (tuning.steerGripScale || 0.88) + (handlingDelta * STEER_GRIP_SCALE_GAIN_PER_HANDLING_POINT),
            0.05,
            1.5
        ),
        angularResponse: clamp(
            (tuning.angularResponse || 22) + (handlingDelta * ANGULAR_RESPONSE_GAIN_PER_HANDLING_POINT),
            4,
            48
        ),
        skillPoints: normalized
    };
}

export function getSkillPointDisplayValues(baseConfig = {}, allocation = DEFAULT_SKILL_POINT_ALLOCATION) {
    const tuned = applySkillPointAllocation(baseConfig, allocation);
    const speedNumber = String(Math.round(tuned.maxSpeed));
    const normalized = normalizeSkillPointAllocation(allocation);
    const baselineTuning = normalizePhysicsConfig(baseConfig);
    /** Pin top speed for this estimate so drag in handling.js sim does not change when only speed skill points move. */
    const accelTimeSimMaxKph = Math.max(
        getSkillPointTopSpeedKph(DEFAULT_SKILL_POINT_ALLOCATION, baselineTuning),
        SKILL_POINT_ACCEL_TARGET_KPH + 1
    );
    const accelTime = estimateTimeToSpeed(
        { ...tuned, maxSpeed: accelTimeSimMaxKph },
        SKILL_POINT_ACCEL_TARGET_KPH
    );
    const accelDisplay = Number.isFinite(accelTime) ? `${accelTime.toFixed(2)}s` : '--';
    const steeringVal = normalized.handling - DEFAULT_SKILL_POINT_ALLOCATION.handling;
    const steeringDisplay = steeringVal > 0 ? `+${steeringVal}` : `${steeringVal}`;

    return Object.freeze({
        accelNumber: accelDisplay,
        accel: accelDisplay,
        speedNumber,
        speed: speedNumber,
        handlingNumber: steeringDisplay,
        handling: steeringDisplay
    });
}
