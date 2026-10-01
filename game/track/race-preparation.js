// Prepares race tracks before a Start can run them. A preparation confirms the
// layout with the server, loads the definition, and builds the walls and the
// track picture. Start then installs the prepared record. It never asks the
// server and never waits, so the previous track never stays on screen.
//
// Each slot holds the record of one target: the Daily, the Campaign stage, the
// selected card, the Campaign Next stage or the Head to Head track. A record
// keeps its own references to the walls and the picture, so other tracks that
// push them out of the asset caches do not undo it. A new target for a slot
// replaces its record, and a late answer for an older target is dropped.

import { getTrackCanvasAsset, getTrackRuntimeAsset } from './assets.js';
import { getLoadedClientTrack, loadClientTrack } from './client-registry.js';
import { getTrackDefinitionIdentity } from './definition-identity.js';
import {
    createDailyChallengePresentationEvent,
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from './presentation.js';
import { ensureStoredTracks } from './stored-track-service.js';

export const PREPARATION_SLOTS = Object.freeze({
    DAILY: 'daily',
    CAMPAIGN: 'campaign',
    SELECTED: 'selected',
    NEXT: 'next',
    CHALLENGE: 'challenge',
});

function assetOptionsKey(options = {}) {
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
        if (record.optionsKey !== assetOptionsKey(getAssetOptions())) return false;
        return resolveRacePresentation(trackKey, latest, challenge).key === record.presentation.key;
    }

    function findRecord(trackKey, challenge = null) {
        if (typeof trackKey !== 'string' || !trackKey) return null;
        for (const state of slots.values()) {
            if (matches(state.record, trackKey, challenge)) return state.record;
        }
        return null;
    }

    async function build(slot, state, beforeBuild) {
        const { trackKey, challenge } = state;
        if (needsConfirmation(trackKey, challenge)) {
            await ensureStoredTracks([trackKey], { requireConfirmation: true });
        }
        const track = await loadClientTrack(trackKey);
        if (slots.get(slot) !== state) return null;
        if (!track) throw new Error('The track layout could not be confirmed. Retry before racing.');
        // The walls and the picture block the screen while they build. The
        // caller can wait for a quiet moment, or stop the build.
        if (beforeBuild && await beforeBuild() === false) {
            if (slots.get(slot) === state) slots.delete(slot);
            return null;
        }
        if (slots.get(slot) !== state) return null;
        const options = getAssetOptions();
        const presentation = resolveRacePresentation(trackKey, track, challenge);
        const runtime = getTrackRuntimeAsset(trackKey, track, options);
        const canvasAsset = getTrackCanvasAsset(trackKey, track, { ...options, presentation });
        state.record = Object.freeze({
            trackKey,
            identity: getTrackDefinitionIdentity(track),
            optionsKey: assetOptionsKey(options),
            track,
            runtime,
            canvasAsset,
            presentation,
        });
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
        if (current?.trackKey === trackKey && current.challenge === challenge && current.promise
            && !current.error && (!current.record || matches(current.record, trackKey, challenge))) {
            return current.promise;
        }
        const state = {
            token: ++nextToken,
            trackKey,
            challenge,
            record: findRecord(trackKey, challenge),
            error: null,
            promise: null,
        };
        slots.set(slot, state);
        if (state.record) {
            state.promise = Promise.resolve(state.record);
            notify();
            return state.promise;
        }
        notify();
        state.promise = build(slot, state, beforeBuild).catch((error) => {
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
        release,
        findRecord,
        isReady: (trackKey, challenge = null) => Boolean(findRecord(trackKey, challenge)),
        getSlotState,
        subscribe,
    };
}
