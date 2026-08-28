import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

export const PAUSE_ON_TIMER_STORAGE_KEY = 'VectorGpPauseOnTimerEnabled';

const pauseOnTimerPreference = createBooleanPreference(PAUSE_ON_TIMER_STORAGE_KEY, {
    treatMissingAsTrue: true,
    label: 'pause on timer preference',
});

export function getPauseOnTimerEnabled() {
    return pauseOnTimerPreference.get();
}

export function setPauseOnTimerEnabled(value) {
    return pauseOnTimerPreference.set(value);
}
