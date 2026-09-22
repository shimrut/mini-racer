import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    getCachedDailyChallengeSnapshot,
    getDailyChallengeBestResult,
    getDailyChallengeSnapshot
} from '../game/daily-challenge/service.js';
import { getDailyChallengeData } from '../game/daily-challenge/storage.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

describe('daily-challenge snapshot cache storage', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('hydrates only the valid, non-expired entries from a stored snapshot cache', () => {
        const validSnapshot = {
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            leaderboardEntryCount: 0,
            objectiveType: 'single_lap_fastest',
            playerRank: null,
            playerRankLabel: '--'
        };
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpDailyChallengeSnapshotCache: JSON.stringify({
                    entries: {
                        'valid-hydrated-challenge': {
                            snapshot: validSnapshot,
                            expiresAt: Date.now() + 60_000
                        },
                        'expired-hydrated-challenge': {
                            snapshot: validSnapshot,
                            expiresAt: Date.now() - 60_000
                        },
                        'malformed-hydrated-challenge': null
                    }
                })
            })
        };

        expect(getCachedDailyChallengeSnapshot('valid-hydrated-challenge')).toMatchObject(validSnapshot);
        expect(getCachedDailyChallengeSnapshot('expired-hydrated-challenge')).toBeNull();
        expect(getCachedDailyChallengeSnapshot('malformed-hydrated-challenge')).toBeNull();
    });

    it('keeps the in-memory snapshot cache updated even when persisting it throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.window = { localStorage: createMemoryLocalStorage() };
        globalThis.window.localStorage.setItem = () => { throw new Error('quota exceeded'); };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 0,
                objectiveType: 'single_lap_fastest'
            })
        });

        const challengeId = 'write-error-snapshot-challenge';
        await getDailyChallengeSnapshot({ challengeId, forceRefresh: true });

        expect(getCachedDailyChallengeSnapshot(challengeId)).not.toBeNull();
        expect(console.error).toHaveBeenCalledWith(
            'Error writing daily snapshot cache:',
            expect.any(Error)
        );
    });

    it('syncs a cached snapshot player row into daily challenge storage when the playlist knows the challenge', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const challenge = {
            id: 'sync-best-from-snapshot',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            status: 'active',
            objectiveParams: {},
            skin: 'default',
        };
        globalThis.window = { localStorage: createMemoryLocalStorage() };
        cacheDailyChallengePlaylist([challenge]);
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: {
                    bestTimeMs: 14250,
                    completedLaps: 1,
                    checkpointTimesSec: [4.1, 8.2],
                },
                totalCount: 1,
                objectiveType: 'single_lap_fastest',
            }),
        });

        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeData(challenge.id)).toMatchObject({
            bestTime: 14.25,
            completedLaps: 1,
            checkpointTimesSec: [4.1, 8.2],
        });
        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 14.25,
            completedLaps: 1,
        });
    });

    it('does not sync snapshot bests when the challenge is missing from the playlist cache', async () => {
        globalThis.window = { localStorage: createMemoryLocalStorage() };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: { bestTimeMs: 15000 },
                totalCount: 1,
                objectiveType: 'single_lap_fastest',
            }),
        });

        const challengeId = 'orphan-snapshot-challenge';
        await getDailyChallengeSnapshot({ challengeId, forceRefresh: true });

        expect(getDailyChallengeData(challengeId)).toBeNull();
        expect(getCachedDailyChallengeSnapshot(challengeId)).not.toBeNull();
    });
});
