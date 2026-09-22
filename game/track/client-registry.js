import { TRACK_CATALOG, getTrackName } from './catalog.js';

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

export function clearClientTrackRegistryForTests() {
    loadedTracks.clear();
    pendingLoads.clear();
}
