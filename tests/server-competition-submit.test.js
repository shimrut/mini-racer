import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockValidateDailyGpReplayDetailed = vi.fn();
const mockAcquireRedisLock = vi.fn();
const mockReleaseRedisLock = vi.fn();
const mockBeginOwnedRedisLockTransaction = vi.fn();
const mockWriteEntry = vi.fn();
const mockReadEntryByPlayerId = vi.fn();
const mockUpsertPlayerTrackPersonalBest = vi.fn();
const mockRedisHSet = vi.fn(async () => 1);
const mockRedisIncrBy = vi.fn(async () => 1);
const mockRedisExpire = vi.fn(async () => true);
const mockRedisExpireTime = vi.fn(async () => Math.floor(Date.now() / 1000) + 60);
const mockRedisGet = vi.fn(async () => null);

vi.mock('@devvit/redis', () => ({
    redis: {
        incrBy: (...args) => mockRedisIncrBy(...args),
        hSet: (...args) => mockRedisHSet(...args),
        expire: (...args) => mockRedisExpire(...args),
        expireTime: (...args) => mockRedisExpireTime(...args),
        get: (...args) => mockRedisGet(...args),
    },
}));

vi.mock('../src/server/competition/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: (...args) => mockValidateDailyGpReplayDetailed(...args),
}));

vi.mock('../src/server/redis/redis-lock.js', () => ({
    acquireRedisLock: (...args) => mockAcquireRedisLock(...args),
    releaseRedisLock: (...args) => mockReleaseRedisLock(...args),
    beginOwnedRedisLockTransaction: (...args) => mockBeginOwnedRedisLockTransaction(...args),
}));

vi.mock('../src/server/competition/competition-leaderboard.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        writeEntry: (...args) => mockWriteEntry(...args),
        readEntryByPlayerId: (...args) => mockReadEntryByPlayerId(...args),
    };
});

vi.mock('../src/server/competition/pb-ghost-store.js', () => ({
    upsertPlayerTrackPersonalBest: (...args) => mockUpsertPlayerTrackPersonalBest(...args),
    // A record from this mock was never read from Redis, so it has no stub text to check a copy against.
    movedRowText: () => null,
}));

const competition = {
    id: 'daily-gp-2026-08-23',
    mode: 'daily',
    trackKey: 'circuit',
    lapCount: 1,
    rulesRevision: 1,
    objectiveType: 'single_lap_fastest',
    leaderboardKey: 'dailygp:leaderboard:daily-gp-2026-08-23',
    entryHashKey: 'dailygp:entries:daily-gp-2026-08-23',
    standingsRevisionKey: 'dailygp:standings-revision:daily-gp-2026-08-23',
    pbHashKey: 'dailygp:pb:daily-gp-2026-08-23',
    ttlSeconds: 86_400,
    guestExpiryKey: null,
    guestRetentionSeconds: null,
};

function validReplayOutcome(bestTimeMs = 12_345) {
    return {
        ok: true,
        run: {
            bestTimeSec: bestTimeMs / 1000,
            bestTimeMs,
            completedLaps: 1,
            checkpointTimesSec: [4.2, 9.8],
            lapCompletionTimesSec: [bestTimeMs / 1000],
            ghost: {
                schemaVersion: 2,
                sampleIntervalMs: 50,
                finishTimeMs: 50,
                origin: [0, 0, 0],
                deltas: [100, 100, 100],
            },
        },
    };
}

describe('submitCompetitionRun', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidateDailyGpReplayDetailed.mockReturnValue(validReplayOutcome());
        mockAcquireRedisLock.mockResolvedValue({
            key: `dailygp:submit-lock:${competition.id}:reddit:pm-user`,
            value: 'lock-token',
            ttlMs: 30_000,
        });
        mockReleaseRedisLock.mockResolvedValue(true);
        mockBeginOwnedRedisLockTransaction.mockResolvedValue({
            exec: vi.fn(async () => [1, 1, 1]),
        });
        mockReadEntryByPlayerId.mockResolvedValue(null);
        mockWriteEntry.mockResolvedValue(undefined);
        mockUpsertPlayerTrackPersonalBest.mockResolvedValue({
            improved: true,
            record: { bestTimeMs: 12_345, ghost: null },
        });
    });

    it('writes the board, returns releaseLock, and clears ownership after await', async () => {
        const {
            competitionSubmissionLockKey,
            submitCompetitionRun,
        } = await import('../src/server/competition/competition-submit.ts');

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            redditUsername: 'Pm-User',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(outcome.status).toBe(200);
        expect(outcome.body).toMatchObject({
            accepted: true,
            bestTimeMs: 12_345,
        });
        expect(mockWriteEntry).toHaveBeenCalled();
        expect(mockRedisIncrBy).toHaveBeenCalled();
        expect(mockAcquireRedisLock).toHaveBeenCalledWith(
            competitionSubmissionLockKey(competition, 'reddit:pm-user'),
            expect.any(Number),
            expect.anything(),
        );
        expect(mockReleaseRedisLock).toHaveBeenCalled();
        await outcome.releaseLock;
        expect(mockReleaseRedisLock).toHaveBeenCalledTimes(1);
    });

    it('swallows a failing release to console.error without disturbing the 200', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        mockReleaseRedisLock.mockRejectedValue(new Error('cleanup unavailable'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            redditUsername: 'Pm-User',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(outcome.status).toBe(200);
        await outcome.releaseLock;
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Competition submission lock cleanup failed:',
            expect.any(Error),
        );
        consoleErrorSpy.mockRestore();
    });

    it('returns 422 on a bad replay and 429 when the lock is already held', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');

        mockValidateDailyGpReplayDetailed.mockReturnValueOnce({
            ok: false,
            failure: { reason: 'truncated_mismatch' },
        });
        const badReplay = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [] },
        });
        expect(badReplay.status).toBe(422);
        expect(badReplay.body).toMatchObject({
            accepted: false,
            reason: 'truncated_mismatch',
        });
        expect(badReplay.releaseLock).toEqual(expect.any(Promise));
        expect(mockAcquireRedisLock).not.toHaveBeenCalled();

        mockValidateDailyGpReplayDetailed.mockReturnValue(validReplayOutcome());
        mockAcquireRedisLock.mockResolvedValueOnce(null);
        const locked = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });
        expect(locked.status).toBe(429);
        expect(locked.body.accepted).toBe(false);
        expect(locked.releaseLock).toEqual(expect.any(Promise));
    });

    it('waits when a guest transfer marker appears before the commit check', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        mockRedisGet.mockResolvedValueOnce('guest:pending-transfer');

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(outcome.status).toBe(503);
        expect(outcome.body).toMatchObject({
            accepted: false,
            reason: 'progress_transfer_pending',
            retryAfterSeconds: 1,
        });
        expect(mockWriteEntry).not.toHaveBeenCalled();
        await outcome.releaseLock;
    });

    const matchingContract = {
        trackKey: 'circuit',
        lapCount: 1,
        rulesRevision: 1,
        objectiveType: 'single_lap_fastest',
    };

    it('reuses a judged run and skips the origin rate limit', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            redditUsername: 'Pm-User',
            trackKey: 'circuit',
            replay: { inputs: [] },
        }, {
            verifiedRun: validReplayOutcome().run,
            judgedContract: matchingContract,
            countTowardRateLimit: false,
        });

        expect(outcome.status).toBe(200);
        expect(outcome.body).toMatchObject({ accepted: true, bestTimeMs: 12_345 });
        expect(mockValidateDailyGpReplayDetailed).not.toHaveBeenCalled();
        expect(mockRedisIncrBy).not.toHaveBeenCalled();
        expect(mockWriteEntry).toHaveBeenCalled();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    it('falls back to a full re-drive when the judged contract does not match', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        }, {
            verifiedRun: validReplayOutcome().run,
            judgedContract: { ...matchingContract, lapCount: 2 },
            countTowardRateLimit: false,
        });

        expect(outcome.status).toBe(200);
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalled();
        expect(mockRedisIncrBy).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Competition submit could not reuse a judged run:',
            expect.objectContaining({ reason: 'judged_contract_mismatch' }),
        );
        consoleErrorSpy.mockRestore();
    });

    it('falls back to a full re-drive when the judged run is malformed', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        }, {
            verifiedRun: { ...validReplayOutcome().run, ghost: null },
            judgedContract: matchingContract,
            countTowardRateLimit: false,
        });

        expect(outcome.status).toBe(200);
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Competition submit could not reuse a judged run:',
            expect.objectContaining({ reason: 'malformed_verified_run' }),
        );
        consoleErrorSpy.mockRestore();
    });

    it('does not log when an ordinary submit has no judged run', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalled();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    it('writes opponentRaceReady with the new row when the run has a matching ghost', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        const bestTimeMs = 12_345;
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: bestTimeMs / 1000,
                bestTimeMs,
                completedLaps: 1,
                checkpointTimesSec: [4, 8, 12.345],
                lapCompletionTimesSec: [bestTimeMs / 1000],
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: bestTimeMs,
                    origin: [0, 0, 0],
                    deltas: [100, 100, 100],
                },
            },
        });

        await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(mockWriteEntry.mock.calls[0][2]).toMatchObject({
            bestTimeMs,
            opponentRaceReady: true,
        });
        // Only the raced list is written outside the save transaction.
        expect(mockRedisHSet.mock.calls.filter(([key]) => !String(key).startsWith('miniracer:raced:'))).toEqual([]);
    });

    it('stamps opponentRaceReady when a later ghost matches an unmarked stored time', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        const previous = {
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            bestTimeMs: 12_345,
            updatedAt: '2026-08-23T00:00:00.000Z',
            completedLaps: 1,
            checkpointTimesSec: [4, 8, 12.345],
            validationMethod: 'strict-replay',
        };
        mockReadEntryByPlayerId.mockResolvedValue(previous);
        mockUpsertPlayerTrackPersonalBest.mockResolvedValue({
            improved: false,
            record: {
                bestTimeMs: 12_345,
                checkpointTimesSec: [4, 8, 12.345],
                ghost: { finishTimeMs: 12_345 },
            },
        });

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(outcome.status).toBe(200);
        expect(mockWriteEntry).not.toHaveBeenCalled();
        expect(mockRedisHSet).toHaveBeenCalledWith(
            competition.entryHashKey,
            {
                'reddit:pm-user': expect.stringMatching(/"opponentRaceReady":true/),
            },
        );
        expect(mockRedisIncrBy).toHaveBeenCalledWith(competition.standingsRevisionKey, 1);
    });

    it('answers a slower run that keeps a moved PB with an unavailable ghost when the copy cannot be checked', async () => {
        const { submitCompetitionRun } = await import('../src/server/competition/competition-submit.ts');
        mockReadEntryByPlayerId.mockResolvedValue(null);
        mockUpsertPlayerTrackPersonalBest.mockResolvedValue({
            improved: false,
            record: {
                bestTimeMs: 12_000,
                checkpointTimesSec: [4, 8, 12],
                ghost: null,
                ghostArchive: { v: 1, key: 'daily-ghosts/v1/daily-gp-2026-08-23/x-0123456789abcdef.gz', sha256: 'a'.repeat(64) },
            },
        });

        const outcome = await submitCompetitionRun({
            competition,
            playerId: 'reddit:pm-user',
            trackKey: 'circuit',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(outcome.status).toBe(200);
        expect(outcome.body.trackPbPersistenceStatus).toBe('unchanged');
        expect(outcome.body.trackGhostAvailable).toBe(true);
        expect(outcome.body.trackPersonalBest).toEqual({
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8, 12],
            ghost: null,
            ghostUnavailable: true,
        });
        expect(mockRedisHSet).not.toHaveBeenCalledWith(competition.entryHashKey, expect.anything());
    });
});
