import {
    cache as devvitCache,
    context,
} from '@devvit/web/server';
import type { JsonValue } from '@devvit/shared-types/json.js';

export type SharedCacheOptions = {
    key: string;
    ttl: number;
};

export type SharedCacheImplementation = <T extends JsonValue>(
    source: () => Promise<T>,
    options: SharedCacheOptions,
) => Promise<T>;

function hasServerRequestContext(): boolean {
    try {
        return Boolean(context?.subredditId);
    } catch (_error) {
        // Devvit's context proxy throws in standalone tests and local tools instead of returning undefined.
        return false;
    }
}

export async function cacheSharedJson<T extends JsonValue>(
    source: () => Promise<T>,
    options: SharedCacheOptions,
    cacheImplementation: SharedCacheImplementation = devvitCache,
): Promise<T> {
    if (!hasServerRequestContext()) {
        return source();
    }

    let sourceStarted = false;
    let sourceReturned = false;
    let sourceValue: T;
    const wrappedSource = async (): Promise<T> => {
        sourceStarted = true;
        const value = await source();
        sourceValue = value;
        sourceReturned = true;
        return value;
    };

    try {
        return await cacheImplementation(wrappedSource, options);
    } catch (error) {
        if (sourceReturned) {
            return sourceValue;
        }
        if (!sourceStarted) {
            return source();
        }
        throw error;
    }
}
