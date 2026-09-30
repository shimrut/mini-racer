// Loads the stored tracks that the server names, before the game reads them.
// The server gives a track only after it is placed in a Daily or a published
// series. The Daily answers carry their stored tracks. For another key that
// the app does not have, the game asks the server once, and again after a few
// minutes, when a new Daily can start.

import { isBuiltInTrack } from './catalog.js';
import { getStoredTrack, registerStoredTrack } from './stored-tracks.js';

const STORED_TRACKS_URL = '/api/tracks/stored';
const TRACK_KEY_RE = /^[a-z][A-Za-z0-9]{2,39}$/;
const CHECK_AGAIN_AFTER_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_KEYS_PER_REQUEST = 50;

const checkedAtByKey = new Map();
const pendingByKey = new Map();

function isTrackPoint(value) {
    return value && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function toStoredEntry(raw) {
    const track = raw?.track;
    if (typeof raw?.key !== 'string' || !TRACK_KEY_RE.test(raw.key)
        || !track || typeof track !== 'object'
        || !Array.isArray(track.outer) || !Array.isArray(track.inner)
        || !isTrackPoint(track.startPos)) {
        return null;
    }
    const name = typeof raw.name === 'string' && raw.name ? raw.name : String(track.name || raw.key);
    return {
        key: raw.key,
        name,
        ground: typeof raw.ground === 'string' ? raw.ground : 'tarmac',
        medalRow: raw.medalRow && typeof raw.medalRow === 'object' ? raw.medalRow : null,
        track: Object.freeze({ ...track, name }),
    };
}

// Registers the stored tracks that a server answer carries.
export function registerStoredTracksFromPayload(tracks) {
    for (const raw of Array.isArray(tracks) ? tracks : []) {
        const entry = toStoredEntry(raw);
        if (entry) registerStoredTrack(entry);
    }
}

function needsCheck(trackKey, nowMs, includeBuiltIn) {
    if (typeof trackKey !== 'string' || !TRACK_KEY_RE.test(trackKey)) return false;
    if (!includeBuiltIn && isBuiltInTrack(trackKey)) return false;
    if (getStoredTrack(trackKey)?.track) return false;
    if (pendingByKey.has(trackKey)) return false;
    const checkedAt = checkedAtByKey.get(trackKey);
    return !(Number.isFinite(checkedAt) && nowMs - checkedAt < CHECK_AGAIN_AFTER_MS);
}

async function requestStoredTracks(trackKeys) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
        const response = await fetch(
            `${STORED_TRACKS_URL}?keys=${encodeURIComponent(trackKeys.join(','))}`,
            { method: 'GET', headers: { Accept: 'application/json' }, signal: controller?.signal },
        );
        if (!response.ok) throw new Error(`Stored tracks unavailable (${response.status}).`);
        const body = await response.json();
        for (const raw of Array.isArray(body?.tracks) ? body.tracks : []) {
            const entry = toStoredEntry(raw);
            if (entry && trackKeys.includes(entry.key)) registerStoredTrack(entry);
        }
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
    }
}

// Waits until the stored copies of these tracks are in the game. A failed
// request leaves the built-in tracks in use and does not throw. A built-in
// key is asked about only with `includeBuiltIn`, because only an unplayed
// built-in track can have a stored copy.
export async function ensureStoredTracks(trackKeys = [], { includeBuiltIn = false } = {}) {
    if (typeof fetch !== 'function') return;
    const nowMs = Date.now();
    const wanted = [...new Set(Array.isArray(trackKeys) ? trackKeys : [trackKeys])];
    const missing = wanted.filter((trackKey) => needsCheck(trackKey, nowMs, includeBuiltIn));
    const waits = wanted.flatMap((trackKey) => (pendingByKey.has(trackKey) ? [pendingByKey.get(trackKey)] : []));
    for (let index = 0; index < missing.length; index += MAX_KEYS_PER_REQUEST) {
        const batch = missing.slice(index, index + MAX_KEYS_PER_REQUEST);
        const request = requestStoredTracks(batch)
            .then(() => {
                batch.forEach((trackKey) => checkedAtByKey.set(trackKey, Date.now()));
            })
            .catch((error) => {
                console.warn('Stored tracks could not load:', error);
            })
            .finally(() => {
                batch.forEach((trackKey) => {
                    if (pendingByKey.get(trackKey) === request) pendingByKey.delete(trackKey);
                });
            });
        batch.forEach((trackKey) => pendingByKey.set(trackKey, request));
        waits.push(request);
    }
    await Promise.all(waits);
}

export function clearStoredTrackChecksForTests() {
    checkedAtByKey.clear();
    pendingByKey.clear();
}
