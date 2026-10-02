// Priority targets build inside the loader. Selected/Next targets can prewarm
// locally before Start; other pictures use the existing caches. Start consumes
// only loaded definitions and never imports a chunk or asks the server.
//
// Each slot holds the record of one target: the Daily, the Campaign stage, the
// selected card, the Campaign Next stage or the Head to Head track. A record
// keeps its own references to the walls and the picture, so other tracks that
// push them out of the asset caches do not undo it. A new target for a slot
// replaces its record, and a late answer for an older target is dropped.

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

// The race challenge of a Campaign stage or a Head to Head: its presentation
// is the plain one of its track.
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
    let nextToken = 0;

    function notify() {
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                console.error('A race preparation listener failed:', error);
            }
        }
    }

    // A record is ready only while it is the current layout of its key, with
    // the current asset options and the presentation of this challenge.
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

    // Start uses only an already loaded definition. Cache misses rebuild local
    // assets, without importing a definition or asking the server.
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
        // The walls and the picture block the screen while they build. The
        // caller can wait for a quiet moment, or stop the build.
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

    // Prepares the target of a slot. A target that another slot already holds
    // is shared, not built again. `beforeBuild` runs after the server check
    // and the load, just before the build; false stops the build.
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
            token: ++nextToken,
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
        isReady: (trackKey, challenge = null) => Boolean(findRecord(trackKey, challenge)),
        getSlotState,
        subscribe,
    };
}
