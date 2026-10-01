// Tracks made in the Creator live in the game's database, not in the app.
// The game and the server put them in this list before they look up a track.
// A stored track wins over a built-in track with the same key, so a copy of a
// built-in track in the database replaces the app copy.
//
// A stored entry: { key, name, ground, medalRow, track }. `track` is the shape
// with its name. `medalRow` is { gold, silver, bronze, author } or null.
// Its identity helper is independent of the catalog and the medal times.

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

// The server gives each subreddit its own stored tracks, so it replaces the
// lookup for the current request. The game keeps the local list. `exists`
// answers whether a key is stored without loading the track.
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
