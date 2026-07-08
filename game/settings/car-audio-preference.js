import { createBooleanPreference } from './parse-stored-boolean-toggle.js?v=2.09';

export const CAR_PROCEDURAL_AUDIO_STORAGE_KEY = 'VectorGpCarProceduralAudioEnabled';

const carProceduralAudioPreference = createBooleanPreference(
    CAR_PROCEDURAL_AUDIO_STORAGE_KEY,
    {
        treatMissingAsTrue: true,
        readLabel: 'car procedural audio preference',
        writeLabel: 'car procedural audio preference',
    },
);

export function getCarProceduralAudioEnabled() {
    return carProceduralAudioPreference.get();
}

export function setCarProceduralAudioEnabled(value) {
    return carProceduralAudioPreference.set(value);
}
