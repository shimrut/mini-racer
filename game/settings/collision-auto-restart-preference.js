import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

// Legacy key; renaming loses saved choices.
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
