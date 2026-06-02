import { parseStoredBooleanToggle } from './parse-stored-boolean-toggle.js?v=2.09';

export const MUSIC_STORAGE_KEY = 'VectorGpMusicEnabled';

export function getMusicEnabled() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return true;
    }
    try {
        const item = window.localStorage.getItem(MUSIC_STORAGE_KEY);
        return parseStoredBooleanToggle(item, { treatMissingAsTrue: true });
    } catch (error) {
        console.error('Error reading music preference:', error);
        return true;
    }
}

export function setMusicEnabled(value) {
    const next = parseStoredBooleanToggle(value, { treatMissingAsTrue: true });
    if (typeof window === 'undefined' || !window.localStorage) {
        return next;
    }
    try {
        window.localStorage.setItem(MUSIC_STORAGE_KEY, next ? '1' : '0');
    } catch (error) {
        console.error('Error writing music preference:', error);
    }
    return next;
}
