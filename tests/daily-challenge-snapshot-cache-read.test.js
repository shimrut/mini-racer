import { describe, it, expect, afterEach, vi } from 'vitest';
import { getCachedDailyChallengeSnapshot } from '../game/daily-challenge/service.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

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
