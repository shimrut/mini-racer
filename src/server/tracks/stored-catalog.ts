import { ensureStoredTracksLoaded } from './track-store.js';
import { ensureStoredSeriesLoaded } from '../campaign/series-store.js';

// The stored tracks and the published series that a request can rely on.
// If either cannot load, the request cannot know which layout is live.
export class StoredCatalogUnavailableError extends Error {
    constructor(cause?: unknown) {
        super('The tracks could not load. Try again.');
        this.name = 'StoredCatalogUnavailableError';
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

export async function ensureStoredCatalogLoaded(): Promise<void> {
    const failures: unknown[] = [];
    for (const load of [ensureStoredTracksLoaded, ensureStoredSeriesLoaded]) {
        try {
            await load();
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length) throw new StoredCatalogUnavailableError(failures);
}
