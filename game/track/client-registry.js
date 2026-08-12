import { TRACK_CATALOG, getTrackName } from './catalog.js';

// Track definitions are deliberately loaded one at a time on the client.  The
// server and mapmaker still use the eager TRACKS registry, but the game only
// downloads geometry for the track that its launch target needs first.
const DEFINITION_MODULES = import.meta.glob('./definitions/*.js');
const loadedTracks = new Map();
const pendingLoads = new Map();
export const CLIENT_TRACK_LOAD_TIMEOUT_MS = 20_000;

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
    return loadedTracks.get(trackKey) || null;
}

export function isClientTrackLoaded(trackKey) {
    return loadedTracks.has(trackKey);
}

export async function loadClientTrack(trackKey) {
    if (!Object.prototype.hasOwnProperty.call(TRACK_CATALOG, trackKey)) return null;
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

export async function prefetchClientTracks(trackKeys = []) {
    const uniqueKeys = [...new Set(
        (Array.isArray(trackKeys) ? trackKeys : [])
            .filter((trackKey) => typeof trackKey === 'string'),
    )];
    return Promise.all(uniqueKeys.map((trackKey) => loadClientTrack(trackKey)));
}

export function clearClientTrackRegistryForTests() {
    loadedTracks.clear();
    pendingLoads.clear();
}
