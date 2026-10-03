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

// The stored tracks and the published series that a request can rely on.
// If they cannot load, the request cannot know which layout is live, so it
// answers "retry", as a Daily that cannot be confirmed does.
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

// One read for both revisions. A save changes a track and its revision in one
// transaction; a Campaign publication changes both revisions in one.
async function readCatalogRevisions(): Promise<CatalogRevisions> {
    const values = await redis.mGet([STORED_TRACKS_REVISION_KEY, STORED_SERIES_REVISION_KEY]);
    if (!Array.isArray(values) || values.length !== 2) {
        throw new Error('The stored catalog revisions could not be read.');
    }
    return { tracks: parseRevision(values[0]), series: parseRevision(values[1]) };
}

// Brings this install's track list and published series up to date. It reads
// no track: a request loads the tracks that it names. The list and the series
// are read between two reads of their revisions. Only when neither revision
// changed is the pair one picture of Redis, and only then is it published,
// both halves together. A newer pair is never replaced by an older one.
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

// Loads the catalog again, and makes it the track list and the series list
// of this request from now on. A transfer uses it after it blocks saving, and
// a route uses it after it learns its track.
export async function reloadPinnedCatalog(): Promise<void> {
    await ensureStoredCatalogLoaded();
    repinStoredSeries();
    repinStoredTracks();
}

// Loads the listed tracks among these keys for this request, in one read. A
// record that does not match the pinned list means a write landed after the
// list was read: the list is read and pinned again, a few times at most, and
// then the request answers "retry". No record is ever left out.
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

// A route that learned its tracks while it ran reads the catalog again, since
// another server can have placed one of them meanwhile, and then loads them.
export async function confirmStoredTracks(trackKeys: readonly (string | null | undefined)[]): Promise<void> {
    await reloadPinnedCatalog();
    await loadStoredTracks(trackKeys);
}
