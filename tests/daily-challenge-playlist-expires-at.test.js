import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    getDailyChallengeSnapshot,
    resolveDailyPlaylistCacheExpiresAt,
} from '../game/daily-challenge/service.js';

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

function buildChallenge(overrides = {}) {
    return {
        id: 'snapshot-expires-at',
        trackKey: 'circuit',
        startsAt: '2026-07-18T00:00:00.000Z',
        endsAt: '2026-07-19T00:00:00.000Z',
        availableUntil: '2026-07-25T00:00:00.000Z',
        objectiveType: 'single_lap_fastest',
        objectiveParams: {},
        skin: 'default',
        status: 'active',
        ...overrides,
    };
}

describe('daily-challenge playlist expires-at boundaries', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('uses the next schedule change more than one second away for snapshot cache expiry', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-07-18T12:00:00.000Z');
        vi.setSystemTime(now);
        const storage = createMemoryLocalStorage();
        globalThis.window = {
            localStorage: storage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/game.html',
                protocol: 'https:',
                search: '',
                origin: 'https://example.devvit.net',
            },
        };
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

        const farChangeMs = now.getTime() + 5000;
        cacheDailyChallengePlaylist([buildChallenge({
            id: 'far-change',
            endsAt: new Date(farChangeMs).toISOString(),
            availableUntil: new Date(farChangeMs + 60_000).toISOString(),
        })]);

        await getDailyChallengeSnapshot({ challengeId: 'far-change', forceRefresh: true });

        const stored = JSON.parse(storage.getItem('VectorGpDailyChallengeSnapshotCache'));
        expect(stored.entries['far-change'].expiresAt).toBe(farChangeMs);
    });

    it('falls back to the next UTC day when every schedule timestamp is within one second', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-07-18T12:00:00.000Z');
        vi.setSystemTime(now);
        const storage = createMemoryLocalStorage();
        globalThis.window = {
            localStorage: storage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/game.html',
                protocol: 'https:',
                search: '',
                origin: 'https://example.devvit.net',
            },
        };
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

        const nearMs = now.getTime() + 500;
        cacheDailyChallengePlaylist([buildChallenge({
            id: 'near-change',
            startsAt: now.toISOString(),
            endsAt: new Date(nearMs).toISOString(),
            availableUntil: new Date(nearMs).toISOString(),
        })]);

        await getDailyChallengeSnapshot({ challengeId: 'near-change', forceRefresh: true });

        const nextUtcDayStart = Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
        );
        const stored = JSON.parse(storage.getItem('VectorGpDailyChallengeSnapshotCache'));
        expect(stored.entries['near-change'].expiresAt).toBe(nextUtcDayStart);
        expect(stored.entries['near-change'].expiresAt).toBeGreaterThan(nearMs);
    });

    it('picks the soonest playlist change that is more than one second away', () => {
        vi.useFakeTimers();
        const now = new Date('2026-07-18T12:00:00.000Z');
        vi.setSystemTime(now);

        const nearMs = now.getTime() + 500;
        const farMs = now.getTime() + 5000;
        const expiresAt = resolveDailyPlaylistCacheExpiresAt([
            buildChallenge({
                id: 'near-change',
                endsAt: new Date(nearMs).toISOString(),
                availableUntil: new Date(nearMs + 60_000).toISOString(),
            }),
            buildChallenge({
                id: 'far-change',
                endsAt: new Date(farMs).toISOString(),
                availableUntil: new Date(farMs + 60_000).toISOString(),
            }),
        ], now.getTime());

        expect(expiresAt).toBe(farMs);
    });
});
