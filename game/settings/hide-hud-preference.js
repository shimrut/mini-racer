import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

export const HIDE_HUD_STORAGE_KEY = 'VectorGpHideHudEnabled';

const hideHudPreference = createBooleanPreference(HIDE_HUD_STORAGE_KEY, {
    treatMissingAsTrue: false,
    label: 'hide hud preference',
});

export function getHideHudEnabled() {
    return hideHudPreference.get();
}

export function setHideHudEnabled(value) {
    return hideHudPreference.set(value);
}
