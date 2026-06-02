import { parseStoredBooleanToggle } from './parse-stored-boolean-toggle.js?v=2.09';

export const CAR_PROCEDURAL_AUDIO_STORAGE_KEY = 'VectorGpCarProceduralAudioEnabled';

export function getCarProceduralAudioEnabled() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return true;
    }
    try {
        return parseStoredBooleanToggle(
            window.localStorage.getItem(CAR_PROCEDURAL_AUDIO_STORAGE_KEY),
            { treatMissingAsTrue: true },
        );
    } catch (error) {
        console.error('Error reading car procedural audio preference:', error);
        return true;
    }
}

export function setCarProceduralAudioEnabled(value) {
    const next = parseStoredBooleanToggle(value, { treatMissingAsTrue: true });
    if (typeof window === 'undefined' || !window.localStorage) {
        return next;
    }
    try {
        window.localStorage.setItem(CAR_PROCEDURAL_AUDIO_STORAGE_KEY, next ? '1' : '0');
    } catch (error) {
        console.error('Error writing car procedural audio preference:', error);
    }
    return next;
}
