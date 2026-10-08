import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

export const QUICK_RESTART_STORAGE_KEY = 'VectorGpQuickRestartEnabled';

// Quick Restart is held back: Settings hides it and the game treats it as off; true shows it again.
export const QUICK_RESTART_SETTING_VISIBLE = false;

const quickRestartPreference = createBooleanPreference(QUICK_RESTART_STORAGE_KEY, {
    treatMissingAsTrue: false,
    label: 'quick restart preference',
});

export function getQuickRestartEnabled() {
    return quickRestartPreference.get();
}

export function setQuickRestartEnabled(value) {
    return quickRestartPreference.set(value);
}

// The game uses Quick Restart only while its setting is visible.
export function isQuickRestartActive() {
    return QUICK_RESTART_SETTING_VISIBLE && getQuickRestartEnabled();
}
