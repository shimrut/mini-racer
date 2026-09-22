import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    formatDailyChallengeBestLabel,
    formatDailyChallengePlaylistAvailabilityLabel,
    formatDailyChallengeResultLabel,
    getActiveDailyChallenge,
    getDailyChallengeBestResult,
    getDailyChallengeCardStatus,
    getDailyChallengeSnapshot,
    prefetchDailyChallengeSnapshots,
} from '../game/daily-challenge/service.js';
import { setDailyChallengeBestTime } from '../game/daily-challenge/storage.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

function buildChallenge(overrides = {}) {
    return {
        id: 'wave3-challenge',
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

describe('daily-challenge service wave3', () => {
    let memoryLocalStorage;

    beforeEach(() => {
        memoryLocalStorage = createMemoryLocalStorage();
        globalThis.window = {
            localStorage: memoryLocalStorage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/game.html',
                protocol: 'https:',
                search: '',
                origin: 'https://example.devvit.net',
            },
        };
        globalThis.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        memoryLocalStorage?._clear?.();
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.devvit;
    });

    it('treats malformed search strings as absent mock params (L45-L49)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '%',
            origin: 'https://example.devvit.net',
        };
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('coerces numeric objectiveType and trims blank skin when caching the active challenge (L133-L136)', async () => {
        fetch.mockResolvedValue(createJsonResponse({
            id: 'cache-coerce-wave3',
            trackKey: 'circuit',
            objectiveType: 42,
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            skin: '   ',
        }));

        await getActiveDailyChallenge();

        const raw = memoryLocalStorage.getItem('VectorGpActiveDailyChallengeCache');
        expect(JSON.parse(raw)).toEqual({
            challenge: {
                id: 'cache-coerce-wave3',
                trackKey: 'circuit',
                rulesRevision: 0,
                objectiveType: 'single_lap_fastest',
                objectiveParams: { lapCount: 1 },
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                skin: 'default',
            },
        });
    });

    it('rejects mockDaily track keys that are not in the catalog (L65)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=not-a-real-track',
            origin: 'http://localhost',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.trackKey).toBe('circuit');
        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('formats sub-minute playlist availability as at least one minute (L679)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-07-18T12:00:30.000Z',
        })).toBe('1m');

        vi.useRealTimers();
    });

    it('returns expired status when both endsAt and availableUntil are invalid (L679, L711)', () => {
        const challenge = buildChallenge({
            endsAt: 'not-a-date',
            availableUntil: 'not-a-date',
        });

        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-18T12:00:00.000Z'))).toEqual({
            key: 'expired',
            label: 'Expired',
        });
    });

    it('returns -- for non-object result payloads (L656)', () => {
        const challenge = buildChallenge();

        expect(formatDailyChallengeResultLabel(challenge, 'not-an-object')).toBe('--');
        expect(formatDailyChallengeResultLabel(challenge, { bestTime: 'bad' })).toBe('--');
    });

    it('formats finite best-time labels with three decimal places (L663-L664)', () => {
        expect(formatDailyChallengeBestLabel('single_lap_fastest', 9.876)).toBe('9.876s');
        expect(formatDailyChallengeBestLabel('single_lap_fastest', null)).toBe('--');
    });

    it('returns a cloned best-result object instead of the internal reference (L595)', () => {
        const challenge = buildChallenge({ id: 'clone-best-result' });
        setDailyChallengeBestTime(challenge, 12.5, 1);

        const first = getDailyChallengeBestResult(challenge);
        const second = getDailyChallengeBestResult(challenge);

        expect(first.bestTime).toBe(12.5);
        expect(first.completedLaps).toBe(1);
        expect(second).toEqual(first);
        expect(first).not.toBe(second);
    });

    it('clears inflight snapshot requests after a failed fetch (L958)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetch.mockRejectedValue(new Error('network down'));

        await expect(getDailyChallengeSnapshot({
            challengeId: 'inflight-cleanup',
            forceRefresh: true,
        })).rejects.toThrow('network down');

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
        }));

        const snapshot = await getDailyChallengeSnapshot({
            challengeId: 'inflight-cleanup',
            forceRefresh: true,
        });

        expect(snapshot.totalCount).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('prefetches only ids that are missing from the snapshot cache (L964-L971)', async () => {
        const cachedId = 'prefetch-cached-wave3';
        const missingId = 'prefetch-missing-wave3';
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
        }));

        await getDailyChallengeSnapshot({ challengeId: cachedId, forceRefresh: true });
        fetch.mockClear();

        await prefetchDailyChallengeSnapshots([cachedId, missingId, '', missingId]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toContain(`challengeId=${missingId}`);
    });
});
