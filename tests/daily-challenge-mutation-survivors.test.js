import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearStoredTrackChecksForTests, registerStoredTracksFromPayload } from '../game/track/stored-track-service.js';
import {
    cacheDailyChallengePlaylist,
    confirmDailyChallengeShare,
    getActiveDailyChallenge,
    getCachedDailyChallengePlaylist,
    getDailyChallengeBestResult,
    getDailyChallengeCardStatus,
    getDailyChallengePlaylist,
    getDailyChallengeSnapshot,
    getDailyChallengeTrackName,
    getDailyChallengeSnapshotIdsToFetch,
    isDailyChallengeStoredResultForChallenge,
    isPreviewPage,
    previewDailyChallengeShare,
    requestFeaturedDailyChallengeStart,
    submitDailyChallengeBestTime,
} from '../game/daily-challenge/service.js';
import {
    formatDailyChallengeResultLabel,
    getDailyChallengeCopyLabels,
    getDailyChallengeObjectiveLabel,
    getDailyChallengeRequiredLaps,
    formatDailyChallengeBestLabel,
} from '../game/daily-challenge/labels.js';
import { setDailyChallengeBestTime } from '../game/daily-challenge/storage.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const MINIMAL_REPLAY = { inputs: [] };
const DAY_MS = 24 * 60 * 60 * 1000;

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

function futureIso(hoursFromNow = 24) {
    return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

function buildChallenge(overrides = {}) {
    return {
        id: 'mutation-survivor-challenge',
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

describe('daily-challenge mutation survivors', () => {
    // These metadata/cache tests model a session whose race layout was already confirmed.
    beforeEach(() => {
        clearStoredTrackChecksForTests();
        registerStoredTracksFromPayload([], { confirmedTrackKeys: ['circuit'] });
    });

    let memoryLocalStorage;

    beforeEach(() => {
        memoryLocalStorage = createMemoryLocalStorage();
        globalThis.window = { localStorage: memoryLocalStorage };
        globalThis.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        memoryLocalStorage?._clear();
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.devvit;
    });

    it('does not treat an empty search string as mock params on a non-preview page', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('uses a concrete mockDaily track key without requiring mockDaily=true', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=jadeSpiralCircuit',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.trackKey).toBe('jadeSpiralCircuit');
        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('builds mock challenge timing from one-day and seven-day windows', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=true',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();
        const startsMs = Date.parse(challenge.startsAt);
        const endsMs = Date.parse(challenge.endsAt);
        const availableUntilMs = Date.parse(challenge.availableUntil);

        expect(challenge.objectiveType).toBe('single_lap_fastest');
        expect(challenge.status).toBe('active');
        expect(challenge.skin).toBe('default');
        expect(endsMs - startsMs).toBe(DAY_MS);
        expect(availableUntilMs - startsMs).toBe(7 * DAY_MS);

        vi.useRealTimers();
    });

    it('returns an empty mock snapshot shape when local snapshot fetch fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/game.html',
            protocol: 'http:',
            search: '',
            origin: 'http://localhost',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const snapshot = await getDailyChallengeSnapshot({
            challengeId: 'mock-snapshot-shape',
            forceRefresh: true,
        });

        expect(snapshot.topRows).toEqual([]);
        expect(snapshot.nearbyRows).toEqual([]);
        expect(snapshot.currentPlayerRow).toBeNull();
        expect(snapshot.totalCount).toBe(0);
        expect(snapshot.leaderboardEntryCount).toBe(0);
        expect(snapshot.objectiveType).toBe('single_lap_fastest');
        expect(snapshot.playerRankLabel).toBe('--');
    });

    it('detects preview pages only when the pathname ends with preview.html', () => {
        window.location = { pathname: '/preview.html.backup' };
        expect(isPreviewPage()).toBe(false);

        window.location = { pathname: '/nested/preview.html' };
        expect(isPreviewPage()).toBe(true);
    });

    it('trims active-cache writes to the expected storage key and payload shape', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'cache-trim-challenge',
            trackKey: 'circuit',
            objectiveType: 99,
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            status: 'active',
            skin: '   ',
        }));

        await getActiveDailyChallenge();

        const raw = memoryLocalStorage.getItem('VectorGpActiveDailyChallengeCache');
        expect(raw).toBeTruthy();
        expect(JSON.parse(raw)).toEqual({
            challenge: {
                id: 'cache-trim-challenge',
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

    it('clears the active cache when a fetched challenge cannot be trimmed for storage', async () => {
        const catalog = await import('../game/track/catalog.js');
        const originalHasTrack = catalog.hasTrack;
        const hasTrackSpy = vi.spyOn(catalog, 'hasTrack');
        let counting = false;
        let circuitChecks = 0;
        hasTrackSpy.mockImplementation((key) => {
            if (!counting || key !== 'circuit') {
                return originalHasTrack(key);
            }
            circuitChecks += 1;
            return circuitChecks === 1;
        });

        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockImplementation(async () => {
            counting = true;
            return createJsonResponse({
                id: 'uncacheable-trim',
                trackKey: 'circuit',
                endsAt: futureIso(12),
                availableUntil: futureIso(24 * 7),
                objectiveType: 'single_lap_fastest',
                skin: 'default',
            });
        });

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('uncacheable-trim');
        expect(memoryLocalStorage.getItem('VectorGpActiveDailyChallengeCache')).toBeNull();
    });

    it('ignores devvit postData that is not an object', async () => {
        globalThis.devvit = { context: { postData: 'not-an-object' } };
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValue(createJsonResponse(buildChallenge({ id: 'server-after-bad-postdata' })));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('server-after-bad-postdata');
    });

    it('stores a featured start override for five minutes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };

        requestFeaturedDailyChallengeStart();

        const parsed = JSON.parse(memoryLocalStorage.getItem('VectorGpDailyStartOverride'));
        expect(parsed.mode).toBe('featured');
        expect(parsed.expiresAt).toBe(Date.now() + 5 * 60 * 1000);
        vi.useRealTimers();
    });

    it('does not clear a non-featured start override before resolving the active challenge', async () => {
        memoryLocalStorage.setItem('VectorGpDailyStartOverride', JSON.stringify({
            mode: 'other',
            expiresAt: Date.now() + 60_000,
        }));
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValue(createJsonResponse(buildChallenge({ id: 'non-featured-override' })));

        await getActiveDailyChallenge();

        expect(JSON.parse(memoryLocalStorage.getItem('VectorGpDailyStartOverride')).mode).toBe('other');
    });

    it('normalizes multi-lap challenges and clones objectiveParams on cache writes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const merged = cacheDailyChallengePlaylist([{
            id: 'multi-lap-normalize',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 4 },
            skin: 'default',
        }]);

        const cached = merged.find((challenge) => challenge.id === 'multi-lap-normalize');
        cached.objectiveParams.lapCount = 99;

        const stored = JSON.parse(memoryLocalStorage.getItem('VectorGpDailyChallengePlaylistCache'));
        expect(stored.challenges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'multi-lap-normalize',
                objectiveType: 'multi_lap_total',
                objectiveParams: { lapCount: 4 },
            }),
        ]));
        expect(getCachedDailyChallengePlaylist().find((challenge) => challenge.id === 'multi-lap-normalize'))
            .toMatchObject({ objectiveParams: { lapCount: 4 } });

        vi.useRealTimers();
    });


    it('sorts playlist rows by id when only one side has a parseable startsAt', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const merged = cacheDailyChallengePlaylist([
            buildChallenge({ id: 'z-parseable-start', startsAt: '2026-07-18T00:00:00.000Z' }),
            buildChallenge({ id: 'a-missing-start', startsAt: 'not-a-date' }),
        ]);

        const ordered = merged
            .filter((challenge) => ['z-parseable-start', 'a-missing-start'].includes(challenge.id))
            .map((challenge) => challenge.id);
        expect(ordered).toEqual(['z-parseable-start', 'a-missing-start']);

        vi.useRealTimers();
    });

    it('rejects stored results unless bestTime is finite and metadata matches', () => {
        const challenge = buildChallenge({ id: VALID_UUID });

        expect(isDailyChallengeStoredResultForChallenge(challenge, { bestTime: 'not-a-number' })).toBe(false);
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

    it('keeps the local best when it ties the cached snapshot row', async () => {
        const challenge = buildChallenge({ id: 'tie-keeps-local' });
        setDailyChallengeBestTime(challenge, 10, 1, [4, 8]);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: { bestTimeMs: 10000, completedLaps: 2 },
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 10,
            completedLaps: 1,
        });
    });

    it('returns only the local best when the snapshot row has no finite bestTime', async () => {
        const challenge = buildChallenge({ id: 'snapshot-row-invalid' });
        cacheDailyChallengePlaylist([challenge]);
        setDailyChallengeBestTime(challenge, 11.2, 1);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: { bestTimeMs: Number.NaN },
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({ bestTime: 11.2 });
    });

    it('defaults copy labels to single-lap wording when objectiveType is missing', () => {
        expect(getDailyChallengeCopyLabels({})).toEqual({
            hudPrimaryLabel: 'LAP',
            primaryStatLabel: 'Lap Time',
        });
    });

    it('formats missing result labels and rejects non-object results', () => {
        expect(formatDailyChallengeResultLabel(null)).toBe('--');
        expect(formatDailyChallengeResultLabel({ bestTime: Number.NaN })).toBe('--');
    });

    it('uses the featured card state only while endsAt is still in the future', () => {
        const challenge = buildChallenge({
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
        });

        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-18T23:59:59.999Z'))).toEqual({
            key: 'featured',
            label: 'Featured',
        });
        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-19T00:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires on Jul 25',
        });
    });

    it('caches post-bound challenges into the playlist before returning them', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const postChallenge = buildChallenge({ id: 'post-bound-playlist-cache' });
        globalThis.devvit = { context: { postData: { challenge: postChallenge } } };
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };

        const challenge = await getActiveDailyChallenge({ allowExpiredPost: true });

        expect(challenge.id).toBe('post-bound-playlist-cache');
        const stored = JSON.parse(memoryLocalStorage.getItem('VectorGpDailyChallengePlaylistCache'));
        expect(stored.challenges.map((row) => row.id)).toContain('post-bound-playlist-cache');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('fetches the active challenge with GET against the daily active route', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValue(createJsonResponse(buildChallenge({ id: 'active-get-route' })));

        await getActiveDailyChallenge();

        expect(fetch).toHaveBeenCalledWith(
            '/api/daily/active',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('falls back to a mock playlist when the server returns only invalid challenges', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=true',
        };
        fetch.mockResolvedValue(createJsonResponse({
            challenges: [{ id: 'bad', trackKey: 'missing' }],
        }));

        const playlist = await getDailyChallengePlaylist({ forceRefresh: true });

        expect(playlist).toHaveLength(1);
        expect(playlist[0].id).toBe('mock-daily-challenge-local');
        expect(fetch).toHaveBeenCalledWith(
            '/api/daily/playlist',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('always refetches the playlist when forceRefresh is true even with a full cache', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        cacheDailyChallengePlaylist(Array.from({ length: 7 }, (_, index) => buildChallenge({
            id: `cached-seven-${index}`,
            startsAt: `2026-07-${String(18 - index).padStart(2, '0')}T00:00:00.000Z`,
            endsAt: `2026-07-${String(19 - index).padStart(2, '0')}T00:00:00.000Z`,
        })));
        fetch.mockResolvedValue(createJsonResponse({
            challenges: [buildChallenge({ id: 'forced-refresh-playlist' })],
        }));

        const playlist = await getDailyChallengePlaylist({ forceRefresh: true });

        expect(playlist.map((challenge) => challenge.id)).toContain('forced-refresh-playlist');
        expect(fetch).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('builds snapshot request URLs with challengeId, playerId, limit, and offset', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
            origin: 'https://example.devvit.net',
        };
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
        }));

        await getDailyChallengeSnapshot({
            challengeId: 'url-shape-challenge',
            limit: 25,
            offset: 50,
            forceRefresh: true,
        });

        const url = fetch.mock.calls[0][0];
        expect(url).toContain('/api/daily/snapshot');
        expect(url).toContain('challengeId=url-shape-challenge');
        expect(url).toContain('playerId=');
        expect(url).toContain('limit=25');
        expect(url).toContain('offset=50');
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    });

    it('does not cache later snapshot pages', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
            origin: 'https://example.devvit.net',
        };
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [{ rank: 2, bestTimeMs: 15000 }],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 2,
            objectiveType: 'single_lap_fastest',
            pageOffset: 1,
            pageLimit: 1,
        }));

        await getDailyChallengeSnapshot({
            challengeId: 'later-page-challenge',
            limit: 1,
            offset: 1,
            forceRefresh: true,
        });

        expect(memoryLocalStorage.getItem('VectorGpDailyChallengeSnapshotCache')).toBeNull();
    });

    it('finds no snapshot to fetch when every id is already cached', async () => {
        const challengeId = 'prefetch-noop-challenge';
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId, forceRefresh: true });

        expect(getDailyChallengeSnapshotIdsToFetch([challengeId, challengeId, ''])).toEqual([]);
    });

    it('accepts submit payloads exactly at the minimum and maximum allowed times', async () => {
        window.location = { hostname: 'example.devvit.net' };
        fetch.mockResolvedValue(createJsonResponse({ accepted: true }));

        await submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 2,
            replay: MINIMAL_REPLAY,
        });
        await submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 3600,
            replay: MINIMAL_REPLAY,
        });

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][0]).toBe('/api/daily/submit');
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 2,
            replay: MINIMAL_REPLAY,
            checkpointTimesSec: null,
        });
        expect(fetch.mock.calls[0][1]).toMatchObject({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
    });

    it('removes an expired featured start override from storage while loading the active challenge', async () => {
        memoryLocalStorage.setItem('VectorGpDailyStartOverride', JSON.stringify({
            mode: 'featured',
            expiresAt: Date.now() - 1,
        }));
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValue(createJsonResponse(buildChallenge({ id: 'after-expired-override' })));

        await getActiveDailyChallenge();

        expect(memoryLocalStorage.getItem('VectorGpDailyStartOverride')).toBeNull();
    });

    it('returns null from submit when fetch is unavailable', async () => {
        delete globalThis.fetch;
        window.location = { hostname: 'example.devvit.net' };

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 12,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();
    });

    it('uses mockDaily=true with the default track when no concrete track key is supplied', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=true',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.trackKey).toBe('circuit');
        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('enables mock data when localDev=true is present in the search params', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '?localDev=true',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('mock-daily-challenge-local');
    });

    it('falls back safely when a malformed multi-lap challenge requests one lap', () => {
        const multiLap = buildChallenge({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 1 },
        });

        expect(getDailyChallengeObjectiveLabel(multiLap)).toBe('1 lap');
        expect(getDailyChallengeRequiredLaps(multiLap)).toBe(1);
        expect(getDailyChallengeCopyLabels(multiLap).hudPrimaryLabel).toBe('RACE');
        expect(getDailyChallengeTrackName(multiLap)).not.toBe('Unknown Track');
    });

    it('formats valid result labels and best-time labels while rejecting invalid numbers', () => {
        expect(formatDailyChallengeResultLabel({ bestTime: 12.4 })).toBe('12.400s');
        expect(formatDailyChallengeBestLabel(9.876)).toBe('9.876s');
        expect(formatDailyChallengeBestLabel(Number.NaN)).toBe('--');
    });

    it('shows an expires-in label when less than one day remains on the challenge', () => {
        const challenge = buildChallenge({
            endsAt: '2026-07-18T00:00:00.000Z',
            availableUntil: '2026-07-18T18:00:00.000Z',
        });

        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-18T12:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires in 6h',
        });
        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-07-18T18:00:00.000Z'))).toEqual({
            key: 'expired',
            label: 'Expired',
        });
    });

    it('treats isPreviewPage as false when window is unavailable', () => {
        delete globalThis.window;
        expect(isPreviewPage()).toBe(false);
    });

    it('posts share preview and confirm requests to the daily share routes', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        fetch
            .mockResolvedValueOnce(createJsonResponse({ status: 'ready' }))
            .mockResolvedValueOnce(createJsonResponse({ status: 'confirmed' }));

        await previewDailyChallengeShare({ challengeId: VALID_UUID });
        await confirmDailyChallengeShare('share-token-123');

        expect(fetch.mock.calls[0][0]).toBe('/api/daily/share/preview');
        expect(fetch.mock.calls[1][0]).toBe('/api/daily/share/confirm');
        expect(fetch.mock.calls[0][1]).toMatchObject({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ shareToken: 'share-token-123' });
    });

    it('writes trimmed skin and default objectiveType into the active challenge cache', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValueOnce(createJsonResponse(buildChallenge({
            objectiveType: 12,
            skin: '  neon  ',
            endsAt: futureIso(12),
            availableUntil: futureIso(48),
        })));

        await getActiveDailyChallenge();

        const cached = JSON.parse(memoryLocalStorage.getItem('VectorGpActiveDailyChallengeCache'));
        expect(cached.challenge.skin).toBe('neon');
        expect(cached.challenge.objectiveType).toBe('single_lap_fastest');
    });

    it('defaults empty skin to default and non-object objectiveParams to an empty object', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValueOnce(createJsonResponse(buildChallenge({
            skin: '   ',
            objectiveType: 'multi_lap_total',
            objectiveParams: null,
            endsAt: futureIso(12),
            availableUntil: futureIso(48),
        })));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.skin).toBe('default');
        expect(challenge.objectiveParams).toEqual({ lapCount: 1 });
        expect(challenge.objectiveType).toBe('single_lap_fastest');
    });

    it('prefers a complete challenge embedded in Devvit postData', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        globalThis.devvit = {
            context: {
                postData: {
                    challenge: buildChallenge({
                        id: 'post-bound-challenge',
                        endsAt: futureIso(6),
                        availableUntil: futureIso(24),
                    }),
                },
            },
        };
        fetch.mockRejectedValue(new Error('should-not-fetch'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('post-bound-challenge');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('ignores non-object Devvit postData and continues to fetch', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        globalThis.devvit = { context: { postData: 'nope' } };
        fetch.mockResolvedValueOnce(createJsonResponse(buildChallenge({
            id: 'fetched-after-bad-postdata',
            endsAt: futureIso(6),
            availableUntil: futureIso(24),
        })));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('fetched-after-bad-postdata');
        expect(fetch).toHaveBeenCalled();
    });

    it('returns an empty snapshot without fetching when challengeId is missing', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
            origin: 'https://example.devvit.net',
        };

        const snapshot = await getDailyChallengeSnapshot({});

        expect(snapshot.topRows).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('requests snapshots with challengeId, limit, and offset query params', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
            origin: 'https://example.devvit.net',
        };
        fetch.mockResolvedValueOnce(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            leaderboardEntryCount: 0,
        }));

        await getDailyChallengeSnapshot({
            challengeId: 'daily-gp-2026-07-11',
            limit: 25,
            offset: 10,
            forceRefresh: true,
        });

        const requested = new URL(fetch.mock.calls[0][0], 'https://example.devvit.net');
        expect(requested.searchParams.get('challengeId')).toBe('daily-gp-2026-07-11');
        expect(requested.searchParams.get('limit')).toBe('25');
        expect(requested.searchParams.get('offset')).toBe('10');
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    });

    it('treats a cached active challenge as expired at the exact endsAt timestamp', async () => {
        vi.useFakeTimers();
        const endsAt = '2026-07-18T12:00:00.000Z';
        vi.setSystemTime(new Date(endsAt));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        memoryLocalStorage = createMemoryLocalStorage({
            VectorGpActiveDailyChallengeCache: JSON.stringify({
                challenge: {
                    id: 'exact-end-cache',
                    trackKey: 'circuit',
                    objectiveType: 'single_lap_fastest',
                    endsAt,
                    availableUntil: '2026-07-25T00:00:00.000Z',
                    skin: 'default',
                },
            }),
        });
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('does not treat mockDaily=false as enabling mock mode', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '?mockDaily=false',
        };
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });
});
