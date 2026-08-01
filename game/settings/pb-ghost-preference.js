import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

export const PB_GHOST_STORAGE_KEY = 'VectorGpPersonalBestGhostEnabled';

const pbGhostPreference = createBooleanPreference(PB_GHOST_STORAGE_KEY, {
    treatMissingAsTrue: true,
    label: 'personal best ghost preference',
});

export function getPbGhostEnabled() {
    return pbGhostPreference.get();
}

export function setPbGhostEnabled(value) {
    return pbGhostPreference.set(value);
}
