// Creator tracks, looked up before built-ins with the same key, so a stored copy replaces the app track.
// Entry: { key, name, ground, medalRow ({ gold, silver, bronze, author } or null), track }.

import { getTrackDefinitionIdentity } from './definition-identity.js';

const localStoredTracks = new Map();
let storedTrackResolver = (trackKey) => localStoredTracks.get(trackKey) ?? null;
let storedTrackExists = null;

export function getStoredTrack(trackKey) {
    if (typeof trackKey !== 'string' || !trackKey) return null;
    return storedTrackResolver(trackKey) ?? null;
}

export function isStoredTrack(trackKey) {
    if (typeof trackKey !== 'string' || !trackKey) return false;
    return storedTrackExists ? storedTrackExists(trackKey) : getStoredTrack(trackKey) !== null;
}

// The server replaces this lookup per subreddit request; `exists` checks a key without loading it.
export function setStoredTrackResolver(resolver, { exists = null } = {}) {
    storedTrackResolver = typeof resolver === 'function'
        ? resolver
        : (trackKey) => localStoredTracks.get(trackKey) ?? null;
    storedTrackExists = typeof resolver === 'function' && typeof exists === 'function' ? exists : null;
}

export function registerStoredTrack(entry) {
    if (!entry || typeof entry.key !== 'string' || !entry.key) return null;
    const previous = localStoredTracks.get(entry.key);
    const track = previous?.track && entry.track && previous.track.name === entry.track.name
        && getTrackDefinitionIdentity(previous?.track) === getTrackDefinitionIdentity(entry.track)
        ? previous.track
        : entry.track;
    const frozen = Object.freeze({ ...entry, track });
    localStoredTracks.set(entry.key, frozen);
    return frozen;
}

export function unregisterStoredTrack(trackKey) {
    localStoredTracks.delete(trackKey);
}

export function clearStoredTracksForTests() {
    localStoredTracks.clear();
    setStoredTrackResolver(null);
}
