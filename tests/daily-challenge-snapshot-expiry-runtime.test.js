import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    getCachedDailyChallengeSnapshot,
    getDailyChallengeSnapshot,
} from '../game/daily-challenge/service.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

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

describe('daily-challenge snapshot expiry runtime', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('drops an in-memory snapshot once expiresAt is no longer strictly in the future', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const challenge = {
            id: 'runtime-snapshot-expiry',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        globalThis.window = { localStorage: createMemoryLocalStorage() };
        cacheDailyChallengePlaylist([challenge]);
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                ...EMPTY_SNAPSHOT,
                totalCount: 3,
            }),
        });

        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });
        expect(getCachedDailyChallengeSnapshot(challenge.id)).toMatchObject({ totalCount: 3 });

        vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
        expect(getCachedDailyChallengeSnapshot(challenge.id)).toBeNull();
    });

    it('prunes expired snapshot entries from storage after they lapse in memory', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const challenge = {
            id: 'persist-prune-runtime',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const storage = createMemoryLocalStorage();
        globalThis.window = { localStorage: storage };
        cacheDailyChallengePlaylist([challenge]);
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ...EMPTY_SNAPSHOT, totalCount: 4 }),
        });

        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });
        expect(JSON.parse(storage.getItem('VectorGpDailyChallengeSnapshotCache')).entries[challenge.id]).toBeTruthy();

        vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
        expect(getCachedDailyChallengeSnapshot(challenge.id)).toBeNull();
        expect(JSON.parse(storage.getItem('VectorGpDailyChallengeSnapshotCache')).entries).toEqual({});
    });
});
