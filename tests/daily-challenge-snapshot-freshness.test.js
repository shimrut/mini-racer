import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    clearDailyChallengeSnapshotFreshness,
    getCachedDailyChallengeSnapshot,
    getDailyChallengeSnapshot,
    getDailyChallengeSnapshotIdsToFetch,
    subscribeToDailyChallengeSnapshots,
} from '../game/daily-challenge/service.js';

const CHALLENGE_ID = 'freshness-challenge';

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

function savedSnapshotStorage(rankLabel, { expiresAt = Date.now() + 60_000 } = {}) {
    return JSON.stringify({
        entries: {
            [CHALLENGE_ID]: {
                snapshot: {
                    topRows: [],
                    nearbyRows: [],
                    currentPlayerRow: null,
                    totalCount: 1,
                    playerRankLabel: rankLabel,
                    objectiveType: 'single_lap_fastest',
                },
                expiresAt,
            },
        },
    });
}

function snapshotResponse(rankLabel) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 1,
            playerRankLabel: rankLabel,
            objectiveType: 'single_lap_fastest',
        }),
    };
}

describe('daily-challenge snapshot freshness', () => {
    beforeEach(() => {
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpDailyChallengeSnapshotCache: savedSnapshotStorage('#12'),
            }),
            location: {
                hostname: 'example.devvit.net',
                pathname: '/game.html',
                protocol: 'https:',
                search: '',
                origin: 'https://example.devvit.net',
            },
        };
        globalThis.fetch = vi.fn(async () => snapshotResponse('#4'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
        delete globalThis.fetch;
        clearDailyChallengeSnapshotFreshness();
    });

    it('paints the saved rank but asks the server for it once per session', async () => {
        expect(getCachedDailyChallengeSnapshot(CHALLENGE_ID).playerRankLabel).toBe('#12');

        const first = await getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID });

        expect(first.playerRankLabel).toBe('#4');
        expect(fetch).toHaveBeenCalledTimes(1);

        const second = await getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID });

        expect(second.playerRankLabel).toBe('#4');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('lists the days the server has not answered yet', async () => {
        expect(getDailyChallengeSnapshotIdsToFetch([CHALLENGE_ID, 'other-day']))
            .toEqual([CHALLENGE_ID, 'other-day']);

        await getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID });

        expect(getDailyChallengeSnapshotIdsToFetch([CHALLENGE_ID, 'other-day']))
            .toEqual(['other-day']);
    });

    it('asks again after a resume, keeping the saved rank on screen', async () => {
        await getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID });
        fetch.mockImplementation(async () => snapshotResponse('#2'));

        clearDailyChallengeSnapshotFreshness();

        expect(getCachedDailyChallengeSnapshot(CHALLENGE_ID).playerRankLabel).toBe('#4');
        expect(await getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID }))
            .toMatchObject({ playerRankLabel: '#2' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('names the day that took a new snapshot, until the listener stops', async () => {
        const seen = [];
        const unsubscribe = subscribeToDailyChallengeSnapshots((challengeId) => {
            seen.push([challengeId, getCachedDailyChallengeSnapshot(challengeId).playerRankLabel]);
        });

        await getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID });

        expect(seen).toEqual([[CHALLENGE_ID, '#4']]);

        unsubscribe();
        clearDailyChallengeSnapshotFreshness();
        await getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID });

        expect(seen).toHaveLength(1);
    });

    it('keeps working when a listener throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const stopFailing = subscribeToDailyChallengeSnapshots(() => {
            throw new Error('listener exploded');
        });
        const seen = [];
        const stopWatching = subscribeToDailyChallengeSnapshots((id) => seen.push(id));

        await expect(getDailyChallengeSnapshot({ challengeId: CHALLENGE_ID }))
            .resolves.toMatchObject({ playerRankLabel: '#4' });
        expect(seen).toEqual([CHALLENGE_ID]);
        expect(console.error).toHaveBeenCalledWith(
            'Error handling daily challenge snapshot update:',
            expect.any(Error),
        );

        stopFailing();
        stopWatching();
    });
});
