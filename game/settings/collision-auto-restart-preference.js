import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

// Storage key predates the rename; keep it so an explicit choice survives.
export const COLLISION_AUTO_RESTART_STORAGE_KEY = 'VectorGpAutoRestartAfterCrash';

const collisionAutoRestartPreference = createBooleanPreference(
    COLLISION_AUTO_RESTART_STORAGE_KEY,
    {
        treatMissingAsTrue: false,
        label: 'collision auto-restart preference',
    },
);

export function getCollisionAutoRestartEnabled() {
    return collisionAutoRestartPreference.get();
}

export function setCollisionAutoRestartEnabled(value) {
    return collisionAutoRestartPreference.set(value);
}
