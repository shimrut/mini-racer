import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    formatDailyChallengeResultLabel,
    getActiveDailyChallenge,
    getDailyChallengeCopyLabels,
    getDailyChallengeObjectiveLabel,
    getDailyChallengeTrackName,
    requestFeaturedDailyChallengeStart,
    resolveDailyPlaylistCacheExpiresAt,
} from '../game/daily-challenge/service.js';

const ACTIVE_DAILY_CACHE_KEY = 'VectorGpActiveDailyChallengeCache';
const DAILY_START_OVERRIDE_KEY = 'VectorGpDailyStartOverride';

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
        id: 'wave5-challenge',
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

describe('daily-challenge service wave5', () => {
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
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.devvit;
    });

    it('normalizes devvit post-bound challenges with trimmed skin and default objective params (L125-L137, L286-L288)', async () => {
        // Pinned: the challenge window below is fixed, so a real clock past
        // availableUntil would drop it as expired before it can be normalized.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        globalThis.devvit = {
            context: {
                postData: {
                    challenge: {
                        id: 'post-bound-wave5',
                        trackKey: 'circuit',
                        startsAt: '2026-07-18T00:00:00.000Z',
                        endsAt: '2026-07-19T00:00:00.000Z',
                        availableUntil: '2026-07-25T00:00:00.000Z',
                        objectiveType: 'single_lap_fastest',
                        objectiveParams: 'not-an-object',
                        skin: '  neon  ',
                    },
                },
            },
        };
        fetch.mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('post-bound-wave5');
        expect(challenge.skin).toBe('neon');
        expect(challenge.objectiveParams).toEqual({ lapCount: 1 });
    });

    it('uses mockDaily track keys from the query string on preview pages (L65-L66)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location.pathname = '/preview.html';
        window.location.search = '?mockDaily=jadeSpiralCircuit';
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.trackKey).toBe('jadeSpiralCircuit');
        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('merges playlist cache entries by challenge id when caching (L405-L417)', () => {
        // Pinned: buildChallenge defaults to a fixed availableUntil, so a real clock
        // past it would prune the merged entries before they can be asserted on.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const first = buildChallenge({ id: 'merge-a', trackKey: 'circuit' });
        const updated = buildChallenge({
            id: 'merge-a',
            trackKey: 'desertBridge',
            availableUntil: '2026-07-30T00:00:00.000Z',
        });
        const second = buildChallenge({ id: 'merge-b', trackKey: 'jadeSpiralCircuit' });

        cacheDailyChallengePlaylist([first]);
        const merged = cacheDailyChallengePlaylist([updated, second]);

        expect(merged.find((entry) => entry.id === 'merge-a')?.trackKey).toBe('desertBridge');
        expect(merged.find((entry) => entry.id === 'merge-b')?.trackKey).toBe('jadeSpiralCircuit');
        expect(merged.filter((entry) => entry.id === 'merge-a')).toHaveLength(1);
    });

    it('falls back to the next UTC day when no schedule change is more than one second away (L431-L433)', () => {
        const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
        const expiresAt = resolveDailyPlaylistCacheExpiresAt([
            buildChallenge({
                startsAt: '2026-07-18T12:00:00.500Z',
                endsAt: '2026-07-18T12:00:00.500Z',
                availableUntil: '2026-07-18T12:00:00.500Z',
            }),
        ], nowMs);

        expect(expiresAt).toBe(Date.parse('2026-07-19T00:00:00.000Z'));
        expect(expiresAt).toBeGreaterThan(nowMs + 1000);
    });

    it('writes and clears the featured start override via localStorage (L253-L265)', () => {
        requestFeaturedDailyChallengeStart();

        const raw = memoryLocalStorage.getItem(DAILY_START_OVERRIDE_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw);
        expect(parsed.mode).toBe('featured');
        expect(parsed.expiresAt).toBeGreaterThan(Date.now());
    });

    it('returns a still-valid active-cache entry when the server fetch fails (L211-L214, L788-L792)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        memoryLocalStorage.setItem(ACTIVE_DAILY_CACHE_KEY, JSON.stringify({
            challenge: {
                id: 'fresh-cache',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
                endsAt: '2099-01-01T00:00:00.000Z',
                availableUntil: '2099-01-08T00:00:00.000Z',
                skin: 'default',
            },
        }));
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('fresh-cache');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('formats copy labels and result lines for lap and race objectives (L620-L660)', () => {
        const single = buildChallenge({ objectiveType: 'single_lap_fastest' });
        const multi = buildChallenge({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
        });

        expect(getDailyChallengeObjectiveLabel(single)).toBe('1 lap');
        expect(getDailyChallengeObjectiveLabel(multi)).toBe('3 laps');
        expect(getDailyChallengeCopyLabels(single).modeSelectLine).toBe('Best lap time');
        expect(getDailyChallengeCopyLabels(multi).bestSummaryLabel).toBe('Best Race');
        expect(formatDailyChallengeResultLabel(single, { bestTime: 12.345 })).toBe('12.35s');
        expect(formatDailyChallengeResultLabel(single, null)).toBe('--');
        expect(getDailyChallengeTrackName({ trackKey: 'circuit' })).not.toBe('Unknown Track');
        expect(getDailyChallengeTrackName({ trackKey: 'missing-track' })).toBe('Unknown Track');
    });
});
