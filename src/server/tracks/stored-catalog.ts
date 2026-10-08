import { redis } from '@devvit/redis';
import {
    STORED_TRACKS_REVISION_KEY,
    loadStoredTrackEntries,
    publishStoredTrackIndex,
    readStoredTrackCacheRevision,
    readStoredTrackIndex,
    readStoredTrackInstallScope,
    repinStoredTracks,
} from './track-store.js';
import {
    STORED_SERIES_REVISION_KEY,
    publishStoredSeriesSnapshot,
    readStoredSeriesCacheRevision,
    readStoredSeriesSnapshot,
    repinStoredSeries,
} from '../campaign/series-store.js';
import { TrackPlacementRetryError } from './track-placement-lock.js';

// The stored tracks and series a request relies on; if they cannot load, the request answers retry.
export class StoredCatalogUnavailableError extends TrackPlacementRetryError {
    constructor(cause?: unknown) {
        super('The tracks could not load. Try again.');
        this.name = 'StoredCatalogUnavailableError';
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

const LOAD_ATTEMPTS = 3;
const RETRY_WAITS_MS = [50, 150];

type CatalogRevisions = { tracks: string; series: string };

function parseRevision(value: unknown): string {
    if (value === null || value === undefined) return '0';
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    throw new Error('A stored catalog revision could not be read.');
}

// One read for both revisions; saves and publications change their revision in the same transaction.
async function readCatalogRevisions(): Promise<CatalogRevisions> {
    const values = await redis.mGet([STORED_TRACKS_REVISION_KEY, STORED_SERIES_REVISION_KEY]);
    if (!Array.isArray(values) || values.length !== 2) {
        throw new Error('The stored catalog revisions could not be read.');
    }
    return { tracks: parseRevision(values[0]), series: parseRevision(values[1]) };
}

// Refreshes the install's track list and series (no tracks); publishes both only if neither revision changed.
export async function ensureStoredCatalogLoaded(): Promise<void> {
    const scope = readStoredTrackInstallScope();
    if (!scope) return;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_WAITS_MS[attempt - 1]));
        try {
            const before = await readCatalogRevisions();
            if (readStoredTrackCacheRevision(scope) === before.tracks
                && readStoredSeriesCacheRevision(scope) === before.series) return;
            const tracks = await readStoredTrackIndex(before.tracks);
            const series = await readStoredSeriesSnapshot(before.series);
            const after = await readCatalogRevisions();
            if (after.tracks !== before.tracks || after.series !== before.series) {
                lastError = new Error('The stored catalog changed while it loaded.');
                continue;
            }
            publishStoredTrackIndex(scope, tracks);
            publishStoredSeriesSnapshot(scope, series);
            return;
        } catch (error) {
            lastError = error;
        }
    }
    throw new StoredCatalogUnavailableError(lastError);
}

// Reloads and pins the catalog for the rest of the request.
export async function reloadPinnedCatalog(): Promise<void> {
    await ensureStoredCatalogLoaded();
    repinStoredSeries();
    repinStoredTracks();
}

// Loads the listed tracks in one read; a mismatch re-pins the list a few times, then answers retry, never omits.
export async function loadStoredTracks(trackKeys: readonly (string | null | undefined)[]): Promise<void> {
    const keys = trackKeys.filter((trackKey): trackKey is string => typeof trackKey === 'string' && Boolean(trackKey));
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await reloadPinnedCatalog();
        try {
            if (await loadStoredTrackEntries(keys)) return;
        } catch (error) {
            if (attempt === LOAD_ATTEMPTS - 1) throw new StoredCatalogUnavailableError(error);
        }
    }
    throw new StoredCatalogUnavailableError(new Error('A stored track did not match the track list.'));
}

// Rereads the catalog once the route knows its tracks (another server may have placed one), then loads them.
export async function confirmStoredTracks(trackKeys: readonly (string | null | undefined)[]): Promise<void> {
    await reloadPinnedCatalog();
    await loadStoredTracks(trackKeys);
}
