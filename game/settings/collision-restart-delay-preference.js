// Legacy key; renaming loses saved choices.
export const COLLISION_RESTART_DELAY_STORAGE_KEY = 'VectorGpCrashRestartDelaySec';

export const COLLISION_RESTART_DELAY_MIN = 0;
export const COLLISION_RESTART_DELAY_MAX = 1;
export const COLLISION_RESTART_DELAY_STEP = 0.1;
export const COLLISION_RESTART_DELAY_DEFAULT = 0.5;

export const COLLISION_RESTART_DELAY_METER_TICKS =
    Math.round(COLLISION_RESTART_DELAY_MAX / COLLISION_RESTART_DELAY_STEP) + 1;

export function normalizeCollisionRestartDelaySec(raw) {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim());
    if (!Number.isFinite(n)) return COLLISION_RESTART_DELAY_DEFAULT;
    const clamped = Math.min(
        COLLISION_RESTART_DELAY_MAX,
        Math.max(COLLISION_RESTART_DELAY_MIN, n),
    );
    const scaled = Math.round(clamped * 10 + 1e-6) / 10;
    return Number(scaled.toFixed(1));
}

export function collisionRestartDelayToMeterStep(sec) {
    return Math.min(
        COLLISION_RESTART_DELAY_METER_TICKS - 1,
        Math.max(0, Math.round(normalizeCollisionRestartDelaySec(sec) * 10 + 1e-6)),
    );
}

export function getCollisionRestartDelaySec() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return COLLISION_RESTART_DELAY_DEFAULT;
    }
    try {
        return normalizeCollisionRestartDelaySec(
            window.localStorage.getItem(COLLISION_RESTART_DELAY_STORAGE_KEY),
        );
    } catch (error) {
        console.error('Error reading collision restart delay preference:', error);
        return COLLISION_RESTART_DELAY_DEFAULT;
    }
}

export function setCollisionRestartDelaySec(value) {
    const next = normalizeCollisionRestartDelaySec(value);
    if (typeof window === 'undefined' || !window.localStorage) {
        return next;
    }
    try {
        window.localStorage.setItem(COLLISION_RESTART_DELAY_STORAGE_KEY, String(next));
    } catch (error) {
        console.error('Error writing collision restart delay preference:', error);
    }
    return next;
}
