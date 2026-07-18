import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    confirmDailyChallengeShare,
    formatDailyChallengePlaylistAvailabilityLabel,
    getActiveDailyChallenge,
    getDailyChallengeBestResult,
    getDailyChallengeCardStatus,
    getDailyChallengeModeSelectObjectiveLine,
    getDailyChallengePlaylist,
    getDailyChallengeSnapshot,
    getMissingDailyChallengeSnapshotIds,
    isDailyChallengeStoredResultForChallenge,
    prefetchDailyChallengeSnapshots,
    previewDailyChallengeShare,
    submitDailyChallengeBestTime,
} from '../game/daily-challenge/service.js';
import { setDailyChallengeBestTime } from '../game/daily-challenge/storage.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const MINIMAL_REPLAY = { inputs: [] };

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
        id: 'wave2-challenge',
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

describe('daily-challenge service wave 2', () => {
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

    it('uses mockTrack on preview pages when mockDaily is absent', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location.pathname = '/preview.html';
        window.location.search = '?mockTrack=jadeSpiralCircuit';
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.trackKey).toBe('jadeSpiralCircuit');
        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('returns an expired post-bound challenge only when allowExpiredPost is true', async () => {
        const expired = buildChallenge({
            id: 'expired-post-bound',
            endsAt: '2020-01-01T00:00:00.000Z',
            availableUntil: '2020-01-08T00:00:00.000Z',
        });
        globalThis.devvit = { context: { postData: { challenge: expired } } };
        fetch.mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');

        const allowed = await getActiveDailyChallenge({ allowExpiredPost: true });

        expect(allowed.id).toBe('expired-post-bound');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('formats card status for sub-hour, sub-day, and multi-day windows', () => {
        const challenge = buildChallenge({
            endsAt: '2026-07-18T00:00:00.000Z',
            availableUntil: '2026-07-18T00:45:00.000Z',
        });

        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-18T00:30:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires in 15m',
        });

        const hoursChallenge = buildChallenge({
            endsAt: '2026-07-18T00:00:00.000Z',
            availableUntil: '2026-07-18T05:30:00.000Z',
        });
        expect(getDailyChallengeCardStatus(hoursChallenge, Date.parse('2026-07-18T02:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires in 3h 30m',
        });

        const daysChallenge = buildChallenge({
            endsAt: '2026-07-18T00:00:00.000Z',
            availableUntil: '2026-07-21T12:00:00.000Z',
        });
        expect(getDailyChallengeCardStatus(daysChallenge, Date.parse('2026-07-18T12:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires on Jul 21',
        });
    });

    it('formats playlist availability labels from remaining time', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-07-18T12:30:00.000Z',
        })).toBe('30m');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-07-17T12:00:00.000Z',
        })).toBe('Expired');

        vi.useRealTimers();
    });

    it('exposes the mode-select objective line from copy labels', () => {
        expect(getDailyChallengeModeSelectObjectiveLine({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
        })).toBe('Best race time');
        expect(getDailyChallengeModeSelectObjectiveLine({
            objectiveType: 'single_lap_fastest',
        })).toBe('Best lap time');
    });

    it('deduplicates concurrent playlist fetches through the in-flight promise', async () => {
        let resolveFetch;
        fetch.mockReturnValue(new Promise((resolve) => {
            resolveFetch = resolve;
        }));

        const first = getDailyChallengePlaylist();
        const second = getDailyChallengePlaylist();

        resolveFetch(createJsonResponse({
            challenges: [buildChallenge({ id: 'deduped-playlist' })],
        }));

        const [playlistA, playlistB] = await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(playlistA[0].id).toBe('deduped-playlist');
        expect(playlistB[0].id).toBe('deduped-playlist');
    });

    it('deduplicates concurrent first-page snapshot fetches', async () => {
        cacheDailyChallengePlaylist([buildChallenge({ id: 'snapshot-dedupe' })]);
        let resolveFetch;
        fetch.mockReturnValue(new Promise((resolve) => {
            resolveFetch = resolve;
        }));

        const first = getDailyChallengeSnapshot({ challengeId: 'snapshot-dedupe' });
        const second = getDailyChallengeSnapshot({ challengeId: 'snapshot-dedupe' });

        resolveFetch(createJsonResponse({
            topRows: [{ rank: 1, bestTimeMs: 12000 }],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));

        const [snapshotA, snapshotB] = await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(snapshotA.topRows).toHaveLength(1);
        expect(snapshotB.topRows).toHaveLength(1);
    });

    it('prefers a faster snapshot row while keeping completed laps from the snapshot', async () => {
        const challenge = buildChallenge({ id: 'merge-completed-laps' });
        cacheDailyChallengePlaylist([challenge]);
        setDailyChallengeBestTime(challenge, 15, 1);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: {
                bestTimeMs: 12000,
                completedLaps: 2,
                checkpointTimesSec: [4, 8],
            },
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 12,
            completedLaps: 2,
            checkpointTimesSec: [4, 8],
        });
    });

    it('rejects submit payloads without track keys or outside allowed time bounds', async () => {
        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            bestTime: 12,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();
        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 1.5,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();
        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 4000,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('blocks local submit and share requests on localhost', async () => {
        window.location.hostname = 'localhost';

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 12,
            replay: MINIMAL_REPLAY,
        })).resolves.toMatchObject({
            ok: false,
            status: 403,
        });

        await expect(previewDailyChallengeShare({ challengeId: VALID_UUID })).resolves.toMatchObject({
            ok: false,
            status: 403,
            body: { status: 'unavailable_locally' },
        });
        await expect(confirmDailyChallengeShare('token')).resolves.toMatchObject({
            ok: false,
            status: 403,
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('throws fetch failures for snapshots on hosted pages without mock fallbacks', async () => {
        fetch.mockRejectedValue(new Error('snapshot offline'));

        await expect(getDailyChallengeSnapshot({
            challengeId: 'hosted-snapshot-fail',
            forceRefresh: true,
        })).rejects.toThrow('snapshot offline');
    });

    it('throws when the active challenge endpoint returns a non-ok status on hosted pages', async () => {
        fetch.mockResolvedValue({
            ok: false,
            status: 503,
            json: async () => ({ error: 'down' }),
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(getActiveDailyChallenge()).rejects.toThrow('Server returned status 503');
    });

    it('keeps the local best when it is faster than the cached snapshot row', async () => {
        const challenge = buildChallenge({ id: 'local-faster-wave2' });
        cacheDailyChallengePlaylist([challenge]);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: { bestTimeMs: 11000, completedLaps: 2 },
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });
        setDailyChallengeBestTime(challenge, 9.5, 1, [3, 6]);

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 9.5,
            completedLaps: 1,
            checkpointTimesSec: [3, 6],
        });
    });

    it('marks the card expired only after availableUntil has passed', () => {
        const challenge = buildChallenge({
            endsAt: '2026-07-18T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
        });

        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-19T12:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires on Jul 25',
        });
        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-25T00:00:00.000Z'))).toEqual({
            key: 'expired',
            label: 'Expired',
        });
    });

    it('formats playlist availability as Expired only after the window closes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const challenge = buildChallenge({ availableUntil: '2026-07-18T12:00:01.000Z' });
        expect(formatDailyChallengePlaylistAvailabilityLabel(challenge)).toBe('1m');

        vi.setSystemTime(new Date('2026-07-18T12:00:01.000Z'));
        expect(formatDailyChallengePlaylistAvailabilityLabel(challenge)).toBe('Expired');

        vi.useRealTimers();
    });

    it('rejects stored results when metadata disagrees but accepts matching rows', () => {
        const challenge = buildChallenge({ id: 'metadata-match-wave2' });

        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.4,
            trackKey: 'alloyRing',
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.4,
            objectiveType: 'multi_lap_total',
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.4,
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
        })).toBe(true);
    });

    it('prefetches only challenge ids that are missing from the snapshot cache', async () => {
        const cached = buildChallenge({ id: 'prefetch-cached' });
        const missing = buildChallenge({ id: 'prefetch-missing' });
        cacheDailyChallengePlaylist([cached, missing]);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: cached.id, forceRefresh: true });
        fetch.mockClear();

        expect(getMissingDailyChallengeSnapshotIds([cached.id, missing.id, cached.id]))
            .toEqual(['prefetch-missing']);

        await prefetchDailyChallengeSnapshots([cached.id, missing.id]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toContain('prefetch-missing');
    });

    it('uses hour-only labels when remaining minutes divide evenly', () => {
        const challenge = buildChallenge({
            endsAt: '2026-07-18T00:00:00.000Z',
            availableUntil: '2026-07-18T04:00:00.000Z',
        });

        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-18T02:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires in 2h',
        });
        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-18T01:30:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires in 2h 30m',
        });
    });
});
