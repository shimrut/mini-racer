export const CRASH_RESTART_DELAY_STORAGE_KEY = 'VectorGpCrashRestartDelaySec';

export const CRASH_RESTART_DELAY_MIN = 0;
export const CRASH_RESTART_DELAY_MAX = 1;
export const CRASH_RESTART_DELAY_STEP = 0.1;
export const CRASH_RESTART_DELAY_DEFAULT = 0.5;

/** Number of ticks on the settings meter (0, 0.1, … 1.0). */
export const CRASH_RESTART_DELAY_METER_TICKS =
    Math.round(CRASH_RESTART_DELAY_MAX / CRASH_RESTART_DELAY_STEP) + 1;

export function normalizeCrashRestartDelaySec(raw) {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim());
    if (!Number.isFinite(n)) return CRASH_RESTART_DELAY_DEFAULT;
    const clamped = Math.min(
        CRASH_RESTART_DELAY_MAX,
        Math.max(CRASH_RESTART_DELAY_MIN, n),
    );
    const scaled = Math.round(clamped * 10 + 1e-6) / 10;
    return Number(scaled.toFixed(1));
}

export function crashRestartDelayToMeterStep(sec) {
    return Math.min(
        CRASH_RESTART_DELAY_METER_TICKS - 1,
        Math.max(0, Math.round(normalizeCrashRestartDelaySec(sec) * 10 + 1e-6)),
    );
}

export function getCrashRestartDelaySec() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return CRASH_RESTART_DELAY_DEFAULT;
    }
    try {
        return normalizeCrashRestartDelaySec(
            window.localStorage.getItem(CRASH_RESTART_DELAY_STORAGE_KEY),
        );
    } catch (error) {
        console.error('Error reading crash restart delay preference:', error);
        return CRASH_RESTART_DELAY_DEFAULT;
    }
}

export function setCrashRestartDelaySec(value) {
    const next = normalizeCrashRestartDelaySec(value);
    if (typeof window === 'undefined' || !window.localStorage) {
        return next;
    }
    try {
        window.localStorage.setItem(CRASH_RESTART_DELAY_STORAGE_KEY, String(next));
    } catch (error) {
        console.error('Error writing crash restart delay preference:', error);
    }
    return next;
}
