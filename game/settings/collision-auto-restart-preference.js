import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

// Keep the existing storage key so players who explicitly chose the old
// setting retain that choice after it becomes collision auto-restart.
export const COLLISION_AUTO_RESTART_STORAGE_KEY = 'VectorGpAutoRestartAfterCrash';

const collisionAutoRestartPreference = createBooleanPreference(
    COLLISION_AUTO_RESTART_STORAGE_KEY,
    {
        treatMissingAsTrue: false,
        readLabel: 'collision auto-restart preference',
        writeLabel: 'collision auto-restart preference',
    },
);

export function getCollisionAutoRestartEnabled() {
    return collisionAutoRestartPreference.get();
}

export function setCollisionAutoRestartEnabled(value) {
    return collisionAutoRestartPreference.set(value);
}
