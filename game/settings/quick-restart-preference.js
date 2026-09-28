import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

export const QUICK_RESTART_STORAGE_KEY = 'VectorGpQuickRestartEnabled';

// Quick Restart is held back for now: Settings hides its row, and the game
// treats it as off. The saved choice stays. Set this to true to show it again.
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
