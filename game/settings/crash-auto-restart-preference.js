import { parseStoredBooleanToggle } from './parse-stored-boolean-toggle.js?v=2.09';

export const CRASH_AUTO_RESTART_STORAGE_KEY = 'VectorGpAutoRestartAfterCrash';

export function getCrashAutoRestartAfterCrashEnabled() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return true;
    }
    try {
        return parseStoredBooleanToggle(
            window.localStorage.getItem(CRASH_AUTO_RESTART_STORAGE_KEY),
            { treatMissingAsTrue: true },
        );
    } catch (error) {
        console.error('Error reading crash auto-restart preference:', error);
        return true;
    }
}

export function setCrashAutoRestartAfterCrashEnabled(value) {
    const next = parseStoredBooleanToggle(value, { treatMissingAsTrue: true });
    if (typeof window === 'undefined' || !window.localStorage) {
        return next;
    }
    try {
        window.localStorage.setItem(CRASH_AUTO_RESTART_STORAGE_KEY, next ? '1' : '0');
    } catch (error) {
        console.error('Error writing crash auto-restart preference:', error);
    }
    return next;
}
