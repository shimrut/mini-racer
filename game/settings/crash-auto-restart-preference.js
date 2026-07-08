import { createBooleanPreference } from './parse-stored-boolean-toggle.js?v=2.09';

export const CRASH_AUTO_RESTART_STORAGE_KEY = 'VectorGpAutoRestartAfterCrash';

const crashAutoRestartPreference = createBooleanPreference(
    CRASH_AUTO_RESTART_STORAGE_KEY,
    {
        treatMissingAsTrue: true,
        readLabel: 'crash auto-restart preference',
        writeLabel: 'crash auto-restart preference',
    },
);

export function getCrashAutoRestartAfterCrashEnabled() {
    return crashAutoRestartPreference.get();
}

export function setCrashAutoRestartAfterCrashEnabled(value) {
    return crashAutoRestartPreference.set(value);
}
