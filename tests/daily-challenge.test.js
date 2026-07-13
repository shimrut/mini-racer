import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    formatDailyChallengeBestLabel,
    formatDailyChallengePlaylistAvailabilityLabel,
    formatDailyChallengeResultLabel,
    getActiveDailyChallenge,
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
    cacheDailyChallengePlaylist,
    getCachedDailyChallengePlaylist,
    isDailyChallengeStoredResultForChallenge,
    submitDailyChallengeBestTime
} from '../game/daily-challenge/service.js';

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
            label: 'Available until Jun 09',
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
});
