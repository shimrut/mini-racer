import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildModalRunsPayload,
    buildScoreboardRankDisplay,
    pushRecentLap,
} from '../game/race/result-flow.js';
import {
    clearDailyChallengeBestTime,
    getDailyChallengeData,
    restoreDailyChallengeBestAfterFailedSubmission,
    saveDailyChallengeBestTime,
} from '../game/daily-challenge/storage.js';
import {
    createVerificationSnapshot,
    enqueueDailyChallengeVerification,
    getDailyChallengeVerificationEntry,
    getNextVerificationAttemptAt,
    isDailyChallengeVerificationExpired,
    markDailyChallengeVerificationPending,
    resetVerificationQueueForTests,
} from '../game/scoreboard/verification-queue.js';
import {
    clearActivePlayerOwnerId,
    setActivePlayerOwnerId,
} from '../game/player/active-owner.js';
import {
    PB_GHOST_MAX_ENCODED_BYTES,
    PB_GHOST_SAMPLE_INTERVAL_MS,
    PB_GHOST_SCHEMA_VERSION,
    createPbGhostTraceRecorder,
    createTrackFingerprint,
    isValidPbGhostTrace,
} from '../src/server/pb-ghost-trace.ts';
import { parseDailyAutopostSubscription } from '../src/server/daily-autopost-store.ts';
import { parseDailyPodiumAutopostSubscription } from '../src/server/daily-podium-autopost-store.ts';

const VERIFICATION_STORAGE_KEY = 'VectorGpVerificationQueue';
const DAILY_CHALLENGE_STORAGE_KEY = 'VectorGpDailyChallengeData';
const CHALLENGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const REPLAY = { inputs: [{ frames: 1, left: false, right: false }] };

function installLocalStorage(seed = null) {
    const map = new Map();
    if (seed) {
        Object.entries(seed).forEach(([key, value]) => map.set(key, value));
    }
    globalThis.window = {
        localStorage: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, value),
            removeItem: (key) => map.delete(key),
        },
    };
}

function validTrace(overrides = {}) {
    return {
        schemaVersion: PB_GHOST_SCHEMA_VERSION,
        sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [1, 2, 3],
        ...overrides,
    };
}

describe('mutation soft spots wave 6', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        clearActivePlayerOwnerId();
        delete globalThis.window;
    });

    describe('result-flow', () => {
        it('labels rejected and pending-verification ranks from status text alone', () => {
            expect(buildScoreboardRankDisplay({
                submissionStage: 'rejected',
                playerRankLabel: '#2',
            }).labelText).toBe('Rank rejected');
            expect(buildScoreboardRankDisplay({
                statusText: 'Pending verification',
            }).labelText).toBe('Rank pending');
            expect(buildScoreboardRankDisplay({
                statusText: 'Pending verification...',
            }).labelText).toBe('Rank pending');
        });

        it('shows loading labels without rank text and preserves labels once loaded', () => {
            expect(buildScoreboardRankDisplay({
                isLoading: true,
            })).toMatchObject({
                labelText: 'Loading rank',
                text: '',
                isLoading: true,
            });
            expect(buildScoreboardRankDisplay({
                isLoading: false,
                playerRankLabel: '#4',
            })).toMatchObject({
                text: '#4',
                isLoading: false,
            });
            expect(buildScoreboardRankDisplay({
                isLoading: false,
            }, { fallbackText: 'N/A' })).toMatchObject({
                text: 'N/A',
            });
        });

        it('keeps recent laps at the max boundary and ignores invalid update objects', () => {
            const laps = [{ lapNumber: 1 }, { lapNumber: 2 }, { lapNumber: 3 }];
            pushRecentLap(laps, { lapNumber: 4 }, 4);
            expect(laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3, 4]);

            const base = {
                bestTime: 20,
                currentTime: 21,
                lapTimesArray: [20],
                scoreboardSnapshot: { playerRank: 1 },
            };
            expect(buildModalRunsPayload(base, { updates: null })).toMatchObject({
                bestTime: 20,
                currentTime: 21,
            });
            expect(buildModalRunsPayload(base, { updates: 'bad' })).toMatchObject({
                bestTime: 20,
                currentTime: 21,
            });
            expect(buildModalRunsPayload(base, {
                updates: {
                    currentTime: 19,
                    lapTimesArray: [19, 20],
                    scoreboardSnapshot: null,
                },
            })).toMatchObject({
                currentTime: 19,
                lapTimesArray: [19, 20],
                scoreboardSnapshot: null,
            });
        });

    });

    describe('verification-queue', () => {
        beforeEach(() => {
            installLocalStorage();
            resetVerificationQueueForTests();
            setActivePlayerOwnerId('reddit:racer');
        });

        afterEach(() => {
            clearActivePlayerOwnerId();
        });

        it('derives legacy expiry from challengeDate when challengeId does not match the anchored pattern', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
            const playlistMs = 7 * 24 * 60 * 60 * 1000;
            const bufferMs = 6 * 60 * 60 * 1000;
            const startsAt = Date.parse('2026-07-18T00:00:00.000Z');
            const expectedExpiry = new Date(startsAt + playlistMs + bufferMs).toISOString();

            installLocalStorage({
                [VERIFICATION_STORAGE_KEY]: JSON.stringify({
                    daily: {
                        'custom-challenge-id': {
                            challengeId: 'custom-challenge-id',
                            challengeDate: '2026-07-18',
                            bestTime: 20,
                            replay: REPLAY,
                            verificationState: 'pending',
                            nextAttemptAt: Date.now() + 60_000,
                        },
                    },
                }),
            });

            expect(getDailyChallengeVerificationEntry('custom-challenge-id')?.expiresAt).toBe(expectedExpiry);
        });

        it('normalizes numeric expiresAt values while reading the queue', () => {
            const futureMs = Date.now() + 120_000;
            installLocalStorage({
                [VERIFICATION_STORAGE_KEY]: JSON.stringify({
                    daily: {
                        'normalize-expiry': {
                            challengeId: 'normalize-expiry',
                            bestTime: 20,
                            replay: REPLAY,
                            verificationState: 'pending',
                            nextAttemptAt: Date.now() + 60_000,
                            expiresAt: futureMs,
                        },
                    },
                }),
            });

            expect(getDailyChallengeVerificationEntry('normalize-expiry')?.expiresAt)
                .toBe(new Date(futureMs).toISOString());
        });

        it('treats missing daily maps and null expiry as empty or expired queue state', () => {
            installLocalStorage({
                [VERIFICATION_STORAGE_KEY]: JSON.stringify({ daily: null }),
            });
            expect(getDailyChallengeVerificationEntry('missing')).toBeNull();

            expect(isDailyChallengeVerificationExpired({
                challengeId: 'no-expiry',
                bestTime: 20,
            }, Date.now())).toBe(true);
        });

        it('copies previous checkpoint arrays and preserves updatedAt when requested', () => {
            enqueueDailyChallengeVerification({
                challengeId: 'checkpoint-copy',
                bestTime: 20,
                replay: REPLAY,
                checkpointTimesSec: [1, 2, 3],
                previousCheckpointTimesSec: [4, 5, 6],
            });
            const entry = getDailyChallengeVerificationEntry('checkpoint-copy');
            entry.checkpointTimesSec[0] = 99;
            entry.previousCheckpointTimesSec[0] = 88;
            const stored = getDailyChallengeVerificationEntry('checkpoint-copy');
            expect(stored.checkpointTimesSec).toEqual([1, 2, 3]);
            expect(stored.previousCheckpointTimesSec).toEqual([4, 5, 6]);

            const updatedAt = stored.updatedAt;
            markDailyChallengeVerificationPending('checkpoint-copy', Date.now() + 60_000, {
                preserveUpdatedAt: true,
                submissionStage: 'verifying',
            });
            expect(getDailyChallengeVerificationEntry('checkpoint-copy').updatedAt).toBe(updatedAt);
        });

        it('returns the earliest pending retry and normalizes empty verification state defaults', () => {
            const now = Date.now();
            enqueueDailyChallengeVerification({ challengeId: 'retry-a', bestTime: 20, replay: REPLAY });
            enqueueDailyChallengeVerification({ challengeId: 'retry-b', bestTime: 21, replay: REPLAY });
            markDailyChallengeVerificationPending('retry-a', now + 5_000);
            markDailyChallengeVerificationPending('retry-b', now + 1_000);

            expect(getNextVerificationAttemptAt()).toBe(now + 1_000);

            expect(createVerificationSnapshot({
                verificationState: '',
                submissionStage: 'bogus',
            })).toMatchObject({
                verificationState: 'pending',
                submissionStage: 'pending',
                statusText: 'Pending',
            });
        });
    });

    describe('daily-challenge storage', () => {
        beforeEach(() => {
            installLocalStorage();
        });

        it('clears one challenge without deleting sibling entries', () => {
            const challengeA = {
                id: 'challenge-a',
                challengeDate: '2026-04-14',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
            };
            const challengeB = {
                id: 'challenge-b',
                challengeDate: '2026-04-15',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
            };
            saveDailyChallengeBestTime(challengeA, 40);
            saveDailyChallengeBestTime(challengeB, 41);

            expect(clearDailyChallengeBestTime('challenge-a')).toBeNull();
            expect(getDailyChallengeData('challenge-a')).toBeNull();
            expect(getDailyChallengeData('challenge-b')).toMatchObject({ bestTime: 41 });
        });

        it('rejects restore attempts when the challenge id is missing', () => {
            expect(restoreDailyChallengeBestAfterFailedSubmission(
                { trackKey: 'circuit' },
                { bestTime: 12.5 },
            )).toBeNull();
        });

        it('drops checkpoint splits when the stored entry is not an object', () => {
            installLocalStorage({
                [DAILY_CHALLENGE_STORAGE_KEY]: JSON.stringify({
                    [CHALLENGE_ID]: null,
                }),
            });
            const challenge = {
                id: CHALLENGE_ID,
                challengeDate: '2026-04-14',
                trackKey: 'circuit',
                objectiveType: 'single_lap_fastest',
            };

            expect(saveDailyChallengeBestTime(challenge, 40, null, [10, 20, 40])).toMatchObject({
                bestTime: 40,
                checkpointTimesSec: [10, 20, 40],
            });
        });
    });

    describe('player bootstrap storage', () => {
        const PLAYER_ID_KEY = 'VectorGpScoreboardPlayerId';

        beforeEach(() => {
            vi.resetModules();
        });

        afterEach(() => {
            vi.unstubAllGlobals();
            vi.doUnmock('../game/scoreboard/api-client.js');
            vi.doUnmock('../game/scoreboard/player-identity.js');
        });

        it('passes the player bootstrap context string to getOrCreatePlayerId', async () => {
            const getOrCreatePlayerId = vi.fn(() => 'guest:test-id');
            vi.doMock('../game/scoreboard/player-identity.js', async () => {
                const actual = await vi.importActual('../game/scoreboard/player-identity.js');
                return {
                    ...actual,
                    getOrCreatePlayerId,
                };
            });
            vi.doMock('../game/scoreboard/api-client.js', async () => {
                const actual = await vi.importActual('../game/scoreboard/api-client.js');
                return {
                    ...actual,
                    API_ROUTES: { playerBootstrapUrl: '/api/player/bootstrap' },
                };
            });
            vi.stubGlobal('window', {
                location: {
                    hostname: 'example.devvit.net',
                    origin: 'https://example.devvit.net',
                    protocol: 'https:',
                },
                localStorage: {
                    getItem: () => null,
                    setItem: () => {},
                    removeItem: () => {},
                },
            });
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    playerId: 'guest:test-id',
                    leaderboardIdentity: 'constructed',
                }),
            }));

            const { getPlayerProgressState } = await import('../game/player/progress-state.js');
            await getPlayerProgressState();

            expect(getOrCreatePlayerId).toHaveBeenCalledWith('player bootstrap');
        });

        it('does not rotate guest identity when bootstrap errors lack a status code', async () => {
            vi.stubGlobal('window', {
                location: {
                    hostname: 'example.devvit.net',
                    origin: 'https://example.devvit.net',
                    protocol: 'https:',
                },
                localStorage: {
                    getItem: (key) => (key === PLAYER_ID_KEY ? 'old-guest-id' : null),
                    setItem: vi.fn(),
                    removeItem: vi.fn(),
                },
            });
            const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
            vi.stubGlobal('fetch', fetchMock);
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

            const { getPlayerProgressState } = await import('../game/player/progress-state.js');
            const state = await getPlayerProgressState();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(state.leaderboardPlayerId).toBe('old-guest-id');
            expect(consoleError).toHaveBeenCalled();
        });
    });

    describe('daily post stores', () => {
        it('keeps autopost string fields only when they are non-empty strings', () => {
            expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify({
                enabled: true,
                enabledAt: '2026-07-01T00:00:00.000Z',
                updatedAt: '2026-07-02T00:00:00.000Z',
                lastPostedChallengeId: 'daily-gp-2026-07-01',
                lastPostedAt: '2026-07-01T12:00:00.000Z',
                lastPostUrl: 42,
            }))).toMatchObject({
                enabledAt: '2026-07-01T00:00:00.000Z',
                lastPostUrl: null,
            });
            expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify({
                enabled: true,
                lastPostUrl: ['https://reddit.com/post'],
            }))).toMatchObject({
                lastPostUrl: null,
            });
        });
    });

    describe('pb-ghost-trace', () => {
        it('accepts traces whose encoded size is exactly at the byte cap', () => {
            const deltas = Array.from({ length: 999 * 3 }, () => 0);
            const trace = validTrace({
                finishTimeMs: 999 * PB_GHOST_SAMPLE_INTERVAL_MS,
                deltas,
            });
            const encodedBytes = Buffer.byteLength(JSON.stringify(trace), 'utf8');
            expect(encodedBytes).toBeLessThanOrEqual(PB_GHOST_MAX_ENCODED_BYTES);
            expect(isValidPbGhostTrace(trace)).toBe(true);
        });

        it('keeps a half-turn angular delta unwrapped at the inclusive boundary', () => {
            const halfTurnMilli = Math.round(Math.PI * 1000);
            const recorder = createPbGhostTraceRecorder({
                timeSec: 0,
                position: { x: 0, y: 0 },
                angle: 0,
            });
            recorder.sample({
                timeSec: 0.05,
                position: { x: 1, y: 0 },
                angle: halfTurnMilli / 1000,
            });
            const trace = recorder.finish({
                timeSec: 0.05,
                position: { x: 1, y: 0 },
                angle: halfTurnMilli / 1000,
            });
            expect(trace.deltas[2]).toBe(halfTurnMilli);
        });

        it('hashes track fingerprints with utf-8 encoding', () => {
            const track = {
                outer: [{ x: 0, y: 0 }],
                inner: [{ x: 1, y: 1 }],
                startLine: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
                startPos: { x: 0, y: -1 },
                startAngle: 0,
                checkpoints: [{ x: 2, y: 2 }],
            };
            const stable = {
                outer: track.outer,
                inner: track.inner,
                startLine: track.startLine,
                startPos: track.startPos,
                startAngle: track.startAngle,
                checkpoints: track.checkpoints,
            };
            const expected = createHash('sha256')
                .update(JSON.stringify(stable), 'utf8')
                .digest('base64url');
            expect(createTrackFingerprint(track)).toBe(expected);
        });
    });
});
