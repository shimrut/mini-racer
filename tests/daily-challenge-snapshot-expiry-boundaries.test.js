import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    getCachedDailyChallengeSnapshot,
    getDailyChallengeSnapshot,
} from '../game/daily-challenge/service.js';

// Fresh module graph for snapshot expiry boundary checks.

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

describe('daily-challenge snapshot expiry boundaries', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('evicts a cached snapshot when expiresAt is exactly now', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        globalThis.window = { localStorage: createMemoryLocalStorage() };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 0,
                objectiveType: 'single_lap_fastest',
            }),
        });

        const challengeId = 'snapshot-expires-exactly-now';
        await getDailyChallengeSnapshot({ challengeId, forceRefresh: true });
        expect(getCachedDailyChallengeSnapshot(challengeId)).not.toBeNull();

        vi.setSystemTime(new Date('2026-07-19T00:00:00.001Z'));
        expect(getCachedDailyChallengeSnapshot(challengeId)).toBeNull();
    });

    it('persists only non-expired snapshot entries when rewriting storage', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const storage = createMemoryLocalStorage();
        globalThis.window = { localStorage: storage };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 0,
                objectiveType: 'single_lap_fastest',
            }),
        });

        await getDailyChallengeSnapshot({ challengeId: 'persist-valid-snapshot', forceRefresh: true });
        vi.setSystemTime(new Date('2026-07-19T00:00:00.001Z'));
        await getDailyChallengeSnapshot({ challengeId: 'persist-expired-snapshot', forceRefresh: true });

        const stored = JSON.parse(storage.getItem('VectorGpDailyChallengeSnapshotCache'));
        expect(Object.keys(stored.entries)).toEqual(['persist-expired-snapshot']);
    });
});
