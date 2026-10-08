// One record per slot (Daily, stage, selected card, Next, Head to Head), holding its walls and picture.
// Start uses only loaded definitions; a newer target replaces a record and a late older answer is dropped.

import { getTrackCanvasAsset, getTrackRuntimeAsset } from './assets.js';
import { getLoadedClientTrack, loadRaceDefinitions } from './client-registry.js';
import { getTrackDefinitionIdentity } from './definition-identity.js';
import {
    createDailyChallengePresentationEvent,
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from './presentation.js';

export const PREPARATION_SLOTS = Object.freeze({
    DAILY: 'daily',
    CAMPAIGN: 'campaign',
    SELECTED: 'selected',
    NEXT: 'next',
    CHALLENGE: 'challenge',
});

export function raceAssetOptionsKey(options = {}) {
    return `${options.qualityLevel ?? 0}:${options.frameSkip ?? 0}`;
}

// Campaign and Head to Head races use the track's plain presentation.
export function plainRaceChallenge(trackKey) {
    return { trackKey, skin: 'default' };
}

export function resolveRacePresentation(trackKey, track, challenge = null) {
    return resolveTrackPresentation(trackKey, {
        surface: TRACK_PRESENTATION_SURFACES.RACE,
        event: createDailyChallengePresentationEvent(challenge),
        ground: track?.ground,
    });
}

export function createRacePreparation({
    getAssetOptions = () => ({}),
    needsConfirmation = () => true,
} = {}) {
    const slots = new Map();
    const listeners = new Set();

    function notify() {
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                console.error('A race preparation listener failed:', error);
            }
        }
    }

    // Ready only for the current layout, asset options and this challenge's presentation.
    function matches(record, trackKey, challenge) {
        if (!record || record.trackKey !== trackKey) return false;
        const latest = getLoadedClientTrack(trackKey);
        if (!latest || getTrackDefinitionIdentity(latest) !== record.identity) return false;
        if (record.optionsKey !== raceAssetOptionsKey(getAssetOptions())) return false;
        return resolveRacePresentation(trackKey, latest, challenge).key === record.presentation.key;
    }

    function findRecord(trackKey, challenge = null) {
        if (typeof trackKey !== 'string' || !trackKey) return null;
        for (const state of slots.values()) {
            if (matches(state.record, trackKey, challenge)) return state.record;
        }
        return null;
    }

    function buildRecord(trackKey, challenge, track) {
        const options = getAssetOptions();
        const presentation = resolveRacePresentation(trackKey, track, challenge);
        return Object.freeze({
            trackKey,
            identity: getTrackDefinitionIdentity(track),
            optionsKey: raceAssetOptionsKey(options),
            track,
            runtime: getTrackRuntimeAsset(trackKey, track, options),
            canvasAsset: getTrackCanvasAsset(trackKey, track, { ...options, presentation }),
            presentation,
        });
    }

    // Uses only a loaded definition; misses rebuild assets locally, never asking the server.
    function prepareLoaded(slot, { trackKey, challenge = null } = {}) {
        const track = getLoadedClientTrack(trackKey);
        if (!track) throw new Error('The race definitions are not loaded. Try the lobby again.');
        const record = findRecord(trackKey, challenge) ?? buildRecord(trackKey, challenge, track);
        slots.set(slot, { trackKey, challenge, record, error: null, promise: Promise.resolve(record) });
        notify();
        return record;
    }

    async function build(slot, state) {
        const { trackKey, challenge } = state;
        await loadRaceDefinitions([trackKey], { requireConfirmation: needsConfirmation(trackKey, challenge) });
        if (slots.get(slot) !== state) return null;
        let track = getLoadedClientTrack(trackKey);
        if (!track) throw new Error('The track layout could not be confirmed. Retry before racing.');
        // The build blocks the screen, so the caller may wait for a quiet moment or stop it.
        if (state.beforeBuild && await state.beforeBuild() === false) {
            if (slots.get(slot) === state) {
                slots.delete(slot);
                notify();
            }
            return null;
        }
        if (slots.get(slot) !== state) return null;
        track = getLoadedClientTrack(trackKey);
        if (!track) throw new Error('The track definition was replaced before preparation finished.');
        state.record = buildRecord(trackKey, challenge, track);
        state.error = null;
        notify();
        return state.record;
    }

    // Prepares a slot's target, sharing one another slot holds; `beforeBuild` false stops the build.
    function prepare(slot, { trackKey, challenge = null, beforeBuild = null } = {}) {
        if (typeof trackKey !== 'string' || !trackKey) {
            return Promise.reject(new Error('A race needs a track.'));
        }
        const current = slots.get(slot);
        const track = getLoadedClientTrack(trackKey);
        const samePresentation = current?.trackKey === trackKey
            && (track
                ? resolveRacePresentation(trackKey, track, current.challenge).key === resolveRacePresentation(trackKey, track, challenge).key
                : current.challenge?.skin === challenge?.skin);
        if (samePresentation && current.promise
            && !current.error && (!current.record || matches(current.record, trackKey, challenge))) {
            current.beforeBuild = beforeBuild;
            return current.promise;
        }
        const state = {
            trackKey,
            challenge,
            record: findRecord(trackKey, challenge),
            error: null,
            promise: null,
            beforeBuild,
        };
        slots.set(slot, state);
        if (state.record) {
            state.promise = Promise.resolve(state.record);
            notify();
            return state.promise;
        }
        notify();
        state.promise = build(slot, state).catch((error) => {
            if (slots.get(slot) === state) {
                state.error = error;
                notify();
            }
            throw error;
        });
        return state.promise;
    }

    function release(slot) {
        if (slots.delete(slot)) notify();
    }

    function getSlotState(slot) {
        const state = slots.get(slot);
        if (!state) return null;
        return {
            trackKey: state.trackKey,
            ready: matches(state.record, state.trackKey, state.challenge),
            error: state.error,
        };
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return {
        prepare,
        prepareLoaded,
        release,
        findRecord,
        getSlotState,
        subscribe,
    };
}
