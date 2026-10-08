import { TRACK_CATALOG, getTrackName } from './catalog.js';
import { getStoredTrack } from './stored-tracks.js';
import { ensureStoredTracks } from './stored-track-service.js';

const DEFINITION_MODULES = import.meta.glob('./definitions/*.js');
const loadedTracks = new Map();
const pendingLoads = new Map();
export const CLIENT_TRACK_LOAD_TIMEOUT_MS = 20_000;
// Asks the server for a stored track that the game does not have yet.
const defaultStoredTrackLoader = (trackKey) => ensureStoredTracks([trackKey]);
let storedTrackLoader = defaultStoredTrackLoader;

export function setStoredTrackLoader(loader) {
    storedTrackLoader = typeof loader === 'function' ? loader : defaultStoredTrackLoader;
}

export function communityTrackKey(mapId) {
    return `community:${mapId}`;
}

export function registerCommunityTrack(mapId, name, track) {
    if (typeof mapId !== 'string' || !/^[a-f0-9-]{36}$/i.test(mapId)
        || !track || typeof track !== 'object') {
        throw new Error('Invalid Community map.');
    }
    const key = communityTrackKey(mapId);
    const definition = Object.freeze({ ...track, name: String(name || track.name || 'Community map') });
    loadedTracks.set(key, definition);
    return key;
}

export function waitForClientTrackDefinition(
    loadPromise,
    trackKey,
    timeoutMs = CLIENT_TRACK_LOAD_TIMEOUT_MS,
) {
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Timed out loading the ${trackKey} track.`));
        }, timeoutMs);
    });
    return Promise.race([loadPromise, timeout]).finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId);
    });
}

function toDefinitionFilename(trackKey) {
    const kebabKey = String(trackKey)
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_$]+/g, '-')
        .replace(/[^A-Za-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-')
        .toLowerCase();
    return `./definitions/${kebabKey}.js`;
}

function normalizeTrack(trackKey, value) {
    if (!value || typeof value !== 'object') return null;
    return Object.freeze({
        name: getTrackName(trackKey),
        ...value,
    });
}

export function getLoadedClientTrack(trackKey) {
    return getStoredTrack(trackKey)?.track || loadedTracks.get(trackKey) || null;
}

// Menus wait for this before showing tracks; Redis picks the source, built-ins still need their chunks.
export async function loadRaceDefinitions(trackKeys = [], { requireConfirmation = true } = {}) {
    const keys = [...new Set((Array.isArray(trackKeys) ? trackKeys : [trackKeys])
        .filter((key) => typeof key === 'string' && key))];
    const serverKeys = keys.filter((key) => !key.startsWith('community:'));
    if (requireConfirmation && serverKeys.length) {
        await ensureStoredTracks(serverKeys, { requireConfirmation: true });
    }
    return Promise.all(keys.map(async (key) => {
        const track = await loadClientTrack(key);
        if (!track) throw new Error(`The ${key} track could not load. Try again.`);
        return track;
    }));
}

function loadStoredClientTrack(trackKey) {
    const pending = pendingLoads.get(trackKey);
    if (pending) return pending;
    const promise = waitForClientTrackDefinition(storedTrackLoader(trackKey), trackKey)
        .then(() => getStoredTrack(trackKey)?.track || null)
        .finally(() => {
            if (pendingLoads.get(trackKey) === promise) pendingLoads.delete(trackKey);
        });
    pendingLoads.set(trackKey, promise);
    return promise;
}

export async function loadClientTrack(trackKey) {
    if (typeof trackKey === 'string' && trackKey.startsWith('community:')) {
        return loadedTracks.get(trackKey) || null;
    }
    const stored = getStoredTrack(trackKey);
    if (stored?.track) return stored.track;
    if (!Object.prototype.hasOwnProperty.call(TRACK_CATALOG, trackKey)) {
        return typeof trackKey === 'string' && trackKey && storedTrackLoader
            ? loadStoredClientTrack(trackKey)
            : null;
    }
    const existing = loadedTracks.get(trackKey);
    if (existing) return existing;
    const pending = pendingLoads.get(trackKey);
    if (pending) return pending;

    const importer = DEFINITION_MODULES[toDefinitionFilename(trackKey)];
    if (typeof importer !== 'function') {
        throw new Error(`No client track definition was generated for ${trackKey}.`);
    }

    const promise = waitForClientTrackDefinition(importer(), trackKey)
        .then((module) => {
            const track = normalizeTrack(trackKey, module?.default);
            if (!track) throw new Error(`Track definition ${trackKey} was empty.`);
            loadedTracks.set(trackKey, track);
            return track;
        })
        .finally(() => {
            if (pendingLoads.get(trackKey) === promise) pendingLoads.delete(trackKey);
        });
    pendingLoads.set(trackKey, promise);
    return promise;
}

export function clearClientTrackRegistryForTests() {
    loadedTracks.clear();
    pendingLoads.clear();
}
