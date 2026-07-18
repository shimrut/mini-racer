import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    formatDailyChallengeBestLabel,
    formatDailyChallengePlaylistAvailabilityLabel,
    formatDailyChallengeResultLabel,
    getActiveDailyChallenge,
    getDailyChallengeBestResult,
    getDailyChallengeCardStatus,
    getDailyChallengeCopyLabels,
    getDailyChallengeModeSelectObjectiveLine,
    getDailyChallengeModifierBadges,
    getDailyChallengeModifierLabel,
    getDailyChallengeObjectiveLabel,
    getDailyChallengePlaylist,
    getDailyChallengeRequiredLaps,
    getDailyChallengeSnapshot,
    getCachedDailyChallengeSnapshot,
    getDailyChallengeTrackName,
    getMissingDailyChallengeSnapshotIds,
    cacheDailyChallengePlaylist,
    getCachedDailyChallengePlaylist,
    isDailyChallengeStoredResultForChallenge,
    isPreviewPage,
    prefetchDailyChallengeSnapshots,
    previewDailyChallengeShare,
    confirmDailyChallengeShare,
    requestFeaturedDailyChallengeStart,
    submitDailyChallengeBestTime
} from '../game/daily-challenge/service.js';
import { setDailyChallengeBestTime } from '../game/daily-challenge/storage.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const MINIMAL_REPLAY = { inputs: [] };

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => body
    };
}

function createMemoryLocalStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => {
            data.set(k, v);
        },
        removeItem: (k) => {
            data.delete(k);
        },
        _clear: () => data.clear()
    };
}

describe('daily-challenge service', () => {
    let memoryLocalStorage;

    beforeEach(() => {
        memoryLocalStorage = createMemoryLocalStorage();
        globalThis.window = {
            localStorage: memoryLocalStorage
        };
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

    it('getDailyChallengeTrackName falls back for missing track', () => {
        expect(getDailyChallengeTrackName(null)).toBe('Unknown Track');
        expect(getDailyChallengeTrackName({ trackKey: 'nope' })).toBe('Unknown Track');
        expect(getDailyChallengeTrackName({ trackKey: 'circuit' })).toBeTruthy();
    });

    it('getDailyChallengeObjectiveLabel covers objective types', () => {
        expect(getDailyChallengeObjectiveLabel(null)).toBe('Daily Challenge');
        expect(
            getDailyChallengeObjectiveLabel({
                objectiveType: 'multi_lap_total',
                objectiveParams: { lapCount: 1 }
            })
        ).toBe('2 laps');
        expect(
            getDailyChallengeObjectiveLabel({ objectiveType: 'unknown' })
        ).toBe('1 lap');
        expect(
            getDailyChallengeObjectiveLabel({ objectiveType: 'single_lap_fastest' })
        ).toBe('1 lap');
    });

    it('getDailyChallengeModeSelectObjectiveLine matches mode-select blurbs', () => {
        expect(getDailyChallengeModeSelectObjectiveLine(null)).toBe('Best lap time');
        expect(getDailyChallengeModeSelectObjectiveLine({ objectiveType: 'single_lap_fastest' })).toBe(
            'Best lap time'
        );
        expect(getDailyChallengeModeSelectObjectiveLine({ objectiveType: 'multi_lap_total' })).toBe(
            'Best race time'
        );
        expect(getDailyChallengeModeSelectObjectiveLine({ objectiveType: 'unknown' })).toBe(
            'Best lap time'
        );
    });

    it('getDailyChallengeCopyLabels centralizes daily challenge metric copy', () => {
        expect(getDailyChallengeCopyLabels({ objectiveType: 'single_lap_fastest' })).toEqual({
            hudPrimaryLabel: 'LAP',
            primaryStatLabel: 'Lap Time',
            bestSummaryLabel: 'Best Lap',
            modeSelectLine: 'Best lap time'
        });
    });

    it('formatDailyChallengeResultLabel covers missing and time-trial results', () => {
        expect(formatDailyChallengeResultLabel(null, null)).toBe('--');
        expect(
            formatDailyChallengeResultLabel(
                { objectiveType: 'single_lap_fastest' },
                { bestTime: 19.5 }
            )
        ).toBe('19.50s');
    });

    it('formatDailyChallengeBestLabel formats daily challenge best values for ui surfaces', () => {
        expect(formatDailyChallengeBestLabel('single_lap_fastest', 19.5)).toBe('19.50s');
    });

    it('formatDailyChallengePlaylistAvailabilityLabel only flags urgent or expired tracks', () => {
        expect(formatDailyChallengePlaylistAvailabilityLabel(null)).toBe('');
        expect(formatDailyChallengePlaylistAvailabilityLabel({})).toBe('');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2020-01-01T00:00:00.000Z',
        })).toBe('Expired');

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-05-24T12:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2025-05-24T14:00:00.000Z',
        })).toBe('2h');

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2025-05-27T12:00:00.000Z',
        })).toBe('3d');

        vi.useRealTimers();
    });

    it('getDailyChallengeCardStatus derives featured, available, and expired states from challenge timing', () => {
        vi.useFakeTimers();

        vi.setSystemTime(new Date('2026-06-02T10:00:00.000Z'));
        expect(getDailyChallengeCardStatus({
            startsAt: '2026-06-02T00:00:00.000Z',
            endsAt: '2026-06-03T00:00:00.000Z',
            availableUntil: '2026-06-09T00:00:00.000Z',
        })).toEqual({
            key: 'featured',
            label: 'Featured',
        });

        vi.setSystemTime(new Date('2026-06-03T10:00:00.000Z'));
        expect(getDailyChallengeCardStatus({
            startsAt: '2026-06-02T00:00:00.000Z',
            endsAt: '2026-06-03T00:00:00.000Z',
            availableUntil: '2026-06-09T00:00:00.000Z',
        })).toEqual({
            key: 'available',
            label: 'Expires on Jun 09',
        });

        vi.setSystemTime(new Date('2026-06-08T14:00:00.000Z'));
        expect(getDailyChallengeCardStatus({
            startsAt: '2026-06-02T00:00:00.000Z',
            endsAt: '2026-06-03T00:00:00.000Z',
            availableUntil: '2026-06-09T00:00:00.000Z',
        })).toEqual({
            key: 'available',
            label: 'Expires in 10h',
        });

        vi.setSystemTime(new Date('2026-06-10T00:00:00.000Z'));
        expect(getDailyChallengeCardStatus({
            startsAt: '2026-06-02T00:00:00.000Z',
            endsAt: '2026-06-03T00:00:00.000Z',
            availableUntil: '2026-06-09T00:00:00.000Z',
        })).toEqual({
            key: 'expired',
            label: 'Expired',
        });

        vi.useRealTimers();
    });

    it('does not expose car tuning as daily challenge modifiers', () => {
        expect(getDailyChallengeModifierBadges(null)).toEqual([]);
        expect(getDailyChallengeModifierBadges({
            physicsOverrides: {
                accel: 58,
                brakePower: 90,
                maxSpeed: 320,
                turnRate: 5.75,
                grip: 2.5
            }
        })).toEqual([]);
        expect(getDailyChallengeModifierLabel({ physicsOverrides: { accel: 58 } })).toBe('');
    });

    it('submitDailyChallengeBestTime returns null without calling fetch when invalid', async () => {
        await expect(submitDailyChallengeBestTime({})).resolves.toBe(null);
        await expect(
            submitDailyChallengeBestTime({
                challengeId: VALID_UUID,
                bestTime: 1.5,
                replay: MINIMAL_REPLAY
            })
        ).resolves.toBe(null);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('submitDailyChallengeBestTime accepts configured time boundaries and handles non-json responses', async () => {
        fetch
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => {
                    throw new Error('not json');
                }
            })
            .mockResolvedValueOnce(createJsonResponse({ accepted: true }));

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 2,
            replay: MINIMAL_REPLAY
        })).resolves.toEqual({
            ok: true,
            status: 200,
            body: null
        });
        expect(fetch.mock.calls[0][0]).toBe('/api/daily/submit');
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            replay: MINIMAL_REPLAY
        });
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toHaveProperty('bestTime', 2);

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 3600,
            replay: MINIMAL_REPLAY
        })).resolves.toMatchObject({
            ok: true,
            body: { accepted: true }
        });
    });

    it('getActiveDailyChallenge normalizes response', async () => {
        const endsAt = new Date(Date.now() + 3600_000).toISOString();
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: VALID_UUID,
                trackKey: 'circuit',
                challengeDate: '2026-04-14',
                startsAt: '2026-04-14T00:00:00.000Z',
                endsAt,
                status: 'active',
                objectiveType: 'multi_lap_total',
                objectiveParams: { lapCount: 2 },
                physicsOverrides: { accel: 31 },
                skin: 'desert'
            })
        });

        const challenge = await getActiveDailyChallenge();
        expect(challenge.id).toBe(VALID_UUID);
        expect(challenge.trackKey).toBe('circuit');
        expect(challenge.objectiveType).toBe('multi_lap_total');
        expect(challenge.physicsOverrides).toBeUndefined();
    });

    it('getActiveDailyChallenge refreshes server data before using a same-day local cache', async () => {
        const endsAt = new Date(Date.now() + 3600_000).toISOString();
        memoryLocalStorage.setItem('VectorGpActiveDailyChallengeCache', JSON.stringify({
            challenge: {
                id: 'daily-gp-2026-06-12',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
                endsAt,
                availableUntil: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
                skin: 'default'
            }
        }));
        fetch.mockResolvedValue(createJsonResponse({
            id: 'daily-gp-2026-06-12',
            challengeDate: '2026-06-12',
            trackKey: 'caspianBoulevard',
            startsAt: '2026-06-12T00:00:00.000Z',
            endsAt,
            availableUntil: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default'
        }));

        const challenge = await getActiveDailyChallenge();

        expect(fetch).toHaveBeenCalledWith('/api/daily/active', expect.any(Object));
        expect(challenge.trackKey).toBe('caspianBoulevard');
    });

    it('getActiveDailyChallenge uses post data for hosted custom post previews', async () => {
        window.location = {
            hostname: 'reddit.example',
            pathname: '/preview.html',
            protocol: 'https:'
        };
        globalThis.devvit = {
            context: {
                postData: {
                    challenge: {
                        id: 'daily-gp-2026-06-02',
                        challengeDate: '2026-06-02',
                        trackKey: 'albertGardens',
                        startsAt: '2026-06-02T00:00:00.000Z',
                        endsAt: '2026-06-03T00:00:00.000Z',
                        availableUntil: '2026-06-09T00:00:00.000Z',
                        status: 'active',
                        objectiveType: 'single_lap_fastest',
                        objectiveParams: {},
                        skin: 'default'
                    }
                }
            }
        };

        const challenge = await getActiveDailyChallenge({ allowExpiredPost: true });

        expect(fetch).not.toHaveBeenCalled();
        expect(challenge.id).toBe('daily-gp-2026-06-02');
    });

    it('getActiveDailyChallenge fetches the server featured challenge for expired post starts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
        window.location = {
            hostname: 'reddit.example',
            pathname: '/game.html',
            protocol: 'https:'
        };
        globalThis.devvit = {
            context: {
                postData: {
                    challengeId: 'daily-gp-2026-06-01'
                }
            }
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'daily-gp-2026-06-10',
            challengeDate: '2026-06-10',
            trackKey: 'caspianBoulevard',
            startsAt: '2026-06-10T00:00:00.000Z',
            endsAt: '2026-06-11T00:00:00.000Z',
            availableUntil: '2026-06-17T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default'
        }));

        const challenge = await getActiveDailyChallenge();

        expect(fetch).toHaveBeenCalledWith('/api/daily/active', expect.any(Object));
        expect(challenge.id).toBe('daily-gp-2026-06-10');
        expect(challenge.trackKey).toBe('caspianBoulevard');
        vi.useRealTimers();
    });

    it('getActiveDailyChallenge falls back to mock challenge on preview pages if fetch fails', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: ''
        };
        fetch.mockRejectedValue(new Error('Network error'));

        const challenge = await getActiveDailyChallenge();

        expect(fetch).toHaveBeenCalledWith('/api/daily/active', expect.any(Object));
        expect(challenge.id).toBe('mock-daily-challenge-local');
        vi.useRealTimers();
    });

    it('detects standalone preview pages by pathname', () => {
        window.location = { pathname: '/preview.html' };
        expect(isPreviewPage()).toBe(true);

        window.location = { pathname: '/foo/Preview.HTML' };
        expect(isPreviewPage()).toBe(true);

        window.location = { pathname: '/game.html' };
        expect(isPreviewPage()).toBe(false);

        delete globalThis.window;
        expect(isPreviewPage()).toBe(false);
        globalThis.window = { localStorage: memoryLocalStorage };
    });

    it('uses mockDaily and localDev URL params when the active fetch fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetch.mockRejectedValue(new Error('offline'));

        window.location = {
            hostname: 'localhost',
            pathname: '/game.html',
            protocol: 'http:',
            search: '?mockDaily=true'
        };
        expect((await getActiveDailyChallenge()).trackKey).toBe('circuit');

        window.location.search = '?mockDaily=alloyRing';
        expect((await getActiveDailyChallenge()).trackKey).toBe('alloyRing');

        window.location.search = '?mockDaily=true&mockTrack=jadeSpiralCircuit';
        expect((await getActiveDailyChallenge()).trackKey).toBe('jadeSpiralCircuit');

        window.location.search = '?localDev=true';
        expect((await getActiveDailyChallenge()).id).toBe('mock-daily-challenge-local');
        expect((await getActiveDailyChallenge()).trackKey).toBe('circuit');
    });

    it('normalizes active challenge payloads and caches a trimmed active record', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'daily-gp-2026-06-03',
            trackKey: 'circuit',
            objectiveType: 'wat',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            status: 1,
            objectiveParams: 'bad',
            skin: '  desert  ',
            physicsOverrides: { accel: 999 }
        }));

        const challenge = await getActiveDailyChallenge();

        expect(challenge).toMatchObject({
            id: 'daily-gp-2026-06-03',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            objectiveParams: {},
            skin: 'desert'
        });
        const cached = JSON.parse(memoryLocalStorage.getItem('VectorGpActiveDailyChallengeCache'));
        expect(cached.challenge).toEqual({
            id: 'daily-gp-2026-06-03',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            skin: 'desert'
        });
        expect(cached.challenge.physicsOverrides).toBeUndefined();
    });

    it('rejects unusable active payloads and falls back to a still-current local cache', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        memoryLocalStorage.setItem('VectorGpActiveDailyChallengeCache', JSON.stringify({
            challenge: {
                id: 'cached-daily',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
                endsAt: '2099-01-01T00:00:00.000Z',
                availableUntil: '2099-01-08T00:00:00.000Z',
                skin: 'default',
                startsAt: '2026-01-01T00:00:00.000Z'
            }
        }));
        fetch.mockResolvedValue(createJsonResponse({
            id: '',
            trackKey: 'circuit'
        }));

        const challenge = await getActiveDailyChallenge();
        expect(challenge.id).toBe('cached-daily');

        memoryLocalStorage.setItem('VectorGpActiveDailyChallengeCache', JSON.stringify({
            challenge: {
                id: 'expired-cache',
                trackKey: 'circuit',
                endsAt: '2000-01-01T00:00:00.000Z'
            }
        }));
        fetch.mockRejectedValue(new Error('offline'));
        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('clears a featured start override before resolving the active challenge', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        requestFeaturedDailyChallengeStart();
        expect(memoryLocalStorage.getItem('VectorGpDailyStartOverride')).toBeTruthy();
        fetch.mockResolvedValue(createJsonResponse({
            id: 'daily-gp-featured',
            trackKey: 'circuit',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default'
        }));

        await getActiveDailyChallenge();
        expect(memoryLocalStorage.getItem('VectorGpDailyStartOverride')).toBeNull();
    });

    it('getDailyChallengeSnapshot always fetches fresh leaderboard data', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                topRows: [{ bestTimeMs: 12345 }],
                nearbyRows: [],
                currentPlayerRow: {
                    bestTimeMs: 14050,
                    completedLaps: '1',
                    checkpointTimesSec: ['4.2', '9.8']
                },
                totalCount: 3,
                objectiveType: 'single_lap_fastest',
                playerRank: 2,
                playerRankLabel: '2 / 3'
            })
        });

        const snap = await getDailyChallengeSnapshot({ challengeId: VALID_UUID });
        expect(snap.playerRank).toBe(2);
        expect(snap.playerRankLabel).toBe('2 / 3');
        expect(snap.topRows[0].bestTime).toBe(12.345);
        expect(snap.currentPlayerRow).toMatchObject({
            bestTime: 14.05,
            completedLaps: 1,
            checkpointTimesSec: ['4.2', '9.8']
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toContain('/api/daily/snapshot');
    });

    it('keeps the cached first page when a forced refresh fails', async () => {
        const challengeId = 'cache-preservation-challenge';
        window.location = {
            origin: 'https://reddit.example',
            hostname: 'reddit.example',
            pathname: '/game.html',
            protocol: 'https:',
            search: ''
        };
        fetch
            .mockResolvedValueOnce(createJsonResponse({
                topRows: [{ rank: 1, bestTimeMs: 12345 }],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 1,
                leaderboardEntryCount: 1,
                pageOffset: 0,
                pageLimit: 50,
                hasMore: false,
                nextOffset: null
            }))
            .mockRejectedValueOnce(new Error('Network error'));

        const cachedSnapshot = await getDailyChallengeSnapshot({ challengeId });

        await expect(getDailyChallengeSnapshot({
            challengeId,
            forceRefresh: true
        })).rejects.toThrow('Network error');

        expect(getCachedDailyChallengeSnapshot(challengeId)).toEqual(cachedSnapshot);
        const stored = JSON.parse(
            memoryLocalStorage.getItem('VectorGpDailyChallengeSnapshotCache')
        );
        expect(stored.entries[challengeId].snapshot).toEqual(cachedSnapshot);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('fetches later leaderboard pages instead of reusing the cached first page', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                topRows: [{ rank: 51, bestTimeMs: 20000 }],
                totalCount: 120,
                leaderboardEntryCount: 120,
                pageOffset: 50,
                pageLimit: 50,
                hasMore: true,
                nextOffset: 100,
            }),
        });

        const snapshot = await getDailyChallengeSnapshot({
            challengeId: VALID_UUID,
            limit: 50,
            offset: 50,
        });

        expect(snapshot.topRows[0]).toMatchObject({ rank: 51, bestTime: 20 });
        expect(snapshot.nextOffset).toBe(100);
        expect(fetch.mock.calls.at(-1)[0]).toContain('limit=50&offset=50');
    });

    it('rejects stored daily results that belong to another playlist track', () => {
        const challenge = {
            id: VALID_UUID,
            trackKey: 'alloyRing',
            objectiveType: 'single_lap_fastest'
        };

        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 10.4,
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest'
        })).toBe(false);

        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 14.4,
            trackKey: 'alloyRing',
            objectiveType: 'single_lap_fastest'
        })).toBe(true);
    });

    it('keeps cached published playlist rows when local generation changes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-06T16:41:00.000Z'));

        cacheDailyChallengePlaylist([
            {
                id: 'daily-gp-2026-06-03',
                challengeDate: '2026-06-03',
                trackKey: 'circuitPromax',
                startsAt: '2026-06-03T00:00:00.000Z',
                endsAt: '2026-06-04T00:00:00.000Z',
                availableUntil: '2026-06-10T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            },
            {
                id: 'daily-gp-2026-06-02',
                challengeDate: '2026-06-02',
                trackKey: 'royalPlateau',
                startsAt: '2026-06-02T00:00:00.000Z',
                endsAt: '2026-06-03T00:00:00.000Z',
                availableUntil: '2026-06-09T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            },
        ]);

        const trackKeys = getCachedDailyChallengePlaylist().map((challenge) => challenge.trackKey);

        expect(trackKeys).toContain('royalPlateau');
        expect(trackKeys).toContain('circuitPromax');
    });

    it('getDailyChallengePlaylist normalizes the server playlist payload', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                challenges: [
                    {
                        id: 'daily-gp-2026-05-24',
                        challengeDate: '2026-05-24',
                        trackKey: 'circuit',
                        startsAt: '2026-05-24T00:00:00.000Z',
                        endsAt: '2026-05-25T00:00:00.000Z',
                        availableUntil: '2026-05-31T00:00:00.000Z',
                        status: 'active',
                        objectiveType: 'single_lap_fastest',
                        objectiveParams: {},
                        skin: 'default',
                    },
                    { id: 'bad', trackKey: 'missing' },
                ],
            }),
        });

        const playlist = await getDailyChallengePlaylist();

        expect(playlist).toHaveLength(1);
        expect(playlist[0]).toMatchObject({
            id: 'daily-gp-2026-05-24',
            trackKey: 'circuit',
            availableUntil: '2026-05-31T00:00:00.000Z',
        });
        expect(fetch.mock.calls[0][0]).toBe('/api/daily/playlist');
    });

    it('uses exclusive timing boundaries for featured and expiry card states', () => {
        const challenge = {
            startsAt: '2026-06-02T00:00:00.000Z',
            endsAt: '2026-06-03T00:00:00.000Z',
            availableUntil: '2026-06-09T00:00:00.000Z',
        };

        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-06-03T00:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires on Jun 09',
        });
        expect(getDailyChallengeCardStatus(challenge, Date.parse('2026-06-09T00:00:00.000Z'))).toEqual({
            key: 'expired',
            label: 'Expired',
        });

        const almostDay = getDailyChallengeCardStatus(
            challenge,
            Date.parse('2026-06-08T00:00:00.001Z'),
        );
        expect(almostDay.key).toBe('available');
        expect(almostDay.label).toMatch(/^Expires in /);

        const exactlyDay = getDailyChallengeCardStatus(
            challenge,
            Date.parse('2026-06-08T00:00:00.000Z'),
        );
        expect(exactlyDay).toEqual({
            key: 'available',
            label: 'Expires on Jun 09',
        });
    });

    it('formats remaining playlist availability across minute, hour, and day ranges', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-03T12:25:00.000Z',
        })).toBe('25m');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-03T14:15:00.000Z',
        })).toBe('2h 15m');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-03T14:00:00.000Z',
        })).toBe('2h');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-05T15:00:00.000Z',
        })).toBe('2d 3h');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-05T12:00:00.000Z',
        })).toBe('2d');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: 'not-a-date',
        })).toBe('');

        vi.useRealTimers();
    });

    it('rejects stored results with mismatched objective or non-finite times', () => {
        const challenge = {
            id: VALID_UUID,
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
        };

        expect(isDailyChallengeStoredResultForChallenge(null, { bestTime: 10 })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, null)).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, { bestTime: Number.NaN })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 10,
            objectiveType: 'multi_lap_total',
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 10,
            trackKey: '',
            objectiveType: '',
        })).toBe(true);
    });

    it('computes required laps for multi-lap challenges', () => {
        expect(getDailyChallengeRequiredLaps(null)).toBe(1);
        expect(getDailyChallengeRequiredLaps({ objectiveType: 'single_lap_fastest' })).toBe(1);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 1 },
        })).toBe(2);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 5.9 },
        })).toBe(5);
        expect(getDailyChallengeRequiredLaps({
            objectiveType: 'multi_lap_total',
        })).toBe(2);
    });

    it('merges local and snapshot bests preferring the faster verified time', async () => {
        const challenge = {
            id: 'best-merge-challenge',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            status: 'active',
            skin: 'default',
            objectiveParams: {},
        };
        cacheDailyChallengePlaylist([challenge]);
        setDailyChallengeBestTime(challenge, 14.5, 1, [4, 8]);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: {
                bestTimeMs: 13200,
                completedLaps: 1,
                checkpointTimesSec: [3.5, 7],
            },
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 13.2,
            completedLaps: 1,
            checkpointTimesSec: [3.5, 7],
        });

        setDailyChallengeBestTime(challenge, 12.1, 1, [3, 6]);
        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 12.1,
            completedLaps: 1,
        });
    });

    it('reports missing snapshot ids and prefetches only those', async () => {
        const cachedId = 'prefetch-cached';
        const missingId = 'prefetch-missing';
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [{ bestTimeMs: 10000 }],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 1,
        }));
        await getDailyChallengeSnapshot({ challengeId: cachedId, forceRefresh: true });
        fetch.mockClear();
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
        }));

        expect(getMissingDailyChallengeSnapshotIds([
            cachedId,
            missingId,
            missingId,
            '',
            12,
            null,
        ])).toEqual([missingId]);
        expect(getMissingDailyChallengeSnapshotIds('nope')).toEqual([]);

        await prefetchDailyChallengeSnapshots([cachedId, missingId, missingId]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toContain(missingId);
    });

    it('returns a mock playlist when preview fetch fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=alloyRing',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const playlist = await getDailyChallengePlaylist({ forceRefresh: true });
        expect(playlist).toHaveLength(1);
        expect(playlist[0]).toMatchObject({
            id: 'mock-daily-challenge-local',
            trackKey: 'alloyRing',
        });
    });

    it('ignores expired post-bound challenges unless allowExpiredPost is set', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        globalThis.devvit = {
            context: {
                postData: {
                    challenge: {
                        id: 'post-expired',
                        trackKey: 'circuit',
                        startsAt: '2020-01-01T00:00:00.000Z',
                        endsAt: '2020-01-02T00:00:00.000Z',
                        availableUntil: '2020-01-08T00:00:00.000Z',
                        objectiveType: 'single_lap_fastest',
                        status: 'active',
                        skin: 'default',
                    },
                },
            },
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'daily-gp-featured-now',
            trackKey: 'alloyRing',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default',
        }));

        const featured = await getActiveDailyChallenge({ allowExpiredPost: false });
        expect(featured.id).toBe('daily-gp-featured-now');
        expect(featured.trackKey).toBe('alloyRing');

        const expiredAllowed = await getActiveDailyChallenge({ allowExpiredPost: true });
        expect(expiredAllowed.id).toBe('post-expired');
    });

    it('blocks local share helpers and rejects incomplete submit payloads', async () => {
        window.location = {
            hostname: 'localhost',
            pathname: '/game.html',
            protocol: 'http:',
            search: '',
        };

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

        window.location.hostname = 'example.devvit.net';
        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: '',
            bestTime: 12,
            replay: MINIMAL_REPLAY,
        })).resolves.toBe(null);
        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 60 * 60 + 1,
            replay: MINIMAL_REPLAY,
        })).resolves.toBe(null);
        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 12,
            replay: null,
        })).resolves.toBe(null);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not treat invalid mockDaily alone as mock mode outside preview', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '?mockDaily=notARealTrack',
        };
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('returns an empty mock snapshot when local snapshot fetch fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/game.html',
            protocol: 'http:',
            search: '',
            origin: 'http://localhost:5173',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const snapshot = await getDailyChallengeSnapshot({
            challengeId: 'local-mock-snapshot',
            forceRefresh: true,
        });
        expect(snapshot).toMatchObject({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
            playerRankLabel: '--',
        });
    });

    it('formats missing result labels as placeholders', () => {
        expect(formatDailyChallengeResultLabel({ objectiveType: 'single_lap_fastest' }, null)).toBe('--');
        expect(formatDailyChallengeResultLabel({ objectiveType: 'single_lap_fastest' }, {})).toBe('--');
        expect(formatDailyChallengeResultLabel(
            { objectiveType: 'single_lap_fastest' },
            { bestTime: 12.345 },
        )).toBe('12.35s');
        expect(formatDailyChallengeBestLabel('single_lap_fastest', Number.NaN)).toBe('--');
        expect(formatDailyChallengeBestLabel('single_lap_fastest', 9.1)).toBe('9.10s');
    });

    it('treats a missing window.location as having no mock params instead of throwing', async () => {
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('treats a missing or non-preview-html pathname as a non-preview page', () => {
        window.location = {};
        expect(isPreviewPage()).toBe(false);

        window.location = { pathname: 'preview.html' };
        expect(isPreviewPage()).toBe(true);

        window.location = { pathname: '/preview.htmlx' };
        expect(isPreviewPage()).toBe(false);

        window.location = { pathname: '/preview.html?query=1' };
        expect(isPreviewPage()).toBe(false);
    });

    it('falls through to mockTrack when mockDaily names an unknown track', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=notARealTrack&mockTrack=alloyRing',
        };
        fetch.mockRejectedValue(new Error('offline'));

        expect((await getActiveDailyChallenge()).trackKey).toBe('alloyRing');
    });

    it('falls back to the default track when neither mockDaily nor mockTrack name a real track', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockTrack=notARealTrack',
        };
        fetch.mockRejectedValue(new Error('offline'));

        expect((await getActiveDailyChallenge()).trackKey).toBe('circuit');
    });

    it('normalizes every mistyped field on an active-challenge payload to its default', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: VALID_UUID,
            trackKey: 'circuit',
            challengeDate: 123,
            startsAt: 456,
            endsAt: false,
            availableUntil: [],
            status: 99,
            objectiveType: 42,
            objectiveParams: 'not-an-object',
            skin: 42
        }));

        const challenge = await getActiveDailyChallenge();

        expect(challenge).toMatchObject({
            id: VALID_UUID,
            challengeDate: null,
            startsAt: null,
            endsAt: null,
            availableUntil: null,
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default'
        });
    });

    it('keeps a real endsAt/availableUntil/skin when provided as valid strings', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: VALID_UUID,
            trackKey: 'circuit',
            challengeDate: '2026-07-18',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            skin: 'desert'
        }));

        const challenge = await getActiveDailyChallenge();

        expect(challenge).toMatchObject({
            challengeDate: '2026-07-18',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            skin: 'desert'
        });
    });

    it('sorts the cached playlist by most recent start date and breaks ties by id', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        cacheDailyChallengePlaylist([
            {
                id: 'b-same-start',
                trackKey: 'circuit',
                startsAt: '2026-07-18T00:00:00.000Z',
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default'
            },
            {
                id: 'a-same-start',
                trackKey: 'alloyRing',
                startsAt: '2026-07-18T00:00:00.000Z',
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default'
            },
            {
                id: 'earlier-start',
                trackKey: 'royalPlateau',
                startsAt: '2026-07-17T00:00:00.000Z',
                endsAt: '2026-07-18T00:00:00.000Z',
                availableUntil: '2026-07-24T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default'
            }
        ]);

        const ids = getCachedDailyChallengePlaylist()
            .map((challenge) => challenge.id)
            .filter((id) => id.endsWith('-same-start') || id === 'earlier-start');

        expect(ids).toEqual(['b-same-start', 'a-same-start', 'earlier-start']);

        vi.useRealTimers();
    });

    it('formats remaining durations at the exact minute/hour boundary instead of rolling over early', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-03T01:00:00.000Z',
        })).toBe('1h');
        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-04T00:00:00.000Z',
        })).toBe('1d');

        vi.useRealTimers();
    });

    it('treats a snapshot exactly at "now" as expired for playlist availability', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-03T00:00:00.000Z',
        })).toBe('Expired');

        vi.useRealTimers();
    });

    it('uses the snapshot result directly when there is no locally stored best time', async () => {
        const challenge = {
            id: 'no-local-best-challenge',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            status: 'active',
            skin: 'default',
            objectiveParams: {},
        };
        cacheDailyChallengePlaylist([challenge]);

        expect(getDailyChallengeBestResult(challenge)).toBeNull();

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: {
                bestTimeMs: 15800,
                completedLaps: 1,
                checkpointTimesSec: [5, 10],
            },
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 15.8,
            completedLaps: 1,
            checkpointTimesSec: [5, 10],
        });
    });

    it('returns null when neither a snapshot row nor a local result exist', () => {
        expect(getDailyChallengeBestResult({
            id: 'no-data-at-all-challenge',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
        })).toBeNull();
        expect(getDailyChallengeBestResult(null)).toBeNull();
    });

    it('rejects the active/playlist/snapshot fetch with the server status when the response is not ok', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };

        fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
        await expect(getActiveDailyChallenge()).rejects.toThrow('Server returned status 503');

        fetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
        await expect(getDailyChallengePlaylist({ forceRefresh: true })).rejects.toThrow('Server returned status 502');

        fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
        await expect(getDailyChallengeSnapshot({
            challengeId: 'status-failure-challenge',
            forceRefresh: true,
        })).rejects.toThrow('Server returned status 500');
    });

    it('includes a guest token in the snapshot request URL when one is stored', async () => {
        memoryLocalStorage.setItem('VectorGpGuestPlayerToken', 'guest-token-123');
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
        }));

        await getDailyChallengeSnapshot({ challengeId: 'guest-token-challenge', forceRefresh: true });

        expect(fetch.mock.calls[0][0]).toContain('guestToken=guest-token-123');
    });

    it('submits an explicit checkpointTimesSec array instead of defaulting to null', async () => {
        window.location = { hostname: 'example.devvit.net' };
        fetch.mockResolvedValue(createJsonResponse({ accepted: true }));

        await submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 15.2,
            replay: MINIMAL_REPLAY,
            checkpointTimesSec: [3.1, 6.2, 9.3],
        });

        expect(JSON.parse(fetch.mock.calls[0][1].body).checkpointTimesSec).toEqual([3.1, 6.2, 9.3]);
    });

    it('falls back to a fresh fetch when reading the active-challenge cache throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        memoryLocalStorage.getItem = () => { throw new Error('storage unavailable'); };
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
        expect(console.error).toHaveBeenCalledWith(
            'Error reading active daily challenge cache:',
            expect.any(Error),
        );
    });

    it('still resolves the active challenge when writing its cache throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        memoryLocalStorage.setItem = () => { throw new Error('quota exceeded'); };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'write-error-challenge',
            trackKey: 'circuit',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default',
        }));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('write-error-challenge');
        expect(console.error).toHaveBeenCalledWith(
            'Error writing active daily challenge cache:',
            expect.any(Error),
        );
    });

    it('ignores an expired featured start override and clears it from storage', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };
        requestFeaturedDailyChallengeStart();
        vi.setSystemTime(new Date('2026-06-03T00:06:00.000Z'));
        fetch.mockResolvedValue(createJsonResponse({
            id: 'not-featured-challenge',
            trackKey: 'circuit',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default',
        }));

        await getActiveDailyChallenge();

        expect(memoryLocalStorage.getItem('VectorGpDailyStartOverride')).toBeNull();
        vi.useRealTimers();
    });

    it('swallows storage errors while reading, clearing, or writing the daily start override', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: ''
        };

        memoryLocalStorage.setItem = () => { throw new Error('quota exceeded'); };
        expect(() => requestFeaturedDailyChallengeStart()).not.toThrow();
        expect(console.error).toHaveBeenCalledWith(
            'Error writing daily start override:',
            expect.any(Error),
        );

        memoryLocalStorage.getItem = () => { throw new Error('storage unavailable'); };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'override-read-error-challenge',
            trackKey: 'circuit',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default',
        }));
        const challenge = await getActiveDailyChallenge();
        expect(challenge.id).toBe('override-read-error-challenge');
        expect(console.error).toHaveBeenCalledWith(
            'Error reading daily start override:',
            expect.any(Error),
        );
    });

    it('evicts an expired cached snapshot instead of returning stale leaderboard data', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));
        const challengeId = 'expiring-snapshot-challenge';
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId, forceRefresh: true });
        expect(getCachedDailyChallengeSnapshot(challengeId)).not.toBeNull();

        vi.setSystemTime(new Date('2026-06-05T00:00:01.000Z'));

        expect(getCachedDailyChallengeSnapshot(challengeId)).toBeNull();
        vi.useRealTimers();
    });

    it('posts share preview and confirm requests once hosted, and falls back to a null body on bad JSON', async () => {
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/game.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ status: 'ready', shareToken: 'tok-123' }),
        });

        const preview = await previewDailyChallengeShare({ challengeId: VALID_UUID, source: 'finish' });

        expect(fetch.mock.calls[0][0]).toBe('/api/daily/share/preview');
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ challengeId: VALID_UUID, source: 'finish' });
        expect(preview).toEqual({ ok: true, status: 200, body: { status: 'ready', shareToken: 'tok-123' } });

        fetch.mockResolvedValueOnce({
            ok: false,
            status: 409,
            json: async () => { throw new Error('not json'); },
        });
        const confirmed = await confirmDailyChallengeShare('tok-123');

        expect(fetch.mock.calls[1][0]).toBe('/api/daily/share/confirm');
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ shareToken: 'tok-123' });
        expect(confirmed).toEqual({ ok: false, status: 409, body: null });
    });

    it('returns an empty normalized snapshot when challengeId is missing', async () => {
        const snapshot = await getDailyChallengeSnapshot({ challengeId: '' });
        expect(snapshot).toMatchObject({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('accepts a bare array playlist payload from the server', async () => {
        fetch.mockResolvedValue(createJsonResponse([
            {
                id: 'daily-gp-array-payload',
                trackKey: 'circuit',
                startsAt: '2026-07-18T00:00:00.000Z',
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            },
        ]));

        const playlist = await getDailyChallengePlaylist({ forceRefresh: true });

        expect(playlist).toHaveLength(1);
        expect(playlist[0].id).toBe('daily-gp-array-payload');
    });

    it('deduplicates playlist merges by challenge id and caps the cache at seven days', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        cacheDailyChallengePlaylist([
            {
                id: 'dedupe-playlist-challenge',
                trackKey: 'circuit',
                startsAt: '2026-07-18T00:00:00.000Z',
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            },
        ]);
        cacheDailyChallengePlaylist([
            {
                id: 'dedupe-playlist-challenge',
                trackKey: 'alloyRing',
                startsAt: '2026-07-18T00:00:00.000Z',
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'desert',
            },
        ]);

        const deduped = getCachedDailyChallengePlaylist().filter(
            (challenge) => challenge.id === 'dedupe-playlist-challenge',
        );
        expect(deduped).toHaveLength(1);
        expect(deduped[0].trackKey).toBe('alloyRing');

        const eightDayPlaylist = Array.from({ length: 8 }, (_, index) => {
            const day = 18 - index;
            const dayString = String(day).padStart(2, '0');
            return {
                id: `cap-seven-${dayString}`,
                trackKey: 'circuit',
                startsAt: `2026-07-${dayString}T00:00:00.000Z`,
                endsAt: `2026-07-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`,
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
        });
        cacheDailyChallengePlaylist(eightDayPlaylist);
        expect(getCachedDailyChallengePlaylist()).toHaveLength(7);

        vi.useRealTimers();
    });

    it('sorts playlist rows without startsAt by id and keeps multi-lap copy labels', async () => {
        vi.resetModules();
        const { cacheDailyChallengePlaylist } = await import('../game/daily-challenge/service.js');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        globalThis.window = {
            localStorage: {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {},
            },
        };

        const merged = cacheDailyChallengePlaylist([
            {
                id: 'z-no-start',
                trackKey: 'circuit',
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            },
            {
                id: 'a-no-start',
                trackKey: 'alloyRing',
                endsAt: '2026-07-19T00:00:00.000Z',
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            },
        ]);

        expect(
            merged
                .filter((challenge) => challenge.id.endsWith('-no-start'))
                .map((challenge) => challenge.id),
        ).toEqual(['z-no-start', 'a-no-start']);

        expect(getDailyChallengeCopyLabels({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 4 },
        })).toEqual({
            hudPrimaryLabel: 'RACE',
            primaryStatLabel: 'Race Time',
            bestSummaryLabel: 'Best Race',
            modeSelectLine: 'Best race time',
        });

        vi.useRealTimers();
    });

    it('deep-clones objectiveParams so cached playlist edits do not leak', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const merged = cacheDailyChallengePlaylist([{
            id: 'clone-objective-params-main',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
            skin: 'default',
        }]);

        const cached = merged.find((challenge) => challenge.id === 'clone-objective-params-main');
        cached.objectiveParams.lapCount = 99;

        expect(
            getCachedDailyChallengePlaylist()
                .find((challenge) => challenge.id === 'clone-objective-params-main')
                .objectiveParams,
        ).toEqual({ lapCount: 3 });

        vi.useRealTimers();
    });

    it('keeps challenges usable on endsAt alone when availableUntil is missing', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const merged = cacheDailyChallengePlaylist([{
            id: 'ends-at-only-main',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        }]);

        expect(merged.map((challenge) => challenge.id)).toContain('ends-at-only-main');

        vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
        expect(
            getCachedDailyChallengePlaylist()
                .some((challenge) => challenge.id === 'ends-at-only-main'),
        ).toBe(false);

        vi.useRealTimers();
    });

    it('uses card-status date fallback when availableUntil is not parseable', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

        expect(getDailyChallengeCardStatus({
            endsAt: '2026-06-02T00:00:00.000Z',
            availableUntil: 'not-a-date',
        })).toEqual({
            key: 'expired',
            label: 'Expired',
        });

        expect(getDailyChallengeCardStatus({
            endsAt: '2026-06-02T00:00:00.000Z',
            availableUntil: '2026-06-09T00:00:00.000Z',
        }, Date.parse('2026-06-08T23:30:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires in 30m',
        });

        vi.useRealTimers();
    });

    it('keeps local completed laps when a faster snapshot row omits them', async () => {
        const challenge = {
            id: 'completed-laps-merge-challenge',
            trackKey: 'circuit',
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 3 },
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            status: 'active',
            skin: 'default',
        };
        cacheDailyChallengePlaylist([challenge]);
        setDailyChallengeBestTime(challenge, 45.5, 3, [10, 20, 30]);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: {
                bestTimeMs: 44000,
            },
            totalCount: 1,
            objectiveType: 'multi_lap_total',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({
            bestTime: 44,
            completedLaps: 3,
        });
    });

    it('returns null from submit when fetch is unavailable or challengeId is not a string', async () => {
        const originalFetch = globalThis.fetch;
        delete globalThis.fetch;

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 12,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();

        globalThis.fetch = originalFetch;

        await expect(submitDailyChallengeBestTime({
            challengeId: 123,
            trackKey: 'circuit',
            bestTime: 12,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('no-ops featured start override writes when window storage is unavailable', () => {
        delete globalThis.window;
        expect(() => requestFeaturedDailyChallengeStart()).not.toThrow();
        globalThis.window = { localStorage: memoryLocalStorage };
    });

    it('rejects an active cache whose endsAt is exactly now', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        memoryLocalStorage.setItem('VectorGpActiveDailyChallengeCache', JSON.stringify({
            challenge: {
                id: 'exactly-now-cache',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
                endsAt: '2026-06-03T12:00:00.000Z',
                skin: 'default',
            },
        }));
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
        vi.useRealTimers();
    });

    it('swallows URLSearchParams constructor failures while resolving mock params', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const OriginalURLSearchParams = globalThis.URLSearchParams;
        globalThis.URLSearchParams = class BrokenSearchParams {
            constructor() {
                throw new Error('invalid search');
            }
        };
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=true',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge?.id).toBe('mock-daily-challenge-local');
        globalThis.URLSearchParams = OriginalURLSearchParams;
    });

    it('returns null mock challenge when the catalog default track is missing', async () => {
        vi.resetModules();
        vi.doMock('../game/track/catalog.js', async (importOriginal) => {
            const actual = await importOriginal();
            return {
                ...actual,
                DEFAULT_TRACK_KEY: '',
                hasTrack: () => false,
            };
        });
        const service = await import('../game/daily-challenge/service.js');
        globalThis.window = {
            localStorage: createMemoryLocalStorage(),
            location: {
                hostname: 'localhost',
                pathname: '/preview.html',
                protocol: 'http:',
                search: '?mockDaily=true',
            },
        };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        await expect(service.getActiveDailyChallenge()).resolves.toBeNull();

        vi.doUnmock('../game/track/catalog.js');
        vi.resetModules();
    });

    it('normalizes active-cache objective and skin fallbacks before reuse', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const endsAt = new Date(Date.now() + 3600_000).toISOString();
        memoryLocalStorage.setItem('VectorGpActiveDailyChallengeCache', JSON.stringify({
            challenge: {
                id: 'cache-fallback-fields',
                trackKey: 'circuit',
                objectiveType: 123,
                endsAt,
                availableUntil: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
                skin: '   ',
            },
        }));
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge).toMatchObject({
            id: 'cache-fallback-fields',
            objectiveType: 'single_lap_fastest',
            skin: 'default',
        });
    });

    it('swallows errors while clearing the featured start override', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        requestFeaturedDailyChallengeStart();
        memoryLocalStorage.removeItem = () => {
            throw new Error('remove failed');
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'override-clear-error',
            trackKey: 'circuit',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default',
        }));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('override-clear-error');
        expect(console.error).toHaveBeenCalledWith(
            'Error clearing daily start override:',
            expect.any(Error),
        );
    });

    it('blocks localhost scoreboard writes before calling fetch', async () => {
        window.location = {
            hostname: 'localhost',
            pathname: '/index.html',
            protocol: 'http:',
            search: '',
        };

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 12,
            replay: MINIMAL_REPLAY,
        })).resolves.toEqual({
            ok: false,
            status: 403,
            body: { error: 'Writing to the scoreboard is prohibited from localhost.' },
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('returns cached snapshots without refetching and skips prefetch when nothing is missing', async () => {
        const challengeId = 'cached-snapshot-hit';
        fetch.mockResolvedValue(createJsonResponse({
            topRows: [{ bestTimeMs: 12000 }],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId, forceRefresh: true });
        fetch.mockClear();

        const cached = await getDailyChallengeSnapshot({ challengeId });
        expect(cached.totalCount).toBe(1);
        expect(fetch).not.toHaveBeenCalled();

        await prefetchDailyChallengeSnapshots([challengeId]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses card-status date and remaining fallbacks when formatting returns empty labels', () => {
        const dateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => ({
            format: () => '',
        }));

        expect(getDailyChallengeCardStatus({
            endsAt: '2026-06-02T00:00:00.000Z',
            availableUntil: '2026-06-09T00:00:00.000Z',
        }, Date.parse('2026-06-03T12:00:00.000Z'))).toEqual({
            key: 'available',
            label: 'Expires',
        });

        dateTimeFormatSpy.mockRestore();
    });

    it('ignores playlist payloads whose challenges field is not an array', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'localhost',
            pathname: '/preview.html',
            protocol: 'http:',
            search: '?mockDaily=true',
        };
        fetch.mockResolvedValue(createJsonResponse({ challenges: 'not-an-array' }));

        const playlist = await getDailyChallengePlaylist({ forceRefresh: true });

        expect(playlist).toHaveLength(1);
        expect(playlist[0].id).toBe('mock-daily-challenge-local');
    });

    it('rejects active caches without a usable endsAt timestamp', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        memoryLocalStorage.setItem('VectorGpActiveDailyChallengeCache', JSON.stringify({
            challenge: {
                id: 'missing-ends-at-cache',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
                skin: 'default',
            },
        }));
        fetch.mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('keeps the local best time when it is faster than the cached snapshot row', async () => {
        const challenge = {
            id: 'local-faster-than-snapshot',
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            status: 'active',
            skin: 'default',
        };
        cacheDailyChallengePlaylist([challenge]);
        setDailyChallengeBestTime(challenge, 10.5);

        fetch.mockResolvedValue(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: { bestTimeMs: 12500 },
            totalCount: 1,
            objectiveType: 'single_lap_fastest',
        }));
        await getDailyChallengeSnapshot({ challengeId: challenge.id, forceRefresh: true });

        expect(getDailyChallengeBestResult(challenge)).toMatchObject({ bestTime: 10.5 });
    });

    it('rejects stored results whose objective type does not match the challenge', () => {
        const challenge = {
            id: VALID_UUID,
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
        };

        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.4,
            objectiveType: 'multi_lap_total',
        })).toBe(false);
    });

    it('returns null from submit when bestTime is outside the allowed daily range', async () => {
        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 1.5,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();

        await expect(submitDailyChallengeBestTime({
            challengeId: VALID_UUID,
            trackKey: 'circuit',
            bestTime: 3601,
            replay: MINIMAL_REPLAY,
        })).resolves.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('formats playlist availability in days when more than 24 hours remain', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-06-04T12:00:00.000Z',
        })).toBe('3d');

        vi.useRealTimers();
    });

    it('discards an expired featured start override before fetching the active challenge', async () => {
        memoryLocalStorage.setItem('VectorGpDailyStartOverride', JSON.stringify({
            mode: 'featured',
            expiresAt: Date.now() - 1000,
        }));
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'daily-gp-after-expired-override',
            trackKey: 'circuit',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default',
        }));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('daily-gp-after-expired-override');
        expect(memoryLocalStorage.getItem('VectorGpDailyStartOverride')).toBeNull();
    });

    it('ignores post-bound postData when the nested challenge is invalid', async () => {
        globalThis.devvit = {
            context: {
                postData: {
                    challenge: { id: '', trackKey: 'circuit' },
                },
            },
        };
        window.location = {
            hostname: 'example.devvit.net',
            pathname: '/index.html',
            protocol: 'https:',
            search: '',
        };
        fetch.mockResolvedValue(createJsonResponse({
            id: 'daily-gp-valid-fetch',
            trackKey: 'circuit',
            startsAt: '2026-06-03T00:00:00.000Z',
            endsAt: '2026-06-04T00:00:00.000Z',
            availableUntil: '2026-06-10T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            status: 'active',
            skin: 'default',
        }));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('daily-gp-valid-fetch');
    });

    it('returns false from isPreviewPage when window is unavailable', () => {
        delete globalThis.window;
        expect(isPreviewPage()).toBe(false);
        globalThis.window = { localStorage: memoryLocalStorage };
    });
});
