// Loads the stored tracks that the server names, before the game reads them.
// The server gives a track only after it is placed in a Daily or a published
// series. The Daily answers carry their stored tracks. For another key that
// the app does not have, the game asks the server once, and again after a few
// minutes, when a new Daily can start.

import { isBuiltInTrack } from './catalog.js';
import { getStoredTrack, registerStoredTrack, unregisterStoredTrack } from './stored-tracks.js';

const STORED_TRACKS_URL = '/api/tracks/stored';
const TRACK_KEY_RE = /^[a-z][A-Za-z0-9]{2,39}$/;
const CHECK_AGAIN_AFTER_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_KEYS_PER_REQUEST = 50;

const checkedAtByKey = new Map();
const confirmedKeys = new Set();
const pendingByKey = new Map();

function isTrackPoint(value) {
    return value && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y)
        && (value.cornerRadius === undefined || (Number.isFinite(value.cornerRadius) && value.cornerRadius >= 0));
}

function isTrackLine(value) {
    return value && isTrackPoint(value.p1) && isTrackPoint(value.p2);
}

function toStoredEntry(raw) {
    const track = raw?.track;
    if (typeof raw?.key !== 'string' || !TRACK_KEY_RE.test(raw.key)
        || !track || typeof track !== 'object'
        || !Array.isArray(track.outer) || track.outer.length < 3 || !track.outer.every(isTrackPoint)
        || !Array.isArray(track.inner) || track.inner.length < 3 || !track.inner.every(isTrackPoint)
        || !isTrackPoint(track.startPos) || !isTrackLine(track.startLine)
        || !Number.isFinite(track.startAngle)
        || !Array.isArray(track.checkpoints) || !track.checkpoints.every(isTrackLine)
        || (track.cornerRadius !== undefined && (!Number.isFinite(track.cornerRadius) || track.cornerRadius < 0))) {
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
export function registerStoredTracksFromPayload(tracks, { confirmedTrackKeys = [] } = {}) {
    const requested = [...new Set(confirmedTrackKeys.filter((key) => typeof key === 'string' && TRACK_KEY_RE.test(key)))];
    if (requested.length && !Array.isArray(tracks)) return;
    const entries = (Array.isArray(tracks) ? tracks : []).map(toStoredEntry);
    if (requested.length && entries.some((entry) => !entry)) {
        requested.forEach((key) => confirmedKeys.delete(key));
        throw new Error('The track layout could not be confirmed. Retry before racing.');
    }
    if (requested.some((key) => !isBuiltInTrack(key) && !entries.some((entry) => entry?.key === key))) {
        requested.forEach((key) => confirmedKeys.delete(key));
        throw new Error('The track layout could not be confirmed. Retry before racing.');
    }
    for (const entry of entries) {
        if (entry) {
            registerStoredTrack(entry);
            // Authoritative Campaign answers also carry the tracks of the
            // other published series. Reuse those confirmations too.
            if (requested.length) confirmedKeys.add(entry.key);
        }
    }
    for (const key of requested) {
        if (isBuiltInTrack(key) && !entries.some((entry) => entry?.key === key)) unregisterStoredTrack(key);
        confirmedKeys.add(key);
    }
}

function needsCheck(trackKey, nowMs, includeBuiltIn, requireConfirmation) {
    if (typeof trackKey !== 'string' || !TRACK_KEY_RE.test(trackKey)) return false;
    if (!includeBuiltIn && isBuiltInTrack(trackKey)) return false;
    if (requireConfirmation) return !confirmedKeys.has(trackKey) && !pendingByKey.has(trackKey);
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
        if (!Array.isArray(body?.tracks)) throw new Error('The track layout could not be confirmed. Retry before racing.');
        if (body.tracks.some((raw) => !toStoredEntry(raw))) {
            throw new Error('The track layout could not be confirmed. Retry before racing.');
        }
        const requestedTracks = body.tracks.filter((raw) => trackKeys.includes(raw?.key));
        // A binding API answer can confirm a newer layout while this cosmetic
        // request is in flight. It takes precedence over the older request.
        registerStoredTracksFromPayload(requestedTracks.filter((raw) => !confirmedKeys.has(raw.key)));
        trackKeys.forEach((key) => {
            if (!confirmedKeys.has(key) && isBuiltInTrack(key)
                && !requestedTracks.some((raw) => raw.key === key)) unregisterStoredTrack(key);
        });
        return trackKeys.filter((key) => isBuiltInTrack(key) || requestedTracks.some((raw) => raw.key === key));
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
    }
}

// Cosmetic prefetch remains best effort. Race preparation uses
// requireConfirmation, including built-in keys, and must expose Retry on a
// failed/invalid answer. A successful empty answer confirms the app definition.
export async function ensureStoredTracks(trackKeys = [], { includeBuiltIn = false, requireConfirmation = false } = {}) {
    const wanted = [...new Set(Array.isArray(trackKeys) ? trackKeys : [trackKeys])];
    if (requireConfirmation && wanted.every((key) => !key || confirmedKeys.has(key))) return;
    if (typeof fetch !== 'function') {
        if (requireConfirmation) throw new Error('The track layout could not be confirmed. Retry before racing.');
        return;
    }
    const nowMs = Date.now();
    const missing = wanted.filter((trackKey) => needsCheck(trackKey, nowMs, includeBuiltIn || requireConfirmation, requireConfirmation));
    const waits = wanted.flatMap((trackKey) => (pendingByKey.has(trackKey) ? [pendingByKey.get(trackKey)] : []));
    for (let index = 0; index < missing.length; index += MAX_KEYS_PER_REQUEST) {
        const batch = missing.slice(index, index + MAX_KEYS_PER_REQUEST);
        const request = requestStoredTracks(batch)
            .then((answeredKeys) => {
                batch.forEach((trackKey) => checkedAtByKey.set(trackKey, Date.now()));
                return answeredKeys;
            })
            .finally(() => {
                batch.forEach((trackKey) => {
                    if (pendingByKey.get(trackKey) === request) pendingByKey.delete(trackKey);
                });
            });
        batch.forEach((trackKey) => pendingByKey.set(trackKey, request));
        waits.push(request);
    }
    try {
        const answers = await Promise.all(waits);
        if (requireConfirmation) answers.flat().forEach((key) => confirmedKeys.add(key));
        if (requireConfirmation && wanted.some((key) => typeof key === 'string' && TRACK_KEY_RE.test(key) && !confirmedKeys.has(key))) {
            throw new Error('The track layout could not be confirmed. Retry before racing.');
        }
    } catch (error) {
        if (requireConfirmation) throw error;
        console.warn('Stored tracks could not load:', error);
    }
}

// True when the server confirmed this key's layout in this session.
export function isTrackLayoutConfirmed(trackKey) {
    return confirmedKeys.has(trackKey);
}

export function clearStoredTrackChecksForTests() {
    checkedAtByKey.clear();
    confirmedKeys.clear();
    pendingByKey.clear();
}
