const PHYSICS_DT = 1 / 60;
export const KPH_PER_WORLD_UNIT = 20;

export const DEFAULT_PHYSICS_TUNING = Object.freeze({
    accel: 400,
    brakePower: 118,
    maxSpeed: 340,
    turnRate: 4.2,
    grip: 3.5,
    steerGripScale: 0.88,
    downforceGrip: 0.62,
    highSpeedSteerTrim: 0.38,
    angularResponse: 22
});

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function normalizePhysicsConfig(config = {}, fallback = DEFAULT_PHYSICS_TUNING) {
    const normalized = { ...fallback };

    if (!config || typeof config !== 'object') {
        return normalized;
    }

    if (Number.isFinite(config.accel)) normalized.accel = Number(config.accel);
    if (Number.isFinite(config.maxSpeed)) normalized.maxSpeed = Number(config.maxSpeed);
    if (Number.isFinite(config.brakePower)) normalized.brakePower = Number(config.brakePower);
    if (Number.isFinite(config.turnRate)) normalized.turnRate = Number(config.turnRate);
    if (Number.isFinite(config.grip)) normalized.grip = Math.max(0, Number(config.grip));

    if (Number.isFinite(config.steerGripScale)) {
        normalized.steerGripScale = clamp(Number(config.steerGripScale), 0.05, 1.5);
    }
    if (Number.isFinite(config.downforceGrip)) {
        normalized.downforceGrip = clamp(Number(config.downforceGrip), 0, 2.5);
    }
    if (Number.isFinite(config.highSpeedSteerTrim)) {
        normalized.highSpeedSteerTrim = clamp(Number(config.highSpeedSteerTrim), 0, 0.92);
    }
    if (Number.isFinite(config.angularResponse)) {
        normalized.angularResponse = clamp(Number(config.angularResponse), 4, 48);
    }

    return normalized;
}


export function simulateStraightLine(config = {}, {
    dt = PHYSICS_DT,
    maxTime = 20,
    targetSpeed = null
} = {}) {
    const tuning = normalizePhysicsConfig(config);
    const maxSteps = Math.max(1, Math.round(maxTime / dt));
    let speed = 0;
    const safeMaxSpeed = Math.max(0.001, tuning.maxSpeed / KPH_PER_WORLD_UNIT);
    const targetSpeedWorld = Number.isFinite(targetSpeed) ? (targetSpeed / KPH_PER_WORLD_UNIT) : null;

    for (let step = 1; step <= maxSteps; step += 1) {
        const dragFactor = 1 - (Math.max(0, speed) / safeMaxSpeed) ** 2;
        speed += (tuning.accel / KPH_PER_WORLD_UNIT) * dragFactor * dt;
        speed = Math.max(0, Math.min(speed, safeMaxSpeed));

        if (Number.isFinite(targetSpeedWorld) && speed >= targetSpeedWorld) {
            return {
                reached: true,
                speed,
                time: step * dt
            };
        }
    }

    return {
        reached: Number.isFinite(targetSpeed) ? speed >= targetSpeed : true,
        speed,
        time: maxSteps * dt
    };
}

export function estimateTimeToSpeed(config = {}, targetSpeed, options = {}) {
    if (!Number.isFinite(targetSpeed) || targetSpeed <= 0) {
        return null;
    }

    const result = simulateStraightLine(config, {
        ...options,
        targetSpeed
    });

    return result.reached ? result.time : null;
}
