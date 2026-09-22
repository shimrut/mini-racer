import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    formatDailyChallengePlaylistAvailabilityLabel,
    getDailyChallengeBestResult,
    getDailyChallengeCardStatus,
    getDailyChallengePlaylist,
    getDailyChallengeRequiredLaps,
    getDailyChallengeSnapshot,
    isDailyChallengeStoredResultForChallenge,
    isPreviewPage,
    resolveDailyPlaylistCacheExpiresAt,
    submitDailyChallengeBestTime,
} from '../game/daily-challenge/service.js';
import { setDailyChallengeBestTime } from '../game/daily-challenge/storage.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

function buildChallenge(overrides = {}) {
    return {
        id: 'wave4-challenge',
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

describe('daily-challenge service wave4', () => {
    let memoryLocalStorage;

    beforeEach(() => {
        memoryLocalStorage = createMemoryLocalStorage();
        globalThis.window = {
            localStorage: memoryLocalStorage,
            location: {
                hostname: 'localhost',
                pathname: '/preview.html',
                protocol: 'http:',
                search: '',
                origin: 'http://localhost',
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

    it('detects preview.html paths case-insensitively and rejects non-preview pages (L56)', () => {
        window.location.pathname = '/foo/PREVIEW.HTML';
        expect(isPreviewPage()).toBe(true);

        window.location.pathname = '/game.html';
        expect(isPreviewPage()).toBe(false);

        delete globalThis.window;
        expect(isPreviewPage()).toBe(false);
    });

    it('ignores schedule changes within one second of now when resolving playlist expiry (L427-L428)', () => {
        const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
        const challenge = buildChallenge({
            startsAt: '2026-07-18T12:00:00.500Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
        });

        const expiresAt = resolveDailyPlaylistCacheExpiresAt([challenge], nowMs);

        expect(expiresAt).toBe(Date.parse('2026-07-19T00:00:00.000Z'));
        expect(expiresAt).toBeGreaterThan(nowMs + 1000);
    });

    it('rejects stored results whose track or objective disagree with the challenge (L437-L451)', () => {
        const challenge = buildChallenge({
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
        });

        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.5,
            trackKey: 'desertBridge',
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.5,
            objectiveType: 'multi_lap_total',
        })).toBe(false);
        expect(isDailyChallengeStoredResultForChallenge(challenge, {
            bestTime: 12.5,
            trackKey: 'circuit',
            objectiveType: 'single_lap_fastest',
        })).toBe(true);
        expect(isDailyChallengeStoredResultForChallenge(challenge, null)).toBe(false);
    });

    it('uses only supported persisted lap counts and falls back safely for malformed objectives', () => {
        const challenge = buildChallenge({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 1 },
        });

        expect(getDailyChallengeRequiredLaps(challenge)).toBe(1);

        expect(getDailyChallengeRequiredLaps(buildChallenge({
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 4 },
        }))).toBe(1);

        expect(getDailyChallengeRequiredLaps(buildChallenge({
            objectiveType: 'single_lap_fastest',
        }))).toBe(1);
    });

    it('uses minute labels when availability is under one day and date labels after (L679, L711)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const underDay = buildChallenge({
            endsAt: '2026-07-17T00:00:00.000Z',
            availableUntil: '2026-07-18T13:30:00.000Z',
        });
        expect(getDailyChallengeCardStatus(underDay)).toEqual({
            key: 'available',
            label: 'Expires in 1h 30m',
        });

        const multiDay = buildChallenge({
            endsAt: '2026-07-17T00:00:00.000Z',
            availableUntil: '2026-07-22T00:00:00.000Z',
        });
        expect(getDailyChallengeCardStatus(multiDay)).toEqual({
            key: 'available',
            label: 'Expires on Jul 22',
        });

        expect(formatDailyChallengePlaylistAvailabilityLabel({
            availableUntil: '2026-07-18T12:00:45.000Z',
        })).toBe('1m');

        vi.useRealTimers();
    });

    it('prefers the faster cached snapshot row over a slower local best (L583-L590)', () => {
        const challenge = buildChallenge({ id: 'merge-best-wave4' });
        setDailyChallengeBestTime(challenge, 15.0, 1);

        memoryLocalStorage.setItem('VectorGpDailyChallengeSnapshotCache', JSON.stringify({
            entries: {
                [challenge.id]: {
                    snapshot: {
                        topRows: [],
                        nearbyRows: [],
                        currentPlayerRow: {
                            bestTime: 12.34,
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

        expect(getDailyChallengeBestResult(challenge)).toEqual({
            bestTime: 12.34,
            completedLaps: 1,
            checkpointTimesSec: [],
        });
    });

    it('returns an empty snapshot when challengeId is missing (L918)', async () => {
        const snapshot = await getDailyChallengeSnapshot({ challengeId: '' });

        expect(snapshot).toMatchObject({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('accepts playlist payloads wrapped in a challenges array (L815-L817)', async () => {
        fetch.mockResolvedValue(createJsonResponse({
            challenges: [
                buildChallenge({ id: 'wrapped-wave4' }),
            ],
        }));

        const playlist = await getDailyChallengePlaylist({ forceRefresh: true });

        expect(playlist).toHaveLength(1);
        expect(playlist[0].id).toBe('wrapped-wave4');
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET' });
        expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('rejects daily submissions outside the allowed time window (L986-L991)', async () => {
        const tooFast = await submitDailyChallengeBestTime({
            challengeId: 'wave4-submit',
            trackKey: 'circuit',
            bestTime: 1.99,
            replay: { inputs: [] },
        });
        const tooSlow = await submitDailyChallengeBestTime({
            challengeId: 'wave4-submit',
            trackKey: 'circuit',
            bestTime: 3601,
            replay: { inputs: [] },
        });
        const missingReplay = await submitDailyChallengeBestTime({
            challengeId: 'wave4-submit',
            trackKey: 'circuit',
            bestTime: 12.5,
        });

        expect(tooFast).toBeNull();
        expect(tooSlow).toBeNull();
        expect(missingReplay).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });
});
