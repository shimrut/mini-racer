import { createBooleanPreference } from './parse-stored-boolean-toggle.js';

export const CAR_PROCEDURAL_AUDIO_STORAGE_KEY = 'VectorGpCarProceduralAudioEnabled';

const carProceduralAudioPreference = createBooleanPreference(
    CAR_PROCEDURAL_AUDIO_STORAGE_KEY,
    {
        treatMissingAsTrue: true,
        label: 'car procedural audio preference',
    },
);

export function getCarProceduralAudioEnabled() {
    return carProceduralAudioPreference.get();
}

export function setCarProceduralAudioEnabled(value) {
    return carProceduralAudioPreference.set(value);
}
