import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TRACK_CATALOG, TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import { TRACKS } from '../game/track/tracks.js';
import { getBackfilledDailyGpChallenge } from '../src/server/daily-gp-history-backfill.ts';
import {
    createTrackFingerprint,
} from '../src/server/pb-ghost-trace.ts';
import {
    createDailyChallengeId,
    DAILY_GP_PLAYLIST_DAYS,
    DAY_MS,
    formatUtcChallengeDate,
    getDailyGpCompetitionTtlSeconds,
    getUtcDayIndex,
} from '../src/server/daily-gp-model.ts';

function getTodayChallengeIdForTest() {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = new Date(dayIndex * DAY_MS);
    return createDailyChallengeId(formatUtcChallengeDate(startsAt));
}

const mockRedis = {
    get: vi.fn(),
    mGet: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incrBy: vi.fn(),
    hGet: vi.fn(),
    hMGet: vi.fn(),
    hSet: vi.fn(),
    hSetNX: vi.fn(),
    hGetAll: vi.fn(),
    hScan: vi.fn(),
    hDel: vi.fn(),
    expire: vi.fn(),
    expireTime: vi.fn(),
    zAdd: vi.fn(),
    zCard: vi.fn(),
    zRange: vi.fn(),
    zRank: vi.fn(),
    watch: vi.fn(),
};
const mockValidateDailyGpReplayDetailed = vi.fn();
const ownedLocks = new Map();
const storedStrings = new Map();

function checkpointSplitsForChallenge(challenge, bestTimeSec) {
    const count = TRACKS[challenge.trackKey]?.checkpoints?.length || 0;
    return Array.from({ length: count }, (_, index) => {
        return ((index + 1) * bestTimeSec) / (count + 1);
    });
}

function findWrittenPlayerProfile(playerId) {
    for (const [key, rawProfile, options] of [...mockRedis.set.mock.calls].reverse()) {
        if (!String(key).startsWith('dailygp:player-profile:')) continue;
        try {
            const profile = JSON.parse(rawProfile);
            if (profile.playerId === playerId) {
                return { key, profile, options };
            }
        } catch (_error) {
        }
    }
    return null;
}

function isPlayerProfileKey(key) {
    return String(key).startsWith('dailygp:player-profile:');
}

function playerProfileRedisKey(playerId) {
    return `dailygp:player-profile:${createHash('sha256').update(playerId, 'utf8').digest('base64url')}`;
}

function seedStoredPlayerProfile(playerId, profile) {
    storedStrings.set(playerProfileRedisKey(playerId), JSON.stringify(profile));
}

function createMockTransaction(options = {}) {
    const commands = [];
    const hasExecResult = Object.prototype.hasOwnProperty.call(options, 'execResult');
    let hasLeaderboardWrite = false;
    return {
        multi: vi.fn().mockResolvedValue(undefined),
        unwatch: vi.fn().mockResolvedValue(undefined),
        del: vi.fn(async (...args) => {
            commands.push(() => mockRedis.del(...args));
        }),
        set: vi.fn(async (...args) => {
            commands.push(() => mockRedis.set(...args));
        }),
        hSet: vi.fn(async (...args) => {
            commands.push(() => mockRedis.hSet(...args));
        }),
        zAdd: vi.fn(async (...args) => {
            hasLeaderboardWrite = true;
            commands.push(() => mockRedis.zAdd(...args));
        }),
        incrBy: vi.fn(async (...args) => {
            commands.push(() => mockRedis.incrBy(...args));
        }),
        expire: vi.fn(async (...args) => {
            commands.push(() => mockRedis.expire(...args));
        }),
        exec: vi.fn(async () => {
            if (hasExecResult && hasLeaderboardWrite) {
                return options.execResult;
            }

            const results = [];
            for (const command of commands) {
                results.push(await command());
            }
            return results;
        }),
    };
}

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateDailyGpReplayDetailed,
}));

describe('server daily gp store submissions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ownedLocks.clear();
        storedStrings.clear();
        mockRedis.get.mockImplementation(async (key) => ownedLocks.get(key) ?? storedStrings.get(key) ?? null);
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (options.nx && (ownedLocks.has(key) || storedStrings.has(key))) return '';
            if (String(key).includes('lock:') || String(key).includes('-lock:')) {
                ownedLocks.set(key, value);
            } else {
                storedStrings.set(key, value);
            }
            return 'OK';
        });
        mockRedis.del.mockImplementation(async (key) => {
            ownedLocks.delete(key);
            storedStrings.delete(key);
        });
        mockRedis.incrBy.mockResolvedValue(1);
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hMGet.mockResolvedValue([]);
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.hScan.mockResolvedValue({ cursor: 0, fieldValues: [] });
        mockRedis.hDel.mockResolvedValue(0);
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 60);
        mockRedis.zAdd.mockResolvedValue(1);
        mockRedis.zCard.mockResolvedValue(1);
        mockRedis.zRange.mockResolvedValue([]);
        mockRedis.zRank.mockResolvedValue(0);
        mockRedis.watch.mockImplementation(() => createMockTransaction());
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 12.345,
                bestTimeMs: 12345,
                completedLaps: 1,
                checkpointTimesSec: [4.2, 9.8],
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 50,
                    origin: [0, 0, 0],
                    deltas: [100, 100, 100],
                },
                method: 'finish',
            },
        });
    });

    it('writes the replay-verified time to Redis instead of the submitted bestTime', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            bestTime: 2,
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                bestTimeMs: 12345,
                trackBestTimeMs: 12345,
                trackPbImproved: true,
                trackGhostAvailable: true,
                trackPbPersistenceStatus: 'stored',
                trackPersonalBest: {
                    trackKey: challenge.trackKey,
                    bestTimeMs: 12345,
                    checkpointTimesSec: [4.2, 9.8],
                    updatedAt: expect.any(String),
                    ghost: {
                        schemaVersion: 2,
                        sampleIntervalMs: 50,
                        finishTimeMs: 50,
                        origin: [0, 0, 0],
                        deltas: [100, 100, 100],
                    },
                },
                completedLaps: 1,
                checkpointTimesSec: [4.2, 9.8],
                validationMethod: 'strict-replay',
                playerRank: 1,
                playerRankLabel: '#1',
                leaderboardEntryCount: 1,
            },
        });
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalledWith({
            challenge: expect.objectContaining({
                trackKey: challenge.trackKey,
                rulesRevision: challenge.rulesRevision,
                objectiveType: challenge.objectiveType,
            }),
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-user', score: 12345 }),
        );
        const leaderboardEntryCall = mockRedis.hSet.mock.calls.find((call) => {
            const rawEntry = call[1]?.['reddit:pm-user'];
            if (!rawEntry) return false;
            return Number.isFinite(JSON.parse(rawEntry).bestTimeMs);
        });
        const leaderboardEntry = JSON.parse(leaderboardEntryCall[1]['reddit:pm-user']);
        expect(leaderboardEntry.trackKey).toBe(challenge.trackKey);
        expect(leaderboardEntry.bestTimeMs).toBe(12345);
        expect(leaderboardEntry.checkpointTimesSec).toEqual([4.2, 9.8]);
        expect(leaderboardEntry.validationMethod).toBe('strict-replay');
        const expectedTtl = getDailyGpCompetitionTtlSeconds(challenge);
        expect(mockRedis.expire).toHaveBeenCalledWith(
            `dailygp:leaderboard:${challenge.id}`,
            expect.closeTo(expectedTtl, -1),
        );
        expect(mockRedis.expire).toHaveBeenCalledWith(
            `dailygp:leaderboard:${challenge.id}:entries`,
            expect.closeTo(expectedTtl, -1),
        );
    });

    it('accepts a committed daily result when challenge PB persistence is unavailable', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.hSet.mockImplementation(async (key) => {
            if (String(key).startsWith('dailygp:challenge-pbs:')) {
                throw new Error('PB storage unavailable');
            }
            return 1;
        });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                improved: true,
                trackPbPersistenceStatus: 'unavailable',
                trackPersonalBest: null,
                trackBestTimeMs: null,
                trackPbImproved: false,
                trackGhostAvailable: false,
            },
        });
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-user', score: 12345 }),
        );
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Challenge PB persistence failed after a valid run:',
            expect.any(Error),
        );
        consoleErrorSpy.mockRestore();
    });

    it('does not let submission lock cleanup errors replace a committed daily outcome', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        let submissionLockReads = 0;
        mockRedis.get.mockImplementation(async (key) => {
            if (String(key).startsWith('dailygp:submit-lock:')) {
                submissionLockReads += 1;
                if (submissionLockReads > 1) throw new Error('cleanup unavailable');
            }
            return ownedLocks.get(key) ?? null;
        });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result).toMatchObject({
            status: 200,
            body: { accepted: true, trackPbPersistenceStatus: 'stored' },
        });
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Competition submission lock cleanup failed:',
            expect.any(Error),
        );
        consoleErrorSpy.mockRestore();
    });

    it('does not mark hasAnyData on a post-replay lock rejection', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (String(key).startsWith('dailygp:submit-lock:')) return '';
            if (options.nx && (ownedLocks.has(key) || storedStrings.has(key))) return '';
            if (String(key).includes('lock:') || String(key).includes('-lock:')) {
                ownedLocks.set(key, value);
            } else {
                storedStrings.set(key, value);
            }
            return 'OK';
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result.status).toBe(429);
        const profileWrite = findWrittenPlayerProfile('reddit:pm-user');
        expect(profileWrite == null || profileWrite.profile.hasAnyData !== true).toBe(true);
    });

    it('strips releaseLock from Daily non-200 replies', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValueOnce({
            ok: false,
            failure: { reason: 'truncated_mismatch' },
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [] },
        });

        expect(result.status).toBe(422);
        expect(result).toEqual({
            status: 422,
            body: expect.objectContaining({ accepted: false }),
        });
        expect(result).not.toHaveProperty('releaseLock');
    });


    it('propagates an unexpected daily persistence failure instead of silently succeeding', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.hSet.mockImplementation(async (key) => {
            if (key === `dailygp:leaderboard:${challenge.id}:entries`) {
                throw new Error('daily entry write unavailable');
            }
            return 1;
        });

        await expect(submitServerDailyGpRun({
            redditUsername: 'Daily-Write-Failure-Player',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        })).rejects.toThrow('daily entry write unavailable');
    });

    it('falls back to a retained personal best when a slower run does not itself win the track PB', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 5,
                bestTimeMs: 5000,
                completedLaps: 1,
                checkpointTimesSec: [2, 4],
                method: 'finish',
            },
        });
        mockRedis.hGet.mockImplementation(async (key, field) => {
            if (key === 'dailygp:challenges') return JSON.stringify(challenge);
            if (key === `dailygp:leaderboard:${challenge.id}:entries` && field === 'reddit:retained-pb-player') {
                return JSON.stringify({
                    playerId: 'reddit:retained-pb-player',
                    trackKey: challenge.trackKey,
                    bestTimeMs: 1000,
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    checkpointTimesSec: [0.4, 0.8],
                    validationMethod: 'strict-replay',
                });
            }
            return null;
        });

        const result = await submitServerDailyGpRun({
            redditUsername: 'Retained-Pb-Player',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result.status).toBe(200);
        expect(result.body.improved).toBe(false);
        expect(result.body.trackBestTimeMs).toBe(1000);
        expect(result.body.trackPbImproved).toBe(false);
        expect(result.body.trackPbPersistenceStatus).toBe('unchanged');
    });

    it('starts PB persistence while the daily transaction is still pending', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        let finishDailyWrite;
        mockRedis.zAdd.mockImplementation(() => new Promise((resolve) => {
            finishDailyWrite = resolve;
        }));

        const pending = submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        await vi.waitFor(() => {
            expect(mockRedis.hSet.mock.calls.some(([key, values]) => (
                key === `dailygp:challenge-pbs:${challenge.id}`
                && Object.keys(values || {}).length === 1
            ))).toBe(true);
            expect(finishDailyWrite).toBeTypeOf('function');
        });
        finishDailyWrite(1);

        await expect(pending).resolves.toMatchObject({
            status: 200,
            body: { accepted: true, trackPbPersistenceStatus: 'stored' },
        });
    });

    it('commits concurrent submissions from different players under separate submission locks', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        vi.clearAllMocks();

        const submit = (redditUsername) => submitServerDailyGpRun({
            playerId: `browser-${redditUsername}`,
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername,
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });
        const results = await Promise.all([submit('Pm-A'), submit('Pm-B')]);

        expect(results).toEqual([
            expect.objectContaining({ status: 200, body: expect.objectContaining({ accepted: true }) }),
            expect.objectContaining({ status: 200, body: expect.objectContaining({ accepted: true }) }),
        ]);
        const watchedSubmissionKeys = mockRedis.watch.mock.calls
            .map(([key]) => key)
            .filter((key) => String(key).startsWith('dailygp:submit-lock:'));
        expect(new Set(watchedSubmissionKeys)).toEqual(new Set([
            `dailygp:submit-lock:${challenge.id}:reddit:pm-a`,
            `dailygp:submit-lock:${challenge.id}:reddit:pm-b`,
        ]));
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-a', score: 12345 }),
        );
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-b', score: 12345 }),
        );
        const writtenLeaderboardPlayerIds = mockRedis.hSet.mock.calls.flatMap(([, entries]) => {
            return entries && typeof entries === 'object' ? Object.keys(entries) : [];
        });
        expect(writtenLeaderboardPlayerIds).toEqual(expect.arrayContaining([
            'reddit:pm-a',
            'reddit:pm-b',
        ]));
    });

    it('rejects a concurrent submission from the same player while its lock is held', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        vi.clearAllMocks();
        let lockAttempts = 0;
        mockRedis.set.mockImplementation(async (key, value) => {
            if (!String(key).startsWith('dailygp:submit-lock:')) {
                return 'OK';
            }
            lockAttempts += 1;
            if (lockAttempts === 1) {
                ownedLocks.set(key, value);
                return 'OK';
            }
            return null;
        });

        const submit = () => submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });
        const results = await Promise.all([submit(), submit()]);

        expect(results.map((result) => result.status).sort()).toEqual([200, 429]);
        expect(results).toContainEqual({
            status: 429,
            body: {
                accepted: false,
                error: 'Submission already in progress. Try again in a moment.',
                retryAfterSeconds: 1,
            },
        });
        expect(mockRedis.zAdd).toHaveBeenCalledTimes(1);
    });

    it('returns 503 without writing when a successor owns the submission lock before WATCH', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        let submissionLockKey = null;
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (String(key).startsWith('dailygp:submit-lock:')) {
                submissionLockKey = key;
                ownedLocks.set(key, value);
            } else if (options.nx && ownedLocks.has(key)) {
                return '';
            } else if (String(key).includes('lock:') || String(key).includes('-lock:')) {
                ownedLocks.set(key, value);
            }
            return 'OK';
        });
        mockRedis.get.mockImplementation(async (key) => (
            key === submissionLockKey ? 'successor-token' : ownedLocks.get(key) ?? null
        ));

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result).toEqual({
            status: 503,
            body: {
                accepted: false,
                error: 'Submission save was interrupted. Retrying automatically.',
            },
        });
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
        expect(mockRedis.hSet.mock.calls.some(([, values]) => values?.['reddit:pm-user'])).toBe(false);
        expect(mockRedis.del).not.toHaveBeenCalledWith(submissionLockKey);
        expect(await mockRedis.get(submissionLockKey)).toBe('successor-token');
    });

    it.each([
        { label: 'an empty result', execResult: [] },
        { label: 'a null result', execResult: null },
        { label: 'a missing result', execResult: undefined },
    ])('returns a retryable failure and releases the lock when EXEC returns $label', async ({ execResult }) => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        vi.clearAllMocks();
        let ownedLock = null;
        mockRedis.set.mockImplementation(async (key, value) => {
            if (String(key).startsWith('dailygp:submit-lock:')) {
                ownedLock = { key, value };
            }
            return 'OK';
        });
        mockRedis.get.mockImplementation(async (key) => {
            return key === ownedLock?.key ? ownedLock.value : null;
        });
        mockRedis.watch.mockImplementation(() => createMockTransaction({ execResult }));

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result).toEqual({
            status: 503,
            body: {
                accepted: false,
                error: 'Submission save was interrupted. Retrying automatically.',
            },
        });
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
        expect(mockRedis.hSet.mock.calls.some(([, entries]) => entries?.['reddit:pm-user'])).toBe(false);
        expect(ownedLock).not.toBe(null);
        expect(mockRedis.del).toHaveBeenCalledWith(ownedLock.key);
    });

    it('backfills published Daily GP history before building the playlist', async () => {
        const { getServerDailyGpPlaylist } = await import('../src/server/daily-gp-store.ts');

        const playlist = await getServerDailyGpPlaylist(new Date('2026-06-11T12:00:00.000Z'));

        expect(playlist.map((challenge) => challenge.trackKey)).toEqual([
            'lanternPier',
            'caspianBoulevard',
            'circuitPromax',
            'desertBridge',
            'turboShell',
            'harborPrincipality',
            'sunlitTemple',
        ]);
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            'dailygp:challenges',
            expect.objectContaining({
                'daily-gp-2026-06-10': expect.stringContaining('"trackKey":"caspianBoulevard"'),
            }),
        );
    });

    it('prunes challenge history in bounded batches and corrects known leaderboard deadlines', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-02-15T12:00:00.000Z'));
        const oldChallenge = {
            id: 'daily-gp-2029-01-01',
            challengeDate: '2029-01-01',
            trackKey: 'circuit',
            startsAt: '2029-01-01T00:00:00.000Z',
            endsAt: '2029-01-02T00:00:00.000Z',
            availableUntil: '2029-01-08T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const currentChallenge = {
            ...oldChallenge,
            id: 'daily-gp-2030-02-15',
            challengeDate: '2030-02-15',
            startsAt: '2030-02-15T00:00:00.000Z',
            endsAt: '2030-02-16T00:00:00.000Z',
            availableUntil: '2030-02-22T00:00:00.000Z',
        };
        mockRedis.hScan.mockResolvedValue({
            cursor: 17,
            fieldValues: [
                { field: oldChallenge.id, value: JSON.stringify(oldChallenge) },
                { field: currentChallenge.id, value: JSON.stringify(currentChallenge) },
            ],
        });

        try {
            const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            await persistServerDailyGpChallenge(currentChallenge);

            expect(mockRedis.hSetNX).toHaveBeenCalledWith(
                'dailygp:challenges',
                currentChallenge.id,
                JSON.stringify(currentChallenge),
            );
            expect(mockRedis.hScan).toHaveBeenCalledWith('dailygp:challenges', 0, undefined, 50);
            expect(mockRedis.hDel).toHaveBeenCalledWith('dailygp:challenges', [oldChallenge.id]);
            expect(mockRedis.expire).toHaveBeenCalledWith(
                `dailygp:leaderboard:${oldChallenge.id}`,
                0,
            );
            expect(mockRedis.expire).toHaveBeenCalledWith(
                `dailygp:leaderboard:${oldChallenge.id}:entries`,
                0,
            );
            expect(mockRedis.expire).toHaveBeenCalledWith(
                `dailygp:leaderboard:${oldChallenge.id}:standings-revision`,
                0,
            );
            expect(mockRedis.expire).toHaveBeenCalledWith(
                `dailygp:leaderboard:${currentChallenge.id}`,
                getDailyGpCompetitionTtlSeconds(currentChallenge),
            );
            expect(mockRedis.expire).toHaveBeenCalledWith(
                `dailygp:leaderboard:${currentChallenge.id}:standings-revision`,
                getDailyGpCompetitionTtlSeconds(currentChallenge),
            );
            expect(mockRedis.set).toHaveBeenCalledWith(
                'dailygp:maintenance:challenge-history:v1:cursor',
                '17',
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns the stored challenge when post-bound persist targets an existing day', async () => {
        const storedChallenge = {
            id: 'daily-gp-2026-07-16',
            challengeDate: '2026-07-16',
            trackKey: 'circuit',
            startsAt: '2026-07-16T00:00:00.000Z',
            endsAt: '2026-07-17T00:00:00.000Z',
            availableUntil: '2026-07-23T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const mismatchedPostChallenge = {
            ...storedChallenge,
            trackKey: 'desertBridge',
        };
        mockRedis.hGet.mockResolvedValue(JSON.stringify(storedChallenge));

        const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        await expect(persistServerDailyGpChallenge(mismatchedPostChallenge)).resolves.toEqual({
            ...storedChallenge,
            rulesRevision: 0,
            objectiveParams: { lapCount: 1 },
        });

        expect(mockRedis.hSetNX).not.toHaveBeenCalled();
        expect(mockRedis.hSet).not.toHaveBeenCalledWith(
            'dailygp:challenges',
            expect.anything(),
        );
    });

    it('seeds a missing day with hSetNX on post-bound persist', async () => {
        const challenge = {
            id: 'daily-gp-2026-07-16',
            challengeDate: '2026-07-16',
            trackKey: 'circuit',
            startsAt: '2026-07-16T00:00:00.000Z',
            endsAt: '2026-07-17T00:00:00.000Z',
            availableUntil: '2026-07-23T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hSetNX.mockResolvedValue(1);

        const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        await expect(persistServerDailyGpChallenge(challenge)).resolves.toEqual(challenge);

        expect(mockRedis.hSetNX).toHaveBeenCalledWith(
            'dailygp:challenges',
            challenge.id,
            JSON.stringify(challenge),
        );
        expect(mockRedis.hSet).not.toHaveBeenCalledWith(
            'dailygp:challenges',
            expect.anything(),
        );
    });

    it('returns the race winner when post-bound persist loses hSetNX', async () => {
        const incomingChallenge = {
            id: 'daily-gp-2026-07-16',
            challengeDate: '2026-07-16',
            trackKey: 'desertBridge',
            startsAt: '2026-07-16T00:00:00.000Z',
            endsAt: '2026-07-17T00:00:00.000Z',
            availableUntil: '2026-07-23T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const winnerChallenge = {
            ...incomingChallenge,
            trackKey: 'circuit',
        };
        mockRedis.hGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(JSON.stringify(winnerChallenge));
        mockRedis.hSetNX.mockResolvedValue(0);

        const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        await expect(persistServerDailyGpChallenge(incomingChallenge)).resolves.toEqual({
            ...winnerChallenge,
            rulesRevision: 0,
            objectiveParams: { lapCount: 1 },
        });

        expect(mockRedis.hSetNX).toHaveBeenCalledWith(
            'dailygp:challenges',
            incomingChallenge.id,
            JSON.stringify(incomingChallenge),
        );
        expect(mockRedis.hSet).not.toHaveBeenCalledWith(
            'dailygp:challenges',
            expect.anything(),
        );
    });

    it('publishes the challenge whose seven-day window just expired at the UTC boundary', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const expiredChallenge = {
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === expiredChallenge.id ? JSON.stringify(expiredChallenge) : null
        ));

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-07-17T00:01:00.000Z'),
        )).resolves.toMatchObject({
            challengeId: expiredChallenge.id,
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
        });
        expect(mockRedis.hGet).toHaveBeenCalledWith('dailygp:challenges', expiredChallenge.id);
    });

    it('selects the prior expired day immediately before the next UTC boundary', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2026-07-09',
            challengeDate: '2026-07-09',
            trackKey: 'circuit',
            startsAt: '2026-07-09T00:00:00.000Z',
            endsAt: '2026-07-10T00:00:00.000Z',
            availableUntil: '2026-07-16T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-07-16T23:59:59.999Z'),
        )).resolves.toMatchObject({ challengeId: challenge.id });
    });

    it('returns no final podium when the historical challenge ledger has no eligible day', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValue(null);

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-07-17T00:01:00.000Z'),
        )).resolves.toBeNull();
    });

    it.each([0, 1, 2, 3])('returns exactly three safe podium positions for %s verified finishers', async (count) => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const members = Array.from({ length: count }, (_, index) => ({
            member: `guest:podium-${index + 1}`,
            score: 12000 + (index * 100),
        }));
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));
        mockRedis.zRange.mockResolvedValue(members);
        mockRedis.hMGet.mockResolvedValue(members.map((member, index) => JSON.stringify({
            playerId: member.member,
            trackKey: challenge.trackKey,
            bestTimeMs: 12000 + (index * 100),
            updatedAt: '2026-07-10T12:00:00.000Z',
        })));
        mockRedis.mGet.mockResolvedValue(members.map((member) => JSON.stringify({
            playerId: member.member,
            leaderboardIdentity: 'reddit',
            redditUsername: null,
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-07-10T12:00:00.000Z',
            lastSeenAt: '2026-07-10T12:00:00.000Z',
            updatedAt: '2026-07-10T12:00:00.000Z',
        })));

        const result = await getServerFinalDailyGpPodium(new Date('2026-07-17T00:01:00.000Z'));

        expect(result.positions).toHaveLength(3);
        expect(result.positions.filter((position) => position.identityType !== 'empty')).toHaveLength(count);
        expect(result.positions.filter((position) => position.identityType === 'empty')).toHaveLength(3 - count);
        if (count > 0) expect(result.positions[0].identityType).toBe('private');
    });

    it('advances the expired podium challenge across month and year boundaries', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2025-12-25',
            challengeDate: '2025-12-25',
            trackKey: 'circuit',
            startsAt: '2025-12-25T00:00:00.000Z',
            endsAt: '2025-12-26T00:00:00.000Z',
            availableUntil: '2026-01-01T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-01-01T00:01:00.000Z'),
        )).resolves.toMatchObject({ challengeId: challenge.id });
        expect(mockRedis.hGet).toHaveBeenCalledWith('dailygp:challenges', challenge.id);
    });

    it('freezes sanitized podium identities and fills missing positions', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const members = [
            { member: 'reddit:racefan', score: 12340 },
            { member: 'guest:private-player', score: 13560 },
        ];
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));
        mockRedis.zRange.mockResolvedValue(members);
        mockRedis.hMGet.mockResolvedValue([
            JSON.stringify({
                playerId: members[0].member,
                trackKey: challenge.trackKey,
                bestTimeMs: 12340,
                updatedAt: '2026-07-10T12:00:00.000Z',
            }),
            JSON.stringify({
                playerId: members[1].member,
                trackKey: challenge.trackKey,
                bestTimeMs: 13560,
                updatedAt: '2026-07-10T13:00:00.000Z',
            }),
        ]);
        mockRedis.mGet.mockResolvedValue([
            JSON.stringify({
                playerId: members[0].member,
                leaderboardIdentity: 'reddit',
                redditUsername: 'RaceFan',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-07-10T12:00:00.000Z',
                lastSeenAt: '2026-07-10T12:00:00.000Z',
                updatedAt: '2026-07-10T12:00:00.000Z',
            }),
            JSON.stringify({
                playerId: members[1].member,
                leaderboardIdentity: 'constructed',
                redditUsername: 'HiddenUser',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-07-10T13:00:00.000Z',
                lastSeenAt: '2026-07-10T13:00:00.000Z',
                updatedAt: '2026-07-10T13:00:00.000Z',
            }),
        ]);

        const podium = await getServerFinalDailyGpPodium(new Date('2026-07-17T00:01:00.000Z'));

        expect(podium.positions).toEqual([
            {
                rank: 1,
                displayName: 'RaceFan',
                identityType: 'reddit',
                formattedTime: '0:12.340',
            },
            expect.objectContaining({
                rank: 2,
                identityType: 'private',
                formattedTime: '0:13.560',
            }),
            {
                rank: 3,
                displayName: 'No verified finish',
                identityType: 'empty',
                formattedTime: null,
            },
        ]);
        expect(podium.positions[1].displayName).not.toContain('HiddenUser');
        expect(JSON.stringify(podium)).not.toContain('private-player');
    });

    it('does not schedule a geometry definition until its key is added to the catalog schedule', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-10T12:00:00.000Z'));
        TRACKS.geometryOnlyTestTrack = TRACKS.circuit;

        try {
            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge.trackKey).toBe(TRACK_SCHEDULE_KEYS[0]);
            expect(challenge.trackKey).not.toBe('geometryOnlyTestTrack');
        } finally {
            delete TRACKS.geometryOnlyTestTrack;
            vi.useRealTimers();
        }
    });

    it('makes a catalog addition the next eligible scheduled track', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-11T12:00:00.000Z'));
        const testTrackKey = 'catalogScheduleTestTrack';
        const priorTrackKey = TRACK_SCHEDULE_KEYS.at(-1);
        TRACK_CATALOG[testTrackKey] = { name: 'Catalog Schedule Test Track' };
        TRACK_SCHEDULE_KEYS.push(testTrackKey);
        mockRedis.hGetAll.mockResolvedValue({
            'daily-gp-2030-01-10': JSON.stringify({
                id: 'daily-gp-2030-01-10',
                challengeDate: '2030-01-10',
                trackKey: priorTrackKey,
                startsAt: '2030-01-10T00:00:00.000Z',
                endsAt: '2030-01-11T00:00:00.000Z',
                availableUntil: '2030-01-17T00:00:00.000Z',
            }),
        });

        try {
            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge.trackKey).toBe(testTrackKey);
        } finally {
            TRACK_SCHEDULE_KEYS.pop();
            delete TRACK_CATALOG[testTrackKey];
            vi.useRealTimers();
        }
    });

    it('keeps an already-published day frozen when the future schedule changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-12T12:00:00.000Z'));
        const storedChallenge = {
            id: 'daily-gp-2030-01-12',
            challengeDate: '2030-01-12',
            trackKey: 'sunlitTemple',
            startsAt: '2030-01-12T00:00:00.000Z',
            endsAt: '2030-01-13T00:00:00.000Z',
            availableUntil: '2030-01-19T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockResolvedValue(JSON.stringify(storedChallenge));
        TRACK_SCHEDULE_KEYS.reverse();

        try {
            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge).toEqual({
                ...storedChallenge,
                rulesRevision: 0,
                objectiveParams: { lapCount: 1 },
            });
        } finally {
            TRACK_SCHEDULE_KEYS.reverse();
            vi.useRealTimers();
        }
    });

    it('filters snapshot rows whose stored track does not match the challenge track', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const mismatchedTrackKey = challenge.trackKey === 'circuit' ? 'sunlitTemple' : 'circuit';

        mockRedis.zCard.mockResolvedValue(1);
        mockRedis.zRange.mockResolvedValue([
            { member: 'guest:browser-player-id', score: 12345 },
        ]);
        mockRedis.hMGet.mockResolvedValue([
            JSON.stringify({
                playerId: 'guest:browser-player-id',
                trackKey: mismatchedTrackKey,
                bestTimeMs: 12345,
                updatedAt: '2026-06-02T12:00:00.000Z',
                checkpointTimesSec: checkpointSplitsForChallenge(challenge, 12.345),
            }),
        ]);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            playerId: 'browser-player-id',
        });

        expect(snapshot.topRows).toEqual([]);
        expect(snapshot.currentPlayerRow).toBe(null);
    });

    it('returns the requested leaderboard rank page with continuation metadata', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const members = [
            { member: 'guest:player-101', score: 20101 },
            { member: 'guest:player-102', score: 20102 },
        ];
        const entries = members.map((member, index) => JSON.stringify({
            playerId: member.member,
            trackKey: challenge.trackKey,
            bestTimeMs: 20101 + index,
            updatedAt: '2026-06-02T12:00:00.000Z',
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 20.101 + (index / 1000)),
        }));

        mockRedis.zCard.mockResolvedValue(180);
        mockRedis.zRange.mockResolvedValue(members);
        mockRedis.hMGet.mockImplementation(async (key) => key.endsWith(':entries') ? entries : []);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            limit: 50,
            offset: 100,
        });

        expect(mockRedis.zRange).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            100,
            149,
        );
        expect(snapshot.topRows.map((row) => row.rank)).toEqual([101, 102]);
        expect(snapshot).toMatchObject({
            pageOffset: 100,
            pageLimit: 50,
            hasMore: true,
            nextOffset: 150,
            totalCount: 180,
            leaderboardEntryCount: 180,
        });
    });

    it('rejects submissions when strict replay validation fails', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: false,
            failure: {
                reason: 'no_finish',
                simulatedTimeSec: 1.2,
                position: { x: 5, y: -10 },
            },
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            bestTime: 2,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: 'no_finish',
                strictReplayFailureReason: 'no_finish',
            },
        });
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    it('rejects relaunch-delay replays that do not finish under strict validation', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: false,
            failure: { reason: 'crashed' },
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: {
                inputs: [
                    { frames: 30, left: false, right: false, relaunchDelay: true },
                    { frames: 120, left: false, right: false, relaunchDelay: false },
                ],
            },
            bestTime: 2,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: 'crashed',
                strictReplayFailureReason: 'crashed',
            },
        });
    });

    it('rejects submitted times when strict replay does not validate the run', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: false,
            failure: { reason: 'no_finish' },
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            bestTime: 8,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 8),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: 'no_finish',
                strictReplayFailureReason: 'no_finish',
            },
        });
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalled();
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    it('rejects submissions when the submitted track does not match the challenge', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: 'not-the-challenge-track',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            bestTime: 2,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission track does not match challenge.',
                reason: 'track_mismatch',
            },
        });
        expect(mockValidateDailyGpReplayDetailed).not.toHaveBeenCalled();
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    it('keeps the last stored identity on bootstrap reads until the player changes it', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
        seedStoredPlayerProfile('reddit:pm-user', {
            playerId: 'reddit:pm-user',
            leaderboardIdentity: 'reddit',
            redditUsername: 'Pm-User',
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        });

        const payload = await getServerPlayerBootstrap({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
        });

        expect(payload.leaderboardIdentity).toBe('reddit');
        const storedProfile = findWrittenPlayerProfile('reddit:pm-user');
        expect(storedProfile.profile.leaderboardIdentity).toBe('reddit');
    });

    it('updates stored identity only when the player explicitly changes it', async () => {
        const { updateServerPlayerIdentity } = await import('../src/server/daily-gp-store.ts');
        mockRedis.get.mockResolvedValueOnce(JSON.stringify({
            playerId: 'reddit:pm-user',
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        }));

        const payload = await updateServerPlayerIdentity({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
            leaderboardIdentity: 'reddit',
        });

        expect(payload).toEqual({
            playerId: 'reddit:pm-user',
            guestToken: null,
            leaderboardIdentity: 'reddit',
        });
        const storedProfile = findWrittenPlayerProfile('reddit:pm-user');
        expect(storedProfile.profile.leaderboardIdentity).toBe('reddit');
    });

    it('retries a profile write from the latest Redis snapshot after a competing preferences save', async () => {
        const { upsertPlayerProfile } = await import('../src/server/competition-identity.ts');
        const playerId = 'reddit:profile-cas';
        seedStoredPlayerProfile(playerId, {
            playerId,
            leaderboardIdentity: 'reddit',
            redditUsername: 'Profile-Cas',
            preferences: { carSkin: 'assets/cars/mr_stock.webp' },
            hasSeenGame: true,
            hasAnyData: false,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });
        const concurrentProfile = {
            playerId,
            leaderboardIdentity: 'reddit',
            redditUsername: 'Profile-Cas',
            preferences: { carSkin: 'assets/cars/mr_extra_crimson.webp' },
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        };
        mockRedis.watch
            .mockImplementationOnce(() => ({
                multi: vi.fn().mockResolvedValue(undefined),
                set: vi.fn().mockResolvedValue(undefined),
                exec: vi.fn(async () => {
                    seedStoredPlayerProfile(playerId, concurrentProfile);
                    return [];
                }),
                discard: vi.fn().mockResolvedValue(undefined),
            }))
            .mockImplementation(() => createMockTransaction());

        const profile = await upsertPlayerProfile({
            playerId,
            redditUsername: 'Profile-Cas',
            hasAnyData: false,
        });

        expect(profile.preferences.carSkin).toBe(concurrentProfile.preferences.carSkin);
        expect(profile.hasAnyData).toBe(true);
    });

    it('retries a profile write when Reddit throws the lost WATCH race instead of an empty exec', async () => {
        const { upsertPlayerProfile } = await import('../src/server/competition-identity.ts');
        const playerId = 'reddit:profile-tx-conflict';
        seedStoredPlayerProfile(playerId, {
            playerId,
            leaderboardIdentity: 'reddit',
            redditUsername: 'Profile-Tx-Conflict',
            preferences: null,
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });
        let watchCount = 0;
        mockRedis.watch.mockImplementation(() => {
            watchCount += 1;
            if (watchCount > 1) return createMockTransaction();
            return {
                multi: vi.fn().mockResolvedValue(undefined),
                set: vi.fn().mockResolvedValue(undefined),
                exec: vi.fn(async () => {
                    throw Object.assign(new Error('2 UNKNOWN: redis: transaction failed'), {
                        code: 2,
                        details: 'redis: transaction failed',
                    });
                }),
                discard: vi.fn().mockResolvedValue(undefined),
            };
        });

        const profile = await upsertPlayerProfile({
            playerId,
            redditUsername: 'Profile-Tx-Conflict',
            hasAnyData: false,
        });

        expect(watchCount).toBe(2);
        expect(profile.hasAnyData).toBe(true);
    });

    it('surfaces a profile write failure that is not a lost race', async () => {
        const { upsertPlayerProfile } = await import('../src/server/competition-identity.ts');
        mockRedis.watch.mockImplementation(() => ({
            multi: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockResolvedValue(undefined),
            exec: vi.fn(async () => {
                throw new Error('2 UNAVAILABLE: no connection established');
            }),
            discard: vi.fn().mockResolvedValue(undefined),
        }));

        await expect(upsertPlayerProfile({
            playerId: 'reddit:profile-tx-broken',
            hasAnyData: false,
        })).rejects.toThrow('no connection established');
    });

    it('leaves an existing player profile alone when a snapshot is read', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const playerId = 'reddit:snapshot-reader';
        seedStoredPlayerProfile(playerId, {
            playerId,
            leaderboardIdentity: 'reddit',
            redditUsername: 'Snapshot-Reader',
            preferences: null,
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });
        mockRedis.set.mockClear();
        mockRedis.watch.mockClear();

        await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            redditUsername: 'Snapshot-Reader',
            limit: 10,
        });

        expect(mockRedis.set.mock.calls.filter(([key]) => isPlayerProfileKey(key))).toEqual([]);
        expect(mockRedis.watch.mock.calls.filter(([key]) => isPlayerProfileKey(key))).toEqual([]);
        expect(JSON.parse(storedStrings.get(playerProfileRedisKey(playerId))).lastSeenAt)
            .toBe('2026-01-01T00:00:00.000Z');
    });

    it('creates a missing player profile once when a snapshot is read', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.set.mockClear();

        await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            redditUsername: 'Snapshot-Newcomer',
            limit: 10,
        });

        const profileWrites = mockRedis.set.mock.calls.filter(([key]) => isPlayerProfileKey(key));
        expect(profileWrites).toHaveLength(1);
        expect(profileWrites[0][2]).toMatchObject({ nx: true });
        expect(JSON.parse(profileWrites[0][1]).playerId).toBe('reddit:snapshot-newcomer');
    });

    it('ignores profiles left in the retired shared hash', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify({
            playerId: 'reddit:pm-user',
            leaderboardIdentity: 'reddit',
            redditUsername: 'Pm-User',
            preferences: {
                carSkin: 'assets/cars/retired.webp',
                trailId: 'gold',
                musicEnabled: false,
                carAudioEnabled: false,
                crashAutoRestartEnabled: false,
                crashRestartDelaySec: 1,
            },
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        }));

        const payload = await getServerPlayerBootstrap({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
        });

        expect(payload).toMatchObject({
            leaderboardIdentity: 'constructed',
            playerPreferences: null,
            hasAnyData: false,
        });
        expect(mockRedis.hGet).not.toHaveBeenCalledWith('dailygp:player-profiles', 'reddit:pm-user');
    });

    it('stores player preferences in Redis and restores them in the next bootstrap', async () => {
        const {
            getServerPlayerBootstrap,
            updateServerPlayerPreferences,
        } = await import('../src/server/daily-gp-store.ts');
        const playerPreferences = {
            carSkin: 'assets/cars/mr_mr_red.webp',
            trailId: 'gold',
            musicEnabled: false,
            carAudioEnabled: true,
            crashAutoRestartEnabled: false,
            crashRestartDelaySec: 0.8,
            pbGhostEnabled: true,
            pausePlacement: 'timer',
            pauseOnTimerEnabled: true,
            hideHudEnabled: false,
        };

        const saved = await updateServerPlayerPreferences({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
            playerPreferences,
        });
        expect(saved).toEqual({
            playerId: 'reddit:pm-user',
            guestToken: null,
            playerPreferences,
        });

        const profileWrite = findWrittenPlayerProfile('reddit:pm-user');
        const storedProfile = profileWrite.profile;
        expect(storedProfile.preferences).toEqual(playerPreferences);

        mockRedis.get.mockResolvedValueOnce(JSON.stringify(storedProfile));
        const bootstrap = await getServerPlayerBootstrap({
            playerId: 'new-browser-player-id-after-update',
            redditUsername: 'Pm-User',
        });
        expect(bootstrap.playerPreferences).toEqual(playerPreferences);
    });

    it('keeps signed-in profiles for as long as the data they name', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');

        await getServerPlayerBootstrap({ redditUsername: 'Player-One' });
        await getServerPlayerBootstrap({ redditUsername: 'Player-Two' });

        const first = findWrittenPlayerProfile('reddit:player-one');
        const second = findWrittenPlayerProfile('reddit:player-two');
        expect(first.key).not.toBe(second.key);
        expect(first.options?.expiration).toBeUndefined();
        expect(second.options?.expiration).toBeUndefined();
        expect(mockRedis.expire).not.toHaveBeenCalledWith('dailygp:player-profiles', expect.anything());
    });

    it('gives guest profiles the one-year Campaign and Daily retention window', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
        const beforeWrite = Date.now();

        await getServerPlayerBootstrap({ playerId: 'new-guest' });

        const guest = findWrittenPlayerProfile('guest:new-guest');
        expect(guest.options.expiration).toBeInstanceOf(Date);
        expect(guest.options.expiration.getTime()).toBeGreaterThan(
            beforeWrite + (364 * 24 * 60 * 60 * 1000),
        );
        expect(guest.options.expiration.getTime()).toBeLessThanOrEqual(
            beforeWrite + (365 * 24 * 60 * 60 * 1000) + 1000,
        );
    });

    describe('stored challenge parsing', () => {
        const unreadableChallengeId = 'daily-gp-2020-01-01';

        it.each([
            ['a bare JSON string instead of an object', '"not-an-object"'],
            ['a JSON array instead of an object', '[]'],
            ['an object missing id and challengeDate', '{}'],
            ['an id that does not match the daily-gp date pattern', JSON.stringify({
                id: 'not-a-daily-gp-id',
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a valid id but an empty challengeDate', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a track key that is not in the catalog', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'not-a-real-track',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['an unparseable startsAt', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: 'not-a-date',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['an unparseable endsAt', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: 'not-a-date',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['an unparseable availableUntil', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: 'not-a-date',
            })],
            ['malformed JSON', '{not-json'],
        ])('treats %s as an unreadable stored challenge', async (_label, raw) => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');
            mockRedis.hGet.mockResolvedValue(raw);

            await expect(getServerDailyGpChallengeById(unreadableChallengeId, { persistFallback: false }))
                .resolves.toBeNull();
        });

        it('parses a fully valid stored challenge back into its original fields', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');
            const stored = {
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            };
            mockRedis.hGet.mockResolvedValue(JSON.stringify(stored));

            const result = await getServerDailyGpChallengeById(stored.id, { persistFallback: false });

            expect(result).toEqual({
                ...stored,
                status: 'active',
                rulesRevision: 0,
                objectiveType: 'single_lap_fastest',
                objectiveParams: { lapCount: 1 },
                skin: 'default',
            });
        });

        it('keeps a leaderboard row that predates per-entry track tagging', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'guest:legacy', score: 5000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'guest:legacy',
                bestTimeMs: 5000,
                updatedAt: '2026-01-01T00:00:00.000Z',
            })]);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot.topRows).toHaveLength(1);
            expect(snapshot.topRows[0].bestTimeMs).toBe(5000);
        });
    });

    describe('challenge history maintenance', () => {
        it('does not let challenge history maintenance failures block publishing a new challenge', async () => {
            const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2026-08-01',
                challengeDate: '2026-08-01',
                trackKey: 'circuit',
                startsAt: '2026-08-01T00:00:00.000Z',
                endsAt: '2026-08-02T00:00:00.000Z',
                availableUntil: '2026-08-08T00:00:00.000Z',
                status: 'active',
                rulesRevision: 0,
                objectiveType: 'single_lap_fastest',
                objectiveParams: { lapCount: 1 },
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(1);
            mockRedis.hScan.mockRejectedValue(new Error('hScan unavailable'));
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(persistServerDailyGpChallenge(challenge)).resolves.toEqual(challenge);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                'Daily GP challenge history maintenance failed:',
                expect.any(Error),
            );
            consoleErrorSpy.mockRestore();
        });

        it('resumes maintenance from a previously stored non-zero cursor', async () => {
            const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2026-08-02',
                challengeDate: '2026-08-02',
                trackKey: 'circuit',
                startsAt: '2026-08-02T00:00:00.000Z',
                endsAt: '2026-08-03T00:00:00.000Z',
                availableUntil: '2026-08-09T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(1);
            mockRedis.get.mockImplementation(async (key) => {
                if (key === 'dailygp:maintenance:challenge-history:v1:cursor') return '5';
                return ownedLocks.get(key) ?? null;
            });

            await persistServerDailyGpChallenge(challenge);

            expect(mockRedis.hScan).toHaveBeenCalledWith('dailygp:challenges', 5, undefined, 50);
        });

        it('treats a negative or non-numeric stored cursor as the start of the ledger', async () => {
            const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2026-08-03',
                challengeDate: '2026-08-03',
                trackKey: 'circuit',
                startsAt: '2026-08-03T00:00:00.000Z',
                endsAt: '2026-08-04T00:00:00.000Z',
                availableUntil: '2026-08-10T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(1);
            mockRedis.get.mockImplementation(async (key) => {
                if (key === 'dailygp:maintenance:challenge-history:v1:cursor') return '-7';
                return ownedLocks.get(key) ?? null;
            });

            await persistServerDailyGpChallenge(challenge);

            expect(mockRedis.hScan).toHaveBeenCalledWith('dailygp:challenges', 0, undefined, 50);
        });
    });

    describe('snapshot numeric normalization', () => {
        it.each([
            [undefined, 10],
            ['not-a-number', 10],
            [Number.NaN, 10],
            [0, 1],
            [-5, 1],
            [0.9, 1],
            [1, 1],
            [50.7, 50],
            [100, 100],
            [150, 100],
        ])('normalizes limit %j into pageLimit %j', async (input, expectedLimit) => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(5);
            mockRedis.zRange.mockResolvedValue([]);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                limit: input,
            });

            expect(snapshot.pageLimit).toBe(expectedLimit);
        });

        it.each([
            [undefined, 0],
            ['not-a-number', 0],
            [Number.NaN, 0],
            [-5, 0],
            [0, 0],
            [2.9, 2],
            [10, 10],
        ])('normalizes offset %j into pageOffset %j', async (input, expectedOffset) => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(5);
            mockRedis.zRange.mockResolvedValue([]);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                offset: input,
            });

            expect(snapshot.pageOffset).toBe(expectedOffset);
        });
    });

    describe('stored leaderboard entry parsing', () => {
        it.each([
            ['a raw value that is not valid JSON', 'not-json'],
            ['a JSON array instead of an object', '[]'],
            ['a numeric playerId', JSON.stringify({ playerId: 42, bestTimeMs: 1000, updatedAt: '2026-01-01T00:00:00.000Z' })],
            ['an empty playerId', JSON.stringify({ playerId: '', bestTimeMs: 1000, updatedAt: '2026-01-01T00:00:00.000Z' })],
            ['a non-finite bestTimeMs', JSON.stringify({ playerId: 'guest:x', bestTimeMs: 'fast', updatedAt: '2026-01-01T00:00:00.000Z' })],
            ['a missing updatedAt', JSON.stringify({ playerId: 'guest:x', bestTimeMs: 1000 })],
            ['an empty updatedAt', JSON.stringify({ playerId: 'guest:x', bestTimeMs: 1000, updatedAt: '' })],
        ])('drops a leaderboard row stored with %s', async (_label, raw) => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'guest:x', score: 1000 }]);
            mockRedis.hMGet.mockResolvedValue([raw]);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot.topRows).toEqual([]);
        });

        it('converts a stored bestTimeMs into seconds and preserves checkpoint splits on the row', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'guest:seconds-check', score: 12345 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'guest:seconds-check',
                trackKey: challenge.trackKey,
                bestTimeMs: 12345,
                updatedAt: '2026-01-01T00:00:00.000Z',
                checkpointTimesSec: checkpointSplitsForChallenge(challenge, 12.345),
            })]);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot.topRows[0].bestTime).toBeCloseTo(12.345, 5);
            expect(snapshot.topRows[0].checkpointTimesSec).not.toBeNull();
        });

        it('defaults checkpointTimesSec to null when the stored entry has no checkpoint splits', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'guest:no-checkpoints', score: 9000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'guest:no-checkpoints',
                trackKey: challenge.trackKey,
                bestTimeMs: 9000,
                updatedAt: '2026-01-01T00:00:00.000Z',
            })]);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot.topRows[0].checkpointTimesSec).toBeNull();
        });
    });

    describe('player preference normalization', () => {
        function basePreferences(overrides = {}) {
            return {
                carSkin: 'car.png',
                trailId: 'gold',
                musicEnabled: true,
                carAudioEnabled: true,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 0.5,
                ...overrides,
            };
        }

        it.each([
            ['a missing carSkin', { carSkin: undefined }],
            ['a whitespace-only carSkin', { carSkin: '   ' }],
            ['a carSkin over 160 characters', { carSkin: 'x'.repeat(161) }],
            ['a missing trailId', { trailId: undefined }],
            ['a whitespace-only trailId', { trailId: '   ' }],
            ['a trailId over 32 characters', { trailId: 'x'.repeat(33) }],
            ['a non-boolean musicEnabled', { musicEnabled: 'yes' }],
            ['a non-boolean carAudioEnabled', { carAudioEnabled: 1 }],
            ['a non-boolean crashAutoRestartEnabled', { crashAutoRestartEnabled: 'no' }],
            ['a non-boolean pbGhostEnabled', { pbGhostEnabled: 'sure' }],
            ['a non-boolean pauseOnTimerEnabled', { pauseOnTimerEnabled: 'sure' }],
            ['an invalid pausePlacement', { pausePlacement: 'dash' }],
            ['a non-boolean hideHudEnabled', { hideHudEnabled: 'sure' }],
            ['a non-finite crashRestartDelaySec', { crashRestartDelaySec: 'slow' }],
            ['a negative crashRestartDelaySec', { crashRestartDelaySec: -0.1 }],
            ['a crashRestartDelaySec above 1', { crashRestartDelaySec: 1.1 }],
        ])('rejects preferences with %s', async (_label, overrides) => {
            const { updateServerPlayerPreferences } = await import('../src/server/daily-gp-store.ts');

            const result = await updateServerPlayerPreferences({
                playerId: 'browser-prefs-reject',
                redditUsername: 'Pref-Tester',
                playerPreferences: basePreferences(overrides),
            });

            expect(result.playerPreferences).toBeNull();
            expect(result.playerId).toBe('reddit:pref-tester');
        });

        it.each([
            ['a carSkin exactly at the 160 character limit', { carSkin: 'x'.repeat(160) }, { carSkin: 'x'.repeat(160) }],
            ['a trailId exactly at the 32 character limit', { trailId: 'x'.repeat(32) }, { trailId: 'x'.repeat(32) }],
            ['a crashRestartDelaySec of exactly 0', { crashRestartDelaySec: 0 }, { crashRestartDelaySec: 0 }],
            ['a crashRestartDelaySec of exactly 1', { crashRestartDelaySec: 1 }, { crashRestartDelaySec: 1 }],
            ['an omitted pbGhostEnabled', { pbGhostEnabled: undefined }, { pbGhostEnabled: true }],
            ['an explicit pbGhostEnabled of false', { pbGhostEnabled: false }, { pbGhostEnabled: false }],
            ['an omitted pauseOnTimerEnabled', { pauseOnTimerEnabled: undefined }, { pausePlacement: 'timer', pauseOnTimerEnabled: true }],
            ['an explicit pauseOnTimerEnabled of false', { pauseOnTimerEnabled: false }, { pausePlacement: 'separate', pauseOnTimerEnabled: false }],
            ['an explicit pausePlacement of speedo', { pausePlacement: 'speedo' }, { pausePlacement: 'speedo', pauseOnTimerEnabled: false }],
            ['an omitted hideHudEnabled', { hideHudEnabled: undefined }, { hideHudEnabled: false }],
            ['an explicit hideHudEnabled of true', { hideHudEnabled: true }, { hideHudEnabled: true }],
        ])('accepts preferences with %s', async (_label, overrides, expected) => {
            const { updateServerPlayerPreferences } = await import('../src/server/daily-gp-store.ts');

            const result = await updateServerPlayerPreferences({
                playerId: 'browser-prefs-accept',
                redditUsername: 'Pref-Accept',
                playerPreferences: basePreferences(overrides),
            });

            expect(result.playerPreferences).toMatchObject({
                ...expected,
                carSkin: 'assets/cars/mr_mr_red.webp',
            });
        });

        it('trims whitespace from carSkin and trailId before storing preferences', async () => {
            const { updateServerPlayerPreferences } = await import('../src/server/daily-gp-store.ts');

            const result = await updateServerPlayerPreferences({
                playerId: 'browser-prefs-trim',
                redditUsername: 'Pref-Trim',
                playerPreferences: basePreferences({ carSkin: '  car.png  ', trailId: ' gold ' }),
            });

            expect(result.playerPreferences).toMatchObject({
                carSkin: 'assets/cars/mr_mr_red.webp',
                trailId: 'gold',
            });
        });

        it('rounds crashRestartDelaySec to one decimal place', async () => {
            const { updateServerPlayerPreferences } = await import('../src/server/daily-gp-store.ts');

            const result = await updateServerPlayerPreferences({
                playerId: 'browser-prefs-round',
                redditUsername: 'Pref-Round',
                playerPreferences: basePreferences({ crashRestartDelaySec: 0.37 }),
            });

            expect(result.playerPreferences.crashRestartDelaySec).toBe(0.4);
        });
    });

    describe('returning player detection', () => {
        it('does not treat a brand-new player as returning', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Brand-New-Player' });

            expect(payload.isReturningPlayer).toBe(false);
        });

        it('treats a player whose first session was more than a day ago as returning', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
            try {
                const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
                seedStoredPlayerProfile('reddit:returning-player', {
                    playerId: 'reddit:returning-player',
                    leaderboardIdentity: 'reddit',
                    redditUsername: 'Returning-Player',
                    hasSeenGame: true,
                    hasAnyData: true,
                    firstSeenAt: '2026-07-08T00:00:00.000Z',
                    lastSeenAt: '2026-07-08T00:00:00.000Z',
                    updatedAt: '2026-07-08T00:00:00.000Z',
                });

                const payload = await getServerPlayerBootstrap({ redditUsername: 'Returning-Player' });

                expect(payload.isReturningPlayer).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not treat a player exactly at the returning-player threshold as returning', async () => {
            vi.useFakeTimers();
            const firstSeenAt = new Date('2026-07-10T00:00:00.000Z');
            vi.setSystemTime(new Date(firstSeenAt.getTime() + (24 * 60 * 60 * 1000)));
            try {
                const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
                mockRedis.get.mockResolvedValueOnce(JSON.stringify({
                    playerId: 'reddit:threshold-player',
                    leaderboardIdentity: 'reddit',
                    redditUsername: 'Threshold-Player',
                    hasSeenGame: true,
                    hasAnyData: true,
                    firstSeenAt: firstSeenAt.toISOString(),
                    lastSeenAt: firstSeenAt.toISOString(),
                    updatedAt: firstSeenAt.toISOString(),
                }));

                const payload = await getServerPlayerBootstrap({ redditUsername: 'Threshold-Player' });

                expect(payload.isReturningPlayer).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not treat an unparsable firstSeenAt as a returning player', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            mockRedis.get.mockResolvedValueOnce(JSON.stringify({
                playerId: 'reddit:bad-date-player',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Bad-Date-Player',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: 'not-a-real-date',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }));

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Bad-Date-Player' });

            expect(payload.isReturningPlayer).toBe(false);
        });
    });

    describe('hasAnyData reporting', () => {
        it('reports hasAnyData for any existing profile even without prior activity', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            mockRedis.get.mockResolvedValueOnce(JSON.stringify({
                playerId: 'reddit:no-activity-yet',
                leaderboardIdentity: 'constructed',
                redditUsername: null,
                hasSeenGame: true,
                hasAnyData: false,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }));

            const payload = await getServerPlayerBootstrap({ redditUsername: 'No-Activity-Yet' });

            expect(payload.hasAnyData).toBe(true);
        });

        it('reports no data for a brand-new player profile', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Truly-New-Player' });

            expect(payload.hasAnyData).toBe(false);
        });
    });

    describe('profile field fallbacks across writes', () => {
        it('falls back to the epoch timestamp for a missing firstSeenAt field', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:date-fallback', {
                playerId: 'reddit:date-fallback',
            });

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Date-Fallback' });

            expect(payload.firstSeenAt).toBe(new Date(0).toISOString());
        });

        it('falls back to the epoch timestamp for an empty-string firstSeenAt field', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:empty-date-fallback', {
                playerId: 'reddit:empty-date-fallback',
                firstSeenAt: '',
            });

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Empty-Date-Fallback' });

            expect(payload.firstSeenAt).toBe(new Date(0).toISOString());
        });

        it('keeps hasAnyData true once set even when a later write does not explicitly set it', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:has-any-data-player', {
                playerId: 'reddit:has-any-data-player',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Has-Any-Data-Player',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            await getServerPlayerBootstrap({ redditUsername: 'Has-Any-Data-Player' });

            const storedProfile = findWrittenPlayerProfile('reddit:has-any-data-player');
            expect(storedProfile.profile.hasAnyData).toBe(true);
        });

        it('backfills Crimson for a player with an accepted race predating unlock tracking', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:existing-racer', {
                playerId: 'reddit:existing-racer',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Existing-Racer',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Existing-Racer' });
            const playerHash = createHash('sha256')
                .update('reddit:existing-racer', 'utf8')
                .digest('base64url');

            expect(mockRedis.hSetNX).toHaveBeenCalledWith(
                `miniracer:car-unlocks:v1:${playerHash}`,
                'race:completed',
                '1',
            );
            expect(payload.carUnlocks.progress.completedRace).toBe(1);
            expect(payload.carUnlocks.unlockedAssets)
                .toContain('assets/cars/mr_extra_crimson.webp');
        });

        it('preserves the original firstSeenAt across profile updates', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:preserve-first-seen', {
                playerId: 'reddit:preserve-first-seen',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Preserve-First-Seen',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2020-01-01T00:00:00.000Z',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            await getServerPlayerBootstrap({ redditUsername: 'Preserve-First-Seen' });

            const storedProfile = findWrittenPlayerProfile('reddit:preserve-first-seen');
            expect(storedProfile.profile.firstSeenAt).toBe('2020-01-01T00:00:00.000Z');
        });

        it('falls back to constructed leaderboard identity when the previous profile also had none stored', async () => {
            const { updateServerPlayerIdentity } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:identity-fallback', {
                playerId: 'reddit:identity-fallback',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Identity-Fallback',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            const payload = await updateServerPlayerIdentity({
                redditUsername: 'Identity-Fallback',
                leaderboardIdentity: 'not-a-real-identity-value',
            });

            expect(payload.leaderboardIdentity).toBe('reddit');
        });
    });

    describe('getServerDailyGpPlayerBest', () => {
        it('returns null when no reddit username is provided', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            await expect(getServerDailyGpPlayerBest({ challengeId: challenge.id, redditUsername: null }))
                .resolves.toBeNull();
        });

        it('returns null when the reddit username sanitizes to empty', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            await expect(getServerDailyGpPlayerBest({ challengeId: challenge.id, redditUsername: 'u/' }))
                .resolves.toBeNull();
        });

        it('returns null when the requested challenge is not playable', async () => {
            const { getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.ts');

            await expect(getServerDailyGpPlayerBest({
                challengeId: 'daily-gp-1999-01-01',
                redditUsername: 'Some-Player',
            })).resolves.toBeNull();
        });

        it('returns null when the player has not posted a time on the challenge', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.hGet.mockImplementation(async (key) => (
                key === 'dailygp:challenges' ? JSON.stringify(challenge) : null
            ));

            await expect(getServerDailyGpPlayerBest({
                challengeId: challenge.id,
                redditUsername: 'No-Entry-Player',
            })).resolves.toBeNull();
        });

        it('returns the stored best time for the requested reddit player', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (key === 'dailygp:challenges') return JSON.stringify(challenge);
                if (key === `dailygp:leaderboard:${challenge.id}:entries` && field === 'reddit:best-player') {
                    return JSON.stringify({
                        playerId: 'reddit:best-player',
                        trackKey: challenge.trackKey,
                        bestTimeMs: 8765,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    });
                }
                return null;
            });

            const result = await getServerDailyGpPlayerBest({
                challengeId: challenge.id,
                redditUsername: 'Best-Player',
            });

            expect(result).toEqual({ challenge, bestTimeMs: 8765 });
        });
    });

    describe('getServerDailyGpChallengeById', () => {
        it.each([undefined, null, 42, ''])('returns null for a challengeId of %j', async (challengeId) => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

            await expect(getServerDailyGpChallengeById(challengeId)).resolves.toBeNull();
        });

        it('returns null for an unknown past challenge without persisting a fallback', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

            await expect(getServerDailyGpChallengeById('daily-gp-1999-06-15')).resolves.toBeNull();

            expect(mockRedis.hSetNX).not.toHaveBeenCalled();
        });

        it('does not persist today\'s challenge when persistFallback is false', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerDailyGpChallengeById(getTodayChallengeIdForTest(), { persistFallback: false });

            expect(result).not.toBeNull();
            expect(mockRedis.hSetNX).not.toHaveBeenCalled();
        });

        it('persists today\'s challenge by default when it has not been published yet', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerDailyGpChallengeById(getTodayChallengeIdForTest());

            expect(result).not.toBeNull();
            expect(mockRedis.hSetNX).toHaveBeenCalledWith(
                'dailygp:challenges',
                getTodayChallengeIdForTest(),
                expect.any(String),
            );
        });
    });

    describe('getServerDailyGpPlayableChallenge', () => {
        it('returns null for a stored past-day challenge that is no longer playable', async () => {
            const { getServerDailyGpPlayableChallenge } = await import('../src/server/daily-gp-store.ts');
            const expiredChallenge = {
                id: 'daily-gp-2020-01-01',
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(JSON.stringify(expiredChallenge));

            await expect(getServerDailyGpPlayableChallenge(expiredChallenge.id)).resolves.toBeNull();
        });

        it('falls back to resolving and publishing today\'s challenge when today is requested but unpublished', async () => {
            const { getServerDailyGpPlayableChallenge } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerDailyGpPlayableChallenge(getTodayChallengeIdForTest());

            expect(result).not.toBeNull();
            expect(result.id).toBe(getTodayChallengeIdForTest());
        });
    });

    describe('getServerFinalDailyGpPodium boundary', () => {
        it('publishes the podium at the exact moment the availability window ends', async () => {
            const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2026-07-10',
                challengeDate: '2026-07-10',
                trackKey: 'circuit',
                startsAt: '2026-07-10T00:00:00.000Z',
                endsAt: '2026-07-11T00:00:00.000Z',
                availableUntil: '2026-07-17T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockImplementation(async (_key, field) => (
                field === challenge.id ? JSON.stringify(challenge) : null
            ));

            await expect(getServerFinalDailyGpPodium(
                new Date(challenge.availableUntil),
            )).resolves.toMatchObject({ challengeId: challenge.id });
        });
    });

    describe('getServerPlayerTrackPbSummaries', () => {
        it('returns an empty summary map for an unauthorized identity', async () => {
            const { getServerPlayerTrackPbSummaries } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerPlayerTrackPbSummaries({ challengeIds: ['daily-gp-2020-01-01'] });

            expect(result).toEqual({ playerId: null, trackPbs: {} });
        });

        it('treats a non-array challengeIds value as an empty request', async () => {
            const { getServerPlayerTrackPbSummaries } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerPlayerTrackPbSummaries({
                redditUsername: 'Summary-Player',
                challengeIds: 'daily-gp-2020-01-01',
            });

            expect(result.playerId).toBe('reddit:summary-player');
            expect(result.trackPbs).toEqual({});
        });

        it('deduplicates requested challenge ids and caps them at the playlist length', async () => {
            const { getServerPlayerTrackPbSummaries } = await import('../src/server/daily-gp-store.ts');
            const manyIds = Array.from({ length: DAILY_GP_PLAYLIST_DAYS + 5 }, (_, index) => `daily-gp-9999-01-${String(index + 1).padStart(2, '0')}`);
            const duplicatedIds = [manyIds[0], manyIds[0], ...manyIds];

            const result = await getServerPlayerTrackPbSummaries({
                redditUsername: 'Cap-Player',
                challengeIds: duplicatedIds,
            });

            expect(Object.keys(result.trackPbs)).toHaveLength(DAILY_GP_PLAYLIST_DAYS);
        });

        it('reports null for a requested challenge that is not on the current playlist', async () => {
            const { getServerPlayerTrackPbSummaries } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerPlayerTrackPbSummaries({
                redditUsername: 'Off-Playlist-Player',
                challengeIds: ['daily-gp-1999-01-01'],
            });

            expect(result.trackPbs['daily-gp-1999-01-01']).toBeNull();
        });
    });

    describe('getServerPlayerPbGhost', () => {
        it('returns an all-null payload for an unauthorized identity', async () => {
            const { getServerPlayerPbGhost } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerPlayerPbGhost({});

            expect(result).toEqual({
                playerId: null,
                challengeId: null,
                trackKey: null,
                personalBest: null,
            });
        });

        it('returns a null challenge and track when the requested challenge is not playable', async () => {
            const { getServerPlayerPbGhost } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerPlayerPbGhost({
                redditUsername: 'Ghost-No-Challenge',
                challengeId: 'daily-gp-1999-01-01',
            });

            expect(result).toEqual({
                playerId: 'reddit:ghost-no-challenge',
                challengeId: null,
                trackKey: null,
                personalBest: null,
            });
        });

        it('returns a null personal best when the player has no retained result on the resolved challenge', async () => {
            const { getServerDailyGpChallenge, getServerPlayerPbGhost } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            const result = await getServerPlayerPbGhost({
                redditUsername: 'Ghost-No-Pb',
                challengeId: challenge.id,
            });

            expect(result).toMatchObject({
                playerId: 'reddit:ghost-no-pb',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                personalBest: null,
            });
        });
    });

    describe('submitServerDailyGpRun boundary behavior', () => {
        it('does not mark a submission as improved when the new time ties the stored time', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (key === 'dailygp:challenges') return JSON.stringify(challenge);
                if (key === `dailygp:leaderboard:${challenge.id}:entries` && field === 'reddit:tie-player') {
                    return JSON.stringify({
                        playerId: 'reddit:tie-player',
                        trackKey: challenge.trackKey,
                        bestTimeMs: 12345,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        validationMethod: 'strict-replay',
                    });
                }
                return null;
            });

            const result = await submitServerDailyGpRun({
                redditUsername: 'Tie-Player',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result.status).toBe(200);
            expect(result.body.improved).toBe(false);
            expect(result.body.bestTimeMs).toBe(12345);
            expect(mockRedis.zAdd).not.toHaveBeenCalled();
        });

        it('defaults the stored validation method and failure reason when a legacy entry blocks improvement', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (key === 'dailygp:challenges') return JSON.stringify(challenge);
                if (key === `dailygp:leaderboard:${challenge.id}:entries` && field === 'reddit:legacy-player') {
                    return JSON.stringify({
                        playerId: 'reddit:legacy-player',
                        trackKey: challenge.trackKey,
                        bestTimeMs: 100,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    });
                }
                return null;
            });

            const result = await submitServerDailyGpRun({
                redditUsername: 'Legacy-Player',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result.status).toBe(200);
            expect(result.body.improved).toBe(false);
            expect(result.body.validationMethod).toBe('strict-replay');
            expect(result.body.strictReplayFailureReason).toBeNull();
        });

        it('falls back to the default rate-limit window when expireTime reports the key already expired', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.incrBy.mockResolvedValue(13);
            mockRedis.expireTime.mockResolvedValue(0);

            const result = await submitServerDailyGpRun({
                redditUsername: 'Rate-Limited-Expired-Player',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result.status).toBe(429);
            expect(result.body.retryAfterSeconds).toBe(60);
        });

        it('clamps the retry-after estimate to at least one second when the TTL is about to expire', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.incrBy.mockResolvedValue(13);
            mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000));

            const result = await submitServerDailyGpRun({
                redditUsername: 'Rate-Limited-Now-Player',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result.status).toBe(429);
            expect(result.body.retryAfterSeconds).toBe(1);
        });

        it('rejects submissions when no player identity is available', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            const result = await submitServerDailyGpRun({
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result).toEqual({
                status: 400,
                body: {
                    accepted: false,
                    error: 'Invalid Mini Racer submission.',
                },
            });
        });

        it('rejects submissions for a challenge that is no longer playable', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const activeChallenge = await getServerDailyGpChallenge();
            const expiredChallenge = {
                id: 'daily-gp-2020-03-01',
                challengeDate: '2020-03-01',
                trackKey: 'circuit',
                startsAt: '2020-03-01T00:00:00.000Z',
                endsAt: '2020-03-02T00:00:00.000Z',
                availableUntil: '2020-03-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (key === 'dailygp:challenges' && field === expiredChallenge.id) {
                    return JSON.stringify(expiredChallenge);
                }
                return null;
            });

            const result = await submitServerDailyGpRun({
                redditUsername: 'Expired-Challenge-Player',
                challengeId: expiredChallenge.id,
                trackKey: expiredChallenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result.status).toBe(409);
            expect(result.body).toMatchObject({
                accepted: false,
                error: 'Daily challenge is no longer playable.',
                challengeId: activeChallenge.id,
            });
        });
    });

    describe('snapshot player-rank windowing', () => {
        function mockRankedLeaderboard(challenge, members) {
            const entryPayloads = members.map((member, index) => JSON.stringify({
                playerId: member.member,
                trackKey: challenge.trackKey,
                bestTimeMs: member.score,
                updatedAt: '2026-06-02T12:00:00.000Z',
            }));

            mockRedis.zCard.mockResolvedValue(members.length);
            mockRedis.zRange.mockImplementation(async (_key, start, stop) => members.slice(start, stop + 1));
            mockRedis.hMGet.mockImplementation(async (_key, fields) => (
                fields.map((field) => entryPayloads[members.findIndex((member) => member.member === field)] ?? null)
            ));
            mockRedis.hGet.mockImplementation(async (key, field) => {
                const index = members.findIndex((member) => member.member === field);
                if (index >= 0 && key.endsWith(':entries')) {
                    return entryPayloads[index];
                }
                return null;
            });
        }

        it('returns an empty snapshot when the leaderboard is zero', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(0);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot).toMatchObject({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 0,
                leaderboardEntryCount: 0,
                playerRank: null,
                playerRankLabel: null,
                hasMore: false,
                nextOffset: null,
                objectiveType: challenge.objectiveType,
            });
        });

        it('returns the active challenge objective when a requested challenge is not playable', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const activeChallenge = await getServerDailyGpChallenge();
            const expiredChallenge = {
                id: 'daily-gp-2020-04-01',
                challengeDate: '2020-04-01',
                trackKey: 'circuit',
                startsAt: '2020-04-01T00:00:00.000Z',
                endsAt: '2020-04-02T00:00:00.000Z',
                availableUntil: '2020-04-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (key === 'dailygp:challenges' && field === expiredChallenge.id) {
                    return JSON.stringify(expiredChallenge);
                }
                return null;
            });

            const snapshot = await getServerDailyGpSnapshot({ challengeId: expiredChallenge.id });

            expect(snapshot.topRows).toEqual([]);
            expect(snapshot.objectiveType).toBe(activeChallenge.objectiveType);
        });

        it('short-circuits with an in-page current player row when the player is on the requested page', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const members = Array.from({ length: 12 }, (_, index) => ({
                member: `reddit:rank-${index + 1}`,
                score: 10000 + index,
            }));
            mockRankedLeaderboard(challenge, members);
            mockRedis.zRank.mockResolvedValue(2);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Rank-3',
                offset: 0,
                limit: 10,
            });

            expect(snapshot.currentPlayerRow).toMatchObject({
                rank: 3,
                isCurrentPlayer: true,
                bestTimeMs: 10002,
            });
            expect(snapshot.nearbyRows).toEqual([]);
            expect(snapshot.playerRank).toBe(3);
            expect(snapshot.hasMore).toBe(true);
            expect(snapshot.nextOffset).toBe(10);
        });

        it('loads nearby rows when the current player ranks above the requested page', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const members = Array.from({ length: 20 }, (_, index) => ({
                member: `reddit:rank-${index + 1}`,
                score: 20000 + index,
            }));
            mockRankedLeaderboard(challenge, members);
            mockRedis.zRank.mockResolvedValue(4);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Rank-5',
                offset: 10,
                limit: 10,
            });

            expect(snapshot.topRows.map((row) => row.rank)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
            expect(snapshot.currentPlayerRow).toMatchObject({
                rank: 5,
                isCurrentPlayer: true,
                bestTimeMs: 20004,
            });
            expect(snapshot.nearbyRows.map((row) => row.rank)).toEqual([3, 4, 5, 6, 7]);
            expect(mockRedis.zRange).toHaveBeenCalledWith(
                expect.stringContaining(challenge.id),
                2,
                6,
            );
        });

        it('loads nearby rows when the current player ranks below the requested page', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const members = Array.from({ length: 20 }, (_, index) => ({
                member: `reddit:rank-${index + 1}`,
                score: 30000 + index,
            }));
            mockRankedLeaderboard(challenge, members);
            mockRedis.zRank.mockResolvedValue(14);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Rank-15',
                offset: 0,
                limit: 10,
            });

            expect(snapshot.topRows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
            expect(snapshot.currentPlayerRow).toMatchObject({
                rank: 15,
                isCurrentPlayer: true,
            });
            expect(snapshot.nearbyRows.map((row) => row.rank)).toEqual([13, 14, 15, 16, 17]);
            expect(mockRedis.zRange).toHaveBeenCalledWith(
                expect.stringContaining(challenge.id),
                12,
                16,
            );
        });

        it('clears continuation metadata on the final page', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const members = Array.from({ length: 25 }, (_, index) => ({
                member: `reddit:rank-${index + 1}`,
                score: 40000 + index,
            }));
            mockRankedLeaderboard(challenge, members);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                offset: 20,
                limit: 10,
            });

            expect(snapshot.topRows.map((row) => row.rank)).toEqual([21, 22, 23, 24, 25]);
            expect(snapshot.hasMore).toBe(false);
            expect(snapshot.nextOffset).toBeNull();
        });

        it('does not build a current player row when the player is absent from the timed leaderboard', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRankedLeaderboard(challenge, [
                { member: 'reddit:leader', score: 12000 },
            ]);
            mockRedis.zRank.mockResolvedValue(undefined);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Unranked-Player',
            });

            expect(snapshot.playerRank).toBeNull();
            expect(snapshot.currentPlayerRow).toBeNull();
            expect(snapshot.nearbyRows).toEqual([]);
        });
    });

    describe('stored challenge parsing type coercion', () => {
        const unreadableChallengeId = 'daily-gp-2020-01-01';

        it.each([
            ['a numeric id field', JSON.stringify({
                id: 42,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a numeric challengeDate field', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: 20200101,
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a numeric trackKey field', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 7,
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a missing startsAt field', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a numeric startsAt field', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: 0,
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a numeric endsAt field', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: 1,
                availableUntil: '2020-01-08T00:00:00.000Z',
            })],
            ['a numeric availableUntil field', JSON.stringify({
                id: unreadableChallengeId,
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: 7,
            })],
        ])('treats %s as unreadable', async (_label, raw) => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');
            mockRedis.hGet.mockResolvedValue(raw);

            await expect(getServerDailyGpChallengeById(unreadableChallengeId, { persistFallback: false }))
                .resolves.toBeNull();
        });
    });

    describe('profile timestamp fallbacks', () => {
        it('preserves the parsed epoch firstSeenAt when stored timestamps are empty strings', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:timestamp-fallback', {
                playerId: 'reddit:timestamp-fallback',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Timestamp-Fallback',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '',
                updatedAt: '',
            });

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Timestamp-Fallback' });

            expect(payload.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
            expect(payload.lastSeenAt).toEqual(expect.any(String));
        });

        it('falls back to the epoch timestamp for non-string firstSeenAt fields', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            seedStoredPlayerProfile('reddit:non-string-timestamps', {
                playerId: 'reddit:non-string-timestamps',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Non-String-Timestamps',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: 123,
                lastSeenAt: null,
                updatedAt: false,
            });

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Non-String-Timestamps' });

            expect(payload.firstSeenAt).toBe(new Date(0).toISOString());
        });

        it('still resolves display names from profiles with empty lastSeenAt timestamps', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const profile = JSON.stringify({
                playerId: 'reddit:profile-parse',
                leaderboardIdentity: 'reddit',
                redditUsername: 'Profile-Parse',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '',
                updatedAt: '',
            });
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'reddit:profile-parse', score: 9000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'reddit:profile-parse',
                trackKey: challenge.trackKey,
                bestTimeMs: 9000,
                updatedAt: '2026-01-01T00:00:00.000Z',
            })]);
            mockRedis.mGet.mockResolvedValue([profile]);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot.topRows[0].displayName).toBe('Profile-Parse');
        });
    });

    describe('challenge history maintenance edge cases', () => {
        it('skips history deletion when the scanned page has no expired challenges', async () => {
            const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2030-03-01',
                challengeDate: '2030-03-01',
                trackKey: 'circuit',
                startsAt: '2030-03-01T00:00:00.000Z',
                endsAt: '2030-03-02T00:00:00.000Z',
                availableUntil: '2030-03-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(1);
            mockRedis.hScan.mockResolvedValue({
                cursor: 0,
                fieldValues: [
                    { field: challenge.id, value: JSON.stringify(challenge) },
                    { field: 'daily-gp-corrupt', value: '{not-json' },
                ],
            });

            await persistServerDailyGpChallenge(challenge);

            expect(mockRedis.hDel).not.toHaveBeenCalled();
            expect(mockRedis.expire).toHaveBeenCalledWith(
                `dailygp:leaderboard:${challenge.id}`,
                getDailyGpCompetitionTtlSeconds(challenge),
            );
            expect(mockRedis.expire).toHaveBeenCalledWith(
                `dailygp:leaderboard:${challenge.id}:standings-revision`,
                getDailyGpCompetitionTtlSeconds(challenge),
            );
        });

        it('treats a null challenge history hash as empty when picking the next track', async () => {
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hGetAll.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(1);

            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge.trackKey).toBe(TRACK_SCHEDULE_KEYS[0]);
        });
    });

    describe('updateServerPlayerIdentity authorization', () => {
        it('returns the default identity when no authorized player is present', async () => {
            const { updateServerPlayerIdentity } = await import('../src/server/daily-gp-store.ts');

            const payload = await updateServerPlayerIdentity({
                playerId: 'browser-unauthorized',
            });

            expect(payload).toEqual({
                playerId: null,
                guestToken: null,
                leaderboardIdentity: 'constructed',
            });
        });
    });

    describe('getServerDailyGpPlaylist filtering', () => {
        it('omits challenges that are no longer playable from the returned playlist', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2030-03-10T12:00:00.000Z'));
            const expiredChallenge = {
                id: 'daily-gp-2030-02-20',
                challengeDate: '2030-02-20',
                trackKey: 'circuit',
                startsAt: '2030-02-20T00:00:00.000Z',
                endsAt: '2030-02-21T00:00:00.000Z',
                availableUntil: '2030-02-27T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockImplementation(async (_key, field) => (
                field === expiredChallenge.id ? JSON.stringify(expiredChallenge) : null
            ));

            try {
                const { getServerDailyGpPlaylist } = await import('../src/server/daily-gp-store.ts');
                const playlist = await getServerDailyGpPlaylist();

                expect(playlist.some((challenge) => challenge.id === expiredChallenge.id)).toBe(false);
                expect(playlist.length).toBeGreaterThan(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('challenge ledger rotation and maintenance', () => {
        it('deletes expired challenge history entries during maintenance', async () => {
            const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const expiredChallenge = {
                id: 'daily-gp-2020-01-01',
                challengeDate: '2020-01-01',
                trackKey: 'circuit',
                startsAt: '2020-01-01T00:00:00.000Z',
                endsAt: '2020-01-02T00:00:00.000Z',
                availableUntil: '2020-01-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            const freshChallenge = {
                id: 'daily-gp-2030-06-01',
                challengeDate: '2030-06-01',
                trackKey: 'circuit',
                startsAt: '2030-06-01T00:00:00.000Z',
                endsAt: '2030-06-02T00:00:00.000Z',
                availableUntil: '2030-06-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(1);
            mockRedis.hScan.mockResolvedValue({
                cursor: 0,
                fieldValues: [{ field: expiredChallenge.id, value: JSON.stringify(expiredChallenge) }],
            });

            await persistServerDailyGpChallenge(freshChallenge);

            expect(mockRedis.hDel).toHaveBeenCalledWith('dailygp:challenges', [expiredChallenge.id]);
        });

        it('falls back to the first scheduled track when the ledger playhead left the rotation', async () => {
            const { TRACK_SCHEDULE_KEYS } = await import('../game/track/catalog.js');
            const scheduleSnapshot = [...TRACK_SCHEDULE_KEYS];
            TRACK_SCHEDULE_KEYS.splice(0, TRACK_SCHEDULE_KEYS.length, 'desertBridge');
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2030-06-02T12:00:00.000Z'));
            const priorChallenge = {
                id: 'daily-gp-2030-06-01',
                challengeDate: '2030-06-01',
                trackKey: 'circuit',
                startsAt: '2030-06-01T00:00:00.000Z',
                endsAt: '2030-06-02T00:00:00.000Z',
                availableUntil: '2030-06-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hGetAll.mockResolvedValue({
                [priorChallenge.id]: JSON.stringify(priorChallenge),
            });
            mockRedis.hSetNX.mockResolvedValue(1);

            try {
                const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
                const challenge = await getServerDailyGpChallenge();

                expect(challenge.trackKey).toBe('desertBridge');
            } finally {
                TRACK_SCHEDULE_KEYS.splice(0, TRACK_SCHEDULE_KEYS.length, ...scheduleSnapshot);
                vi.useRealTimers();
            }
        });

        it('returns the built today challenge when publication loses the hSetNX race and reread is empty', async () => {
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(0);

            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge.id).toBe(getTodayChallengeIdForTest());
            expect(challenge.trackKey).toBeTruthy();
        });

        it('returns a stored today challenge without writing when persistFallback is false', async () => {
            const stored = {
                id: getTodayChallengeIdForTest(),
                challengeDate: getTodayChallengeIdForTest().replace('daily-gp-', ''),
                trackKey: 'desertBridge',
                startsAt: new Date(getUtcDayIndex(new Date()) * DAY_MS).toISOString(),
                endsAt: new Date((getUtcDayIndex(new Date()) + 1) * DAY_MS).toISOString(),
                availableUntil: new Date((getUtcDayIndex(new Date()) + 7) * DAY_MS).toISOString(),
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(JSON.stringify(stored));

            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');
            const result = await getServerDailyGpChallengeById(stored.id, { persistFallback: false });

            expect(result).toEqual({
                ...stored,
                status: 'active',
                rulesRevision: 0,
                objectiveType: 'single_lap_fastest',
                objectiveParams: { lapCount: 1 },
                skin: 'default',
            });
            expect(mockRedis.hSetNX).not.toHaveBeenCalled();
        });
    });

    describe('player bootstrap edge cases', () => {
        it('returns an empty bootstrap when guest claim input is invalid', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');

            const payload = await getServerPlayerBootstrap({ playerId: '   ' });

            expect(payload).toEqual({
                playerId: null,
                guestToken: null,
                redditUsername: null,
                leaderboardIdentity: 'constructed',
                playerPreferences: null,
                carUnlocks: null,
                retireGuestIdentity: false,
                hasAnyData: false,
                isReturningPlayer: false,
                firstSeenAt: null,
                lastSeenAt: null,
            });
        });

        it('treats malformed stored player profiles as absent during bootstrap', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            mockRedis.get.mockResolvedValueOnce('{not-json');

            const payload = await getServerPlayerBootstrap({ redditUsername: 'Malformed-Profile' });

            expect(payload.playerId).toBe('reddit:malformed-profile');
            expect(payload.playerPreferences).toBeNull();
            expect(payload.hasAnyData).toBe(false);
        });

        it('returns null bootstrap when guest token minting fails', async () => {
            const playerToken = await import('../src/server/player-token.ts');
            const mintSpy = vi.spyOn(playerToken, 'mintGuestPlayerToken').mockResolvedValueOnce(null);

            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            const payload = await getServerPlayerBootstrap({ playerId: 'guest-mint-failure' });

            expect(payload).toEqual({
                playerId: null,
                guestToken: null,
                redditUsername: null,
                leaderboardIdentity: 'constructed',
                playerPreferences: null,
                carUnlocks: null,
                retireGuestIdentity: false,
                hasAnyData: false,
                isReturningPlayer: false,
                firstSeenAt: null,
                lastSeenAt: null,
            });
            mintSpy.mockRestore();
        });
    });

    describe('mutation coverage — submission and snapshot guards', () => {
        it('falls back to the default track when the schedule pool is empty', async () => {
            const scheduleSnapshot = [...TRACK_SCHEDULE_KEYS];
            TRACK_SCHEDULE_KEYS.splice(0, TRACK_SCHEDULE_KEYS.length);
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hGetAll.mockResolvedValue({});
            mockRedis.hSetNX.mockResolvedValue(1);

            try {
                const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
                const challenge = await getServerDailyGpChallenge();

                expect(challenge.trackKey).toBe('circuit');
            } finally {
                TRACK_SCHEDULE_KEYS.splice(0, 0, ...scheduleSnapshot);
            }
        });

        it('rejects submissions when the challenge track geometry is unavailable', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const originalTrack = TRACKS[challenge.trackKey];
            delete TRACKS[challenge.trackKey];

            try {
                const result = await submitServerDailyGpRun({
                    playerId: 'browser-track-missing',
                    challengeId: challenge.id,
                    trackKey: challenge.trackKey,
                    leaderboardIdentity: 'constructed',
                    redditUsername: 'Track-Missing-User',
                    bestTime: 12,
                    replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
                    checkpointTimesSec: checkpointSplitsForChallenge(challenge, 12),
                });

                expect(result).toMatchObject({
                    status: 500,
                    body: {
                        accepted: false,
                        error: 'Daily challenge track is unavailable.',
                    },
                });
            } finally {
                TRACKS[challenge.trackKey] = originalTrack;
            }
        });

        it('ignores prior ledger entries with unparseable startsAt when rotating tracks', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2030-06-03T12:00:00.000Z'));
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hGetAll.mockResolvedValue({
                'daily-gp-2030-06-01': JSON.stringify({
                    id: 'daily-gp-2030-06-01',
                    challengeDate: '2030-06-01',
                    trackKey: 'circuit',
                    startsAt: 'not-a-date',
                    endsAt: '2030-06-02T00:00:00.000Z',
                    availableUntil: '2030-06-08T00:00:00.000Z',
                }),
            });
            mockRedis.hSetNX.mockResolvedValue(1);

            try {
                const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
                const challenge = await getServerDailyGpChallenge();

                expect(challenge.trackKey).toBe(TRACK_SCHEDULE_KEYS[0]);
            } finally {
                vi.useRealTimers();
            }
        });

        it('returns an empty page when the requested offset is beyond the leaderboard size', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(2);
            mockRedis.zRange.mockResolvedValue([]);
            mockRedis.zRank.mockResolvedValue(undefined);
            mockRedis.hMGet.mockResolvedValue([]);
            mockRedis.mGet.mockResolvedValue([]);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                offset: 50,
            });

            expect(snapshot.topRows).toEqual([]);
            expect(snapshot.hasMore).toBe(false);
        });
    });

    describe('mutation coverage — identity and podium guards', () => {
        it('rejects bootstrap when the guest token does not match the supplied player id', async () => {
            const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
            const guestToken = await mintGuestPlayerToken('guest-a');

            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            const payload = await getServerPlayerBootstrap({
                playerId: 'guest-b',
                guestToken,
            });

            expect(payload).toEqual({
                playerId: null,
                guestToken: null,
                redditUsername: null,
                leaderboardIdentity: 'constructed',
                playerPreferences: null,
                carUnlocks: null,
                retireGuestIdentity: false,
                hasAnyData: false,
                isReturningPlayer: false,
                firstSeenAt: null,
                lastSeenAt: null,
            });
        });

        it('pauses bootstrap for an explicit guest progress choice', async () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const defaultGet = mockRedis.get.getMockImplementation();
            mockRedis.get.mockImplementation(async (key) => (
                key === 'dailygp:guest-player-token-secret'
                    ? 'merge-race-secret'
                    : defaultGet(key)
            ));
            const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
            const guestToken = await mintGuestPlayerToken('merge-race-guest');

            const defaultSet = mockRedis.set.getMockImplementation();
            mockRedis.set.mockImplementation(async (key, value, options = {}) => {
                if (options.nx && String(key).includes('campaign:submit-lock')) return '';
                return defaultSet(key, value, options);
            });

            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
            const payload = await getServerPlayerBootstrap({
                playerId: 'merge-race-guest',
                guestToken,
                redditUsername: 'MergeRacer',
            });

            expect(payload.playerId).toBe('reddit:mergeracer');
            expect(payload.guestToken).toBe(guestToken);
            expect(payload.progressSelection?.required ?? false).toBe(false);
            expect(consoleError).not.toHaveBeenCalled();
            consoleError.mockRestore();
        });

        it('rejects bootstrap when a supplied guest token cannot be verified', async () => {
            const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');

            const payload = await getServerPlayerBootstrap({
                playerId: 'guest-invalid-token',
                guestToken: 'not-a-real-token',
            });

            expect(payload.playerId).toBeNull();
            expect(payload.guestToken).toBeNull();
        });

        it('preserves a stored constructed identity when update receives an invalid preference', async () => {
            const { updateServerPlayerIdentity } = await import('../src/server/daily-gp-store.ts');
            mockRedis.get.mockResolvedValueOnce(JSON.stringify({
                playerId: 'reddit:identity-fallback',
                leaderboardIdentity: 'constructed',
                redditUsername: 'Identity-Fallback',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }));

            const payload = await updateServerPlayerIdentity({
                redditUsername: 'Identity-Fallback',
                leaderboardIdentity: 'invalid',
            });

            expect(payload.leaderboardIdentity).toBe('constructed');
        });

        it('formats podium times with minutes when the verified lap exceeds one minute', async () => {
            const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2026-07-10',
                challengeDate: '2026-07-10',
                trackKey: 'circuit',
                startsAt: '2026-07-10T00:00:00.000Z',
                endsAt: '2026-07-11T00:00:00.000Z',
                availableUntil: '2026-07-17T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockImplementation(async (_key, field) => (
                field === challenge.id ? JSON.stringify(challenge) : null
            ));
            mockRedis.zRange.mockResolvedValue([{ member: 'reddit:slow-podium', score: 90000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'reddit:slow-podium',
                trackKey: 'circuit',
                bestTimeMs: 90000,
                updatedAt: '2026-07-10T12:00:00.000Z',
            })]);
            mockRedis.mGet.mockResolvedValue([]);

            const podium = await getServerFinalDailyGpPodium(new Date('2026-07-17T00:01:00.000Z'));

            expect(podium.positions[0].formattedTime).toBe('1:30.000');
        });

        it('fills empty podium slots when the stored entry player id does not match the ranked member', async () => {
            const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2026-07-10',
                challengeDate: '2026-07-10',
                trackKey: 'circuit',
                startsAt: '2026-07-10T00:00:00.000Z',
                endsAt: '2026-07-11T00:00:00.000Z',
                availableUntil: '2026-07-17T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockImplementation(async (_key, field) => (
                field === challenge.id ? JSON.stringify(challenge) : null
            ));
            mockRedis.zRange.mockResolvedValue([{ member: 'reddit:ranked-member', score: 12000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'reddit:other-player',
                trackKey: 'circuit',
                bestTimeMs: 12000,
                updatedAt: '2026-07-10T12:00:00.000Z',
            })]);
            mockRedis.mGet.mockResolvedValue([]);

            const podium = await getServerFinalDailyGpPodium(new Date('2026-07-17T00:01:00.000Z'));

            expect(podium.positions[0]).toMatchObject({
                rank: 1,
                identityType: 'empty',
                displayName: 'No verified finish',
                formattedTime: null,
            });
        });

        it('ignores non-string challenge history hash values when rotating tracks', async () => {
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hGetAll.mockResolvedValue({
                'daily-gp-2030-06-01': 42,
            });
            mockRedis.hSetNX.mockResolvedValue(1);
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2030-06-02T12:00:00.000Z'));

            try {
                const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
                const nextChallenge = await getServerDailyGpChallenge();

                expect(nextChallenge.trackKey).toBe(TRACK_SCHEDULE_KEYS[0]);
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not improve the leaderboard when the new submission is slower than the stored time', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockValidateDailyGpReplayDetailed.mockReturnValue({
                ok: true,
                run: {
                    bestTimeSec: 15,
                    bestTimeMs: 15000,
                    completedLaps: 1,
                    checkpointTimesSec: checkpointSplitsForChallenge(challenge, 15),
                    ghost: null,
                },
            });
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (key === 'dailygp:challenges') return JSON.stringify(challenge);
                if (key === `dailygp:leaderboard:${challenge.id}:entries` && field === 'reddit:slower-player') {
                    return JSON.stringify({
                        playerId: 'reddit:slower-player',
                        trackKey: challenge.trackKey,
                        bestTimeMs: 12000,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        validationMethod: 'strict-replay',
                    });
                }
                return null;
            });

            const result = await submitServerDailyGpRun({
                redditUsername: 'Slower-Player',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result.status).toBe(200);
            expect(result.body.improved).toBe(false);
            expect(result.body.bestTimeMs).toBe(12000);
            expect(mockRedis.zAdd).not.toHaveBeenCalled();
        });

        it('rejects stored challenges whose id or challengeDate fail ledger validation', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');
            mockRedis.hGet.mockImplementation(async (_key, field) => {
                if (field === 'daily-gp-bad-id') {
                    return JSON.stringify({
                        id: 'not-a-daily-gp-id',
                        challengeDate: '2026-07-10',
                        trackKey: 'circuit',
                        startsAt: '2026-07-10T00:00:00.000Z',
                        endsAt: '2026-07-11T00:00:00.000Z',
                        availableUntil: '2026-07-17T00:00:00.000Z',
                    });
                }
                if (field === 'daily-gp-2026-07-11') {
                    return JSON.stringify({
                        id: 'daily-gp-2026-07-11',
                        challengeDate: '',
                        trackKey: 'circuit',
                        startsAt: '2026-07-11T00:00:00.000Z',
                        endsAt: '2026-07-12T00:00:00.000Z',
                        availableUntil: '2026-07-18T00:00:00.000Z',
                    });
                }
                return null;
            });

            expect(await getServerDailyGpChallengeById('daily-gp-bad-id')).toBeNull();
            expect(await getServerDailyGpChallengeById('daily-gp-2026-07-11')).toBeNull();
        });

        it('ignores ledger entries that start today when choosing the next track', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2030-06-02T12:00:00.000Z'));
            const todayChallenge = {
                id: 'daily-gp-2030-06-02',
                challengeDate: '2030-06-02',
                trackKey: TRACK_SCHEDULE_KEYS[1] || TRACK_SCHEDULE_KEYS[0],
                startsAt: '2030-06-02T00:00:00.000Z',
                endsAt: '2030-06-03T00:00:00.000Z',
                availableUntil: '2030-06-09T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            const priorChallenge = {
                id: 'daily-gp-2030-06-01',
                challengeDate: '2030-06-01',
                trackKey: TRACK_SCHEDULE_KEYS[0],
                startsAt: '2030-06-01T00:00:00.000Z',
                endsAt: '2030-06-02T00:00:00.000Z',
                availableUntil: '2030-06-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hGetAll.mockResolvedValue({
                [todayChallenge.id]: JSON.stringify(todayChallenge),
                [priorChallenge.id]: JSON.stringify(priorChallenge),
            });
            mockRedis.hSetNX.mockResolvedValue(1);

            try {
                const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
                const challenge = await getServerDailyGpChallenge();
                const priorIndex = TRACK_SCHEDULE_KEYS.indexOf(priorChallenge.trackKey);
                const expected = TRACK_SCHEDULE_KEYS[(priorIndex + 1) % TRACK_SCHEDULE_KEYS.length];

                expect(challenge.trackKey).toBe(expected);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('mutation-survivor precision', () => {
        it('stores strictReplayFailureReason only when it is a string', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'reddit:reason-player', score: 9000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'reddit:reason-player',
                trackKey: challenge.trackKey,
                bestTimeMs: 9000,
                updatedAt: '2026-01-01T00:00:00.000Z',
                validationMethod: 'strict-replay',
                strictReplayFailureReason: 42,
            })]);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Reason-Player',
            });

            expect(snapshot.topRows).toHaveLength(1);
            expect(snapshot.topRows[0].bestTimeMs).toBe(9000);
        });

        it('returns null playerRankLabel when the signed-in player has no leaderboard row', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(2);
            mockRedis.zRange.mockResolvedValue([
                { member: 'reddit:leader', score: 5000 },
                { member: 'reddit:second', score: 6000 },
            ]);
            mockRedis.hMGet.mockResolvedValue([
                JSON.stringify({
                    playerId: 'reddit:leader',
                    trackKey: challenge.trackKey,
                    bestTimeMs: 5000,
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }),
                JSON.stringify({
                    playerId: 'reddit:second',
                    trackKey: challenge.trackKey,
                    bestTimeMs: 6000,
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }),
            ]);
            mockRedis.zRank.mockResolvedValue(undefined);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Unranked-Player',
            });

            expect(snapshot.playerRank).toBeNull();
            expect(snapshot.playerRankLabel).toBeNull();
            expect(snapshot.currentPlayerRow).toBeNull();
        });

        it('returns an empty row page when the requested rank range is inverted', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(3);
            mockRedis.zRange.mockResolvedValue([]);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                offset: 5,
                limit: 2,
            });

            expect(snapshot.topRows).toEqual([]);
            expect(snapshot.pageOffset).toBe(5);
            expect(snapshot.pageLimit).toBe(2);
        });

        it('rejects leaderboard entries whose stored track disagrees with the challenge track', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'reddit:mismatch', score: 7000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'reddit:mismatch',
                trackKey: 'desertBridge',
                bestTimeMs: 7000,
                updatedAt: '2026-01-01T00:00:00.000Z',
            })]);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot.topRows).toEqual([]);
        });

        it('returns null for getServerDailyGpChallengeById when challengeId is empty', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

            await expect(getServerDailyGpChallengeById('')).resolves.toBeNull();
            await expect(getServerDailyGpChallengeById(null)).resolves.toBeNull();
        });

        it('advances the maintenance cursor even when every scanned entry is corrupt', async () => {
            const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = {
                id: 'daily-gp-2030-07-01',
                challengeDate: '2030-07-01',
                trackKey: 'circuit',
                startsAt: '2030-07-01T00:00:00.000Z',
                endsAt: '2030-07-02T00:00:00.000Z',
                availableUntil: '2030-07-08T00:00:00.000Z',
                status: 'active',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hSetNX.mockResolvedValue(1);
            mockRedis.hScan.mockResolvedValue({
                cursor: 12,
                fieldValues: [
                    { field: 'daily-gp-corrupt-a', value: '{bad-json' },
                    { field: 'daily-gp-corrupt-b', value: '"string"' },
                ],
            });

            await persistServerDailyGpChallenge(challenge);

            expect(mockRedis.set).toHaveBeenCalledWith(
                'dailygp:maintenance:challenge-history:v1:cursor',
                '12',
            );
            expect(mockRedis.hDel).not.toHaveBeenCalled();
        });

        it('keeps nearby rows when the player rank sits inside the page but not in topRows', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const members = Array.from({ length: 8 }, (_, index) => ({
                member: `reddit:nearby-${index + 1}`,
                score: 10000 + index,
            }));
            mockRedis.zCard.mockResolvedValue(8);
            mockRedis.zRange.mockImplementation(async (_key, start, stop) => members.slice(start, stop + 1));
            mockRedis.hMGet.mockImplementation(async (_key, ids) => ids.map((playerId) => JSON.stringify({
                playerId,
                trackKey: challenge.trackKey,
                bestTimeMs: 10000 + Number(playerId.split('-').pop()) - 1,
                updatedAt: '2026-01-01T00:00:00.000Z',
            })));
            mockRedis.zRank.mockResolvedValue(6);
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (field === 'reddit:nearby-7') {
                    return JSON.stringify({
                        playerId: 'reddit:nearby-7',
                        trackKey: challenge.trackKey,
                        bestTimeMs: 10006,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    });
                }
                return null;
            });
            mockRedis.get.mockResolvedValue(null);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Nearby-7',
                offset: 0,
                limit: 5,
            });

            expect(snapshot.currentPlayerRow).toMatchObject({
                rank: 7,
                isCurrentPlayer: true,
                bestTimeMs: 10006,
            });
            expect(snapshot.nearbyRows.map((row) => row.rank)).toEqual([5, 6, 7, 8]);
        });

        it('ignores stored player profiles that do not include a non-empty playerId', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(1);
            mockRedis.zRange.mockResolvedValue([{ member: 'reddit:bad-profile', score: 8000 }]);
            mockRedis.hMGet.mockResolvedValue([JSON.stringify({
                playerId: 'reddit:bad-profile',
                trackKey: challenge.trackKey,
                bestTimeMs: 8000,
                updatedAt: '2026-01-01T00:00:00.000Z',
            })]);
            mockRedis.mGet.mockResolvedValue([JSON.stringify({
                leaderboardIdentity: 'constructed',
                hasSeenGame: false,
                hasAnyData: true,
                firstSeenAt: '2026-01-01T00:00:00.000Z',
                lastSeenAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            })]);

            const snapshot = await getServerDailyGpSnapshot({ challengeId: challenge.id });

            expect(snapshot.topRows).toHaveLength(1);
            expect(snapshot.topRows[0].displayName).toBeTruthy();
        });

    it('sets the rate-limit TTL only on the first submission attempt', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.incrBy
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(2);
            mockRedis.expire.mockClear();

            const first = await submitServerDailyGpRun({
                redditUsername: 'Rate-Limit-Once',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });
            const second = await submitServerDailyGpRun({
                redditUsername: 'Rate-Limit-Once',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            const rateLimitExpires = mockRedis.expire.mock.calls.filter(([key]) => (
                String(key).startsWith('dailygp:submit-rate-limit:')
            ));
            expect(rateLimitExpires).toHaveLength(1);
        });

        it('rejects stored challenge JSON that parses to a non-object', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');
            mockRedis.hGet.mockResolvedValueOnce(JSON.stringify(['not-a-challenge']));

            await expect(getServerDailyGpChallengeById('daily-gp-2026-07-11')).resolves.toBeNull();
        });
    });

    it('marks and prepares only an exact compatible Daily opponent ghost without exposing identity', async () => {
        const {
            getServerDailyGpChallenge,
            getServerDailyGpSnapshot,
            prepareServerDailyLeaderboardRace,
        } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const playerId = 'reddit:opponent';
        const updatedAt = '2026-07-27T10:00:00.000Z';
        const bestTimeMs = 100;
        const checkpointCount = TRACKS[challenge.trackKey].checkpoints.length
            * challenge.objectiveParams.lapCount;
        const checkpointTimesSec = Array.from(
            { length: checkpointCount },
            (_, index) => ((index + 1) * 0.1) / (checkpointCount + 1),
        );
        const entry = {
            playerId,
            trackKey: challenge.trackKey,
            bestTimeMs,
            updatedAt,
            completedLaps: challenge.objectiveParams.lapCount,
            checkpointTimesSec,
            validationMethod: 'strict-replay',
        };
        const pb = {
            schemaVersion: 2,
            trackKey: challenge.trackKey,
            trackFingerprint: createTrackFingerprint(TRACKS[challenge.trackKey]),
            simulationRevision: 1,
            rulesRevision: challenge.rulesRevision,
            lapCount: challenge.objectiveParams.lapCount,
            bestTimeMs,
            checkpointTimesSec,
            ghost: {
                schemaVersion: 2,
                sampleIntervalMs: 50,
                finishTimeMs: bestTimeMs,
                origin: [0, 0, 0],
                deltas: [0, 0, 0, 0, 0, 0],
            },
            updatedAt,
        };
        const pbField = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        mockRedis.zCard.mockResolvedValue(1);
        mockRedis.zRange.mockResolvedValue([{ member: playerId, score: bestTimeMs }]);
        mockRedis.zRank.mockResolvedValue(undefined);
        // The snapshot reads a page's entries and personal bests in bulk. Answer bulk reads from
        // the same rows as single reads, so the two fakes cannot disagree about what is stored.
        mockRedis.hMGet.mockImplementation(async (key, fields) => (
            Promise.all(fields.map((field) => mockRedis.hGet(key, field)))
        ));
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.hGet.mockImplementation(async (key, field) => {
            if (key === 'dailygp:challenges' && field === challenge.id) {
                return JSON.stringify(challenge);
            }
            if (String(key).endsWith(':entries') && field === playerId) {
                return JSON.stringify(entry);
            }
            if (key === `dailygp:challenge-pbs:${challenge.id}` && field === pbField) {
                return JSON.stringify(pb);
            }
            return null;
        });

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            redditUsername: 'RaceFan',
        });
        expect(snapshot.topRows).toHaveLength(1);
        expect(snapshot.topRows[0]).toMatchObject({
            rank: 1,
            opponentRaceAvailable: true,
        });

        const prepared = await prepareServerDailyLeaderboardRace({
            challengeId: challenge.id,
            redditUsername: 'RaceFan',
            selection: {
                kind: 'row',
                rank: 1,
                displayName: snapshot.topRows[0].displayName,
                bestTimeMs,
                updatedAt,
            },
        });
        expect(prepared).toMatchObject({
            status: 200,
            body: {
                mode: 'daily',
                race: { id: challenge.id, trackKey: challenge.trackKey },
                target: {
                    rank: 1,
                    displayName: snapshot.topRows[0].displayName,
                    bestTimeMs,
                    checkpointTimesSec,
                    updatedAt,
                    ghost: { finishTimeMs: bestTimeMs },
                },
            },
        });
        expect(JSON.stringify(prepared)).not.toContain(playerId);
    });

    it('races a Daily ghost stored before the PB record shared the entry timestamp', async () => {
        const {
            getServerDailyGpChallenge,
            getServerDailyGpSnapshot,
            prepareServerDailyLeaderboardRace,
        } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const playerId = 'reddit:opponent';
        const updatedAt = '2026-07-27T10:00:00.000Z';
        const bestTimeMs = 100;
        const checkpointCount = TRACKS[challenge.trackKey].checkpoints.length
            * challenge.objectiveParams.lapCount;
        const checkpointTimesSec = Array.from(
            { length: checkpointCount },
            (_, index) => ((index + 1) * 0.1) / (checkpointCount + 1),
        );
        const entry = {
            playerId,
            trackKey: challenge.trackKey,
            bestTimeMs,
            updatedAt,
            completedLaps: challenge.objectiveParams.lapCount,
            checkpointTimesSec,
            validationMethod: 'strict-replay',
        };
        const pb = {
            schemaVersion: 2,
            trackKey: challenge.trackKey,
            trackFingerprint: createTrackFingerprint(TRACKS[challenge.trackKey]),
            simulationRevision: 1,
            rulesRevision: challenge.rulesRevision,
            lapCount: challenge.objectiveParams.lapCount,
            bestTimeMs,
            checkpointTimesSec,
            ghost: {
                schemaVersion: 2,
                sampleIntervalMs: 50,
                finishTimeMs: bestTimeMs,
                origin: [0, 0, 0],
                deltas: [0, 0, 0, 0, 0, 0],
            },
            updatedAt: '2026-07-27T09:59:59.812Z',
        };
        const pbField = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        mockRedis.zCard.mockResolvedValue(1);
        mockRedis.zRange.mockResolvedValue([{ member: playerId, score: bestTimeMs }]);
        mockRedis.zRank.mockResolvedValue(undefined);
        // The snapshot reads a page's entries and personal bests in bulk. Answer bulk reads from
        // the same rows as single reads, so the two fakes cannot disagree about what is stored.
        mockRedis.hMGet.mockImplementation(async (key, fields) => (
            Promise.all(fields.map((field) => mockRedis.hGet(key, field)))
        ));
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.hGet.mockImplementation(async (key, field) => {
            if (key === 'dailygp:challenges' && field === challenge.id) {
                return JSON.stringify(challenge);
            }
            if (String(key).endsWith(':entries') && field === playerId) {
                return JSON.stringify(entry);
            }
            if (key === `dailygp:challenge-pbs:${challenge.id}` && field === pbField) {
                return JSON.stringify(pb);
            }
            return null;
        });

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            redditUsername: 'RaceFan',
        });
        expect(snapshot.topRows[0]).toMatchObject({ rank: 1, opponentRaceAvailable: true });

        await expect(prepareServerDailyLeaderboardRace({
            challengeId: challenge.id,
            redditUsername: 'RaceFan',
            selection: {
                kind: 'row',
                rank: 1,
                displayName: snapshot.topRows[0].displayName,
                bestTimeMs,
                updatedAt,
            },
        })).resolves.toMatchObject({
            status: 200,
            body: { target: { ghost: { finishTimeMs: bestTimeMs } } },
        });
    });
});
