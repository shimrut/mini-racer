import { describe, it, expect, afterEach, vi } from 'vitest';
import { getCachedDailyChallengeSnapshot } from '../game/daily-challenge/service.js';

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

const EMPTY_SNAPSHOT = {
    topRows: [],
    nearbyRows: [],
    currentPlayerRow: null,
    totalCount: 0,
    leaderboardEntryCount: 0,
    objectiveType: 'single_lap_fastest',
    playerRank: null,
    playerRankLabel: '--',
};

describe('daily-challenge snapshot expiry hydrate', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('skips hydrated snapshots whose expiresAt equals now but keeps future entries', () => {
        const now = 1_900_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpDailyChallengeSnapshotCache: JSON.stringify({
                    entries: {
                        'expired-exactly-now': {
                            snapshot: EMPTY_SNAPSHOT,
                            expiresAt: now,
                        },
                        'still-valid': {
                            snapshot: { ...EMPTY_SNAPSHOT, totalCount: 2 },
                            expiresAt: now + 1,
                        },
                    },
                }),
            }),
        };

        expect(getCachedDailyChallengeSnapshot('expired-exactly-now')).toBeNull();
        expect(getCachedDailyChallengeSnapshot('still-valid')).toMatchObject({ totalCount: 2 });
    });
});
