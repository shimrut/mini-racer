import { describe, it, expect, afterEach, vi } from 'vitest';
import { getCachedDailyChallengeSnapshot } from '../game/daily-challenge/service.js';

// Fresh module graph: first snapshot-cache touch hydrates from localStorage here.

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

describe('daily-challenge snapshot cache read', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('treats corrupted snapshot-cache JSON as empty instead of throwing', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpDailyChallengeSnapshotCache: '{not-json',
            }),
        };

        expect(getCachedDailyChallengeSnapshot('any-challenge')).toBeNull();
        expect(console.error).toHaveBeenCalledWith(
            'Error reading daily snapshot cache:',
            expect.any(Error),
        );
    });
});
