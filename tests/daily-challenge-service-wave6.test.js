import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    formatDailyChallengeBestLabel,
    formatDailyChallengePlaylistAvailabilityLabel,
    formatDailyChallengeResultLabel,
    getActiveDailyChallenge,
    getDailyChallengeBestResult,
    getDailyChallengeCardStatus,
    getDailyChallengeCopyLabels,
    getDailyChallengeModeSelectObjectiveLine,
    getDailyChallengeModifierLabel,
    getDailyChallengeObjectiveLabel,
    getDailyChallengePlaylist,
    getDailyChallengeRequiredLaps,
    getDailyChallengeSnapshot,
    getMissingDailyChallengeSnapshotIds,
    isDailyChallengeStoredResultForChallenge,
    isPreviewPage,
    prefetchDailyChallengeSnapshots,
    resolveDailyPlaylistCacheExpiresAt,
    submitDailyChallengeBestTime,
} from '../game/daily-challenge/service.js';
import { setDailyChallengeBestTime } from '../game/daily-challenge/storage.js';

const ACTIVE_DAILY_CACHE_KEY = 'VectorGpActiveDailyChallengeCache';
const DAILY_PLAYLIST_CACHE_KEY = 'VectorGpDailyChallengePlaylistCache';
const DAILY_SNAPSHOT_CACHE_KEY = 'VectorGpDailyChallengeSnapshotCache';

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

function buildChallenge(overrides = {}) {
    return {
        id: 'wave6-challenge',
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

describe('daily-challenge service wave6', () => {
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

    it('returns false for preview pages when pathname is empty (L56)', () => {
        window.location.pathname = '';
        expect(isPreviewPage()).toBe(false);
    });

    it('uses mockTrack query params on preview pages (L70-L71)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location.pathname = '/preview.html';
        window.location.search = '?mockTrack=desertBridge';
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.trackKey).toBe('desertBridge');
        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('falls back to mock daily challenges when localDev=true and fetch fails (L84-L85)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location.search = '?localDev=true';
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('mock-daily-challenge-local');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('treats mockDaily=true as a random-track request (L81-L82)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location.pathname = '/preview.html';
        window.location.search = '?mockDaily=true';
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.trackKey).toBe('circuit');
        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('rejects stored results with non-finite bestTime values (L437-L438)', () => {
        const challenge = buildChallenge();

        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: Number.NaN,
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: undefined,
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.5,
        })).toBe(true);
    });

    it('accepts stored results without trackKey or objectiveType fields (L440-L451)', () => {
        const challenge = buildChallenge({
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
        });

        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 9.99,
        })).toBe(true);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 9.99,
            trackKey: '',
        })).toBe(true);
    });

    it('picks the earliest schedule change more than one second away (L427-L428)', () => {
        const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
        const expiresAt = resolveDailyPlaylistCacheExpiresAt([
            buildChallenge({
                startsAt: '2026-07-18T12:00:02.000Z',
                endsAt: '2026-07-20T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
            }),
        ], nowMs);

        expect(expiresAt).toBe(Date.parse('2026-07-18T12:00:02.000Z'));
        expect(expiresAt).toBeGreaterThan(nowMs + 1000);
    });

    it('drops expired playlist entries during cache merge (L343-L344)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));

        const merged = cacheDailyChallengePlaylist([
            buildChallenge({ id: 'expired-wave6', availableUntil: '2026-07-20T00:00:00.000Z' }),
            buildChallenge({ id: 'fresh-wave6', availableUntil: '2026-07-30T00:00:00.000Z' }),
        ]);

        expect(merged.find((entry) => entry.id === 'expired-wave6')).toBeUndefined();
        expect(merged.find((entry) => entry.id === 'fresh-wave6')).toBeDefined();

        vi.useRealTimers();
    });

    it('sorts playlist entries by newest startsAt then id (L333-L336)', () => {
        // Pinned like the merge test above: these fixtures are only in the
        // cache while their `availableUntil` is in the future, so on the real
        // clock the test starts failing the day it passes.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));

        const merged = cacheDailyChallengePlaylist([
            buildChallenge({
                id: 'older-wave6-sort',
                startsAt: '2026-07-10T00:00:00.000Z',
                availableUntil: '2026-07-30T00:00:00.000Z',
            }),
            buildChallenge({
                id: 'newer-wave6-sort',
                startsAt: '2026-07-15T00:00:00.000Z',
                availableUntil: '2026-07-30T00:00:00.000Z',
            }),
        ]);

        const newerIndex = merged.findIndex((entry) => entry.id === 'newer-wave6-sort');
        const olderIndex = merged.findIndex((entry) => entry.id === 'older-wave6-sort');

        expect(newerIndex).toBeGreaterThanOrEqual(0);
        expect(olderIndex).toBeGreaterThanOrEqual(0);
        expect(newerIndex).toBeLessThan(olderIndex);

        vi.useRealTimers();
    });

    it('returns featured status while endsAt is still in the future (L701-L705)', () => {
        const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
        const challenge = buildChallenge({
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
        });

        expect(getDailyChallengeCardStatus(challenge, nowMs)).toEqual({
            key: 'featured',
            label: 'Featured',
        });
    });

    it('formats multi-day remaining durations with days and hours (L692-L694)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-07-21T06:00:00.000Z',
        })).toBe('2d 18h');

        vi.useRealTimers();
    });

    it('returns empty modifier labels for valid challenges (L749)', () => {
        expect(getDailyChallengeModifierLabel(buildChallenge())).toBe('');
        expect(getDailyChallengeModifierLabel(null)).toBe('');
    });

    it('returns mode-select objective lines from copy labels (L631-L633)', () => {
        const single = buildChallenge({ objectiveType: 'single_lap_fastest' });
        const multi = buildChallenge({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
        });

        expect(getDailyChallengeModeSelectObjectiveLine(single)).toBe('Best lap time');
        expect(getDailyChallengeModeSelectObjectiveLine(multi)).toBe('Best race time');
        expect(getDailyChallengeObjectiveLabel(multi)).toBe('3 laps');
        expect(getDailyChallengeCopyLabels(single).hudPrimaryLabel).toBe('LAP');
        expect(getDailyChallengeCopyLabels(multi).primaryStatLabel).toBe('Race Time');
    });

    it('rejects active-cache entries whose endsAt is not a string (L211)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        memoryLocalStorage.setItem(ACTIVE_DAILY_CACHE_KEY, JSON.stringify({
            challenge: {
                id: 'bad-ends-at',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
                endsAt: 12345,
                availableUntil: '2099-01-08T00:00:00.000Z',
                skin: 'default',
            },
        }));
        window.location.pathname = '/preview.html';
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('returns allowExpiredPost challenges without usability checks (L765-L766)', async () => {
        globalThis.devvit = {
            context: {
                postData: {
                    challenge: {
                        id: 'expired-post-bound',
                        trackKey: 'circuit',
                        startsAt: '2020-01-01T00:00:00.000Z',
                        endsAt: '2020-01-02T00:00:00.000Z',
                        availableUntil: '2020-01-03T00:00:00.000Z',
                        objectiveType: 'single_lap_fastest',
                        objectiveParams: {},
                        skin: 'default',
                    },
                },
            },
        };

        const challenge = await getActiveDailyChallenge({ allowExpiredPost: true });

        expect(challenge.id).toBe('expired-post-bound');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('persists cached playlist entries to localStorage (L366-L368)', () => {
        // An entry is only written while it is still available, so the clock
        // has to be pinned behind `availableUntil` rather than left to run
        // past it.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));

        cacheDailyChallengePlaylist([
            buildChallenge({
                id: 'persisted-wave6',
                availableUntil: '2026-07-30T00:00:00.000Z',
            }),
        ]);

        const raw = memoryLocalStorage.getItem(DAILY_PLAYLIST_CACHE_KEY);
        const parsed = JSON.parse(raw);

        expect(parsed.challenges.find((entry) => entry.id === 'persisted-wave6')).toBeDefined();

        vi.useRealTimers();
    });

    it('keeps the slower local best when the cached snapshot is slower (L583-L590)', () => {
        const challenge = buildChallenge({ id: 'keep-local-best' });
        setDailyChallengeBestTime(challenge, 10.0, 1);

        memoryLocalStorage.setItem(DAILY_SNAPSHOT_CACHE_KEY, JSON.stringify({
            entries: {
                [challenge.id]: {
                    snapshot: {
                        topRows: [],
                        nearbyRows: [],
                        currentPlayerRow: {
                            bestTime: 12.5,
                            completedLaps: 1,
                            checkpointTimesSec: [],
                        },
                        totalCount: 1,
                        leaderboardEntryCount: 1,
                        objectiveType: 'single_lap_fastest',
                    },
                    expiresAt: Date.now() + 60_000,
                },
            },
        }));

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 10.0,
            completedLaps: 1,
            checkpointTimesSec: null,
        });
    });

    it('deduplicates missing snapshot ids before prefetch (L602-L606)', async () => {
        expect(getMissingDailyChallengeSnapshotIds(['dup-a', 'dup-a', '', 42, 'dup-b']))
            .toEqual(['dup-a', 'dup-b']);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
        }));

        await prefetchDailyChallengeSnapshots(['dup-a', 'dup-a', '', 42, 'dup-b']);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(getMissingDailyChallengeSnapshotIds(['dup-a', 'dup-b'])).toEqual([]);
    });

    it('rejects submit payloads below the minimum daily time (L988-L990)', async () => {
        window.location.hostname = 'example.devvit.net';

        const result = await submitDailyChallengeBestTime({
            challengeId: 'wave6-submit',
            trackKey: 'circuit',
            bestTime: 1.99,
            replay: { inputs: [] },
        });

        expect(result).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects submit payloads above the maximum daily time (L989-L990)', async () => {
        window.location.hostname = 'example.devvit.net';

        const result = await submitDailyChallengeBestTime({
            challengeId: 'wave6-submit',
            trackKey: 'circuit',
            bestTime: 3600.01,
            replay: { inputs: [] },
        });

        expect(result).toBeNull();
    });

    it('returns null when fetch is unavailable for submit (L982)', async () => {
        delete globalThis.fetch;
        window.location.hostname = 'example.devvit.net';

        const result = await submitDailyChallengeBestTime({
            challengeId: 'wave6-submit',
            trackKey: 'circuit',
            bestTime: 12.5,
            replay: { inputs: [] },
        });

        expect(result).toBeNull();
    });

    it('returns -- for invalid best-time labels (L663-L664)', () => {
        expect(formatDailyChallengeBestLabel('single_lap_fastest', undefined)).toBe('--');
        expect(formatDailyChallengeResultLabel(buildChallenge(), { bestTime: Infinity })).toBe('--');
    });

    it('loads playlist from the network when the cache is under capacity (L841-L843)', async () => {
        fetch.mockResolvedValue(createJsonResponse([
            buildChallenge({ id: 'network-wave6', availableUntil: '2026-07-30T00:00:00.000Z' }),
        ]));

        const playlist = await getDailyChallengePlaylist({ forceRefresh: true });

        expect(playlist.find((entry) => entry.id === 'network-wave6')).toBeDefined();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('returns an empty snapshot object for missing challengeId (L918)', async () => {
        const snapshot = await getDailyChallengeSnapshot({ challengeId: null });

        expect(snapshot.topRows).toEqual([]);
        expect(snapshot.nearbyRows).toEqual([]);
        expect(snapshot.currentPlayerRow).toBeNull();
    });
});
