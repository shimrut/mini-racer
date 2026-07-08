import { createBooleanPreference } from './parse-stored-boolean-toggle.js?v=2.09';

export const MUSIC_STORAGE_KEY = 'VectorGpMusicEnabled';

const musicPreference = createBooleanPreference(MUSIC_STORAGE_KEY, {
    treatMissingAsTrue: true,
    readLabel: 'music preference',
    writeLabel: 'music preference',
});

export function getMusicEnabled() {
    return musicPreference.get();
}

export function setMusicEnabled(value) {
    return musicPreference.set(value);
}
