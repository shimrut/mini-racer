import { describe, it, expect, afterEach, vi } from 'vitest';
import { getCachedDailyChallengeSnapshot } from '../game/daily-challenge/service.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

describe('daily-challenge snapshot hydrate once', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('does not re-read localStorage after the first snapshot hydration pass', () => {
        const validSnapshot = {
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            leaderboardEntryCount: 0,
            objectiveType: 'single_lap_fastest',
            playerRank: null,
            playerRankLabel: '--',
        };
        const storage = createMemoryLocalStorage({
            VectorGpDailyChallengeSnapshotCache: JSON.stringify({
                entries: {
                    'hydrate-once-snapshot': {
                        snapshot: validSnapshot,
                        expiresAt: Date.now() + 60_000,
                    },
                },
            }),
        });
        globalThis.window = { localStorage: storage };

        expect(getCachedDailyChallengeSnapshot('hydrate-once-snapshot')).toMatchObject(validSnapshot);

        storage.setItem(
            'VectorGpDailyChallengeSnapshotCache',
            JSON.stringify({
                entries: {
                    'should-not-rehydrate': {
                        snapshot: validSnapshot,
                        expiresAt: Date.now() + 60_000,
                    },
                },
            }),
        );

        expect(getCachedDailyChallengeSnapshot('should-not-rehydrate')).toBeNull();
        expect(getCachedDailyChallengeSnapshot('hydrate-once-snapshot')).toMatchObject(validSnapshot);
    });
});
