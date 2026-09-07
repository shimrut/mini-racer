import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockValidateDailyGpReplayDetailed = vi.fn();
const mockAcquireRedisLock = vi.fn();
const mockReleaseRedisLock = vi.fn();
const mockBeginOwnedRedisLockTransaction = vi.fn();
const mockWriteEntry = vi.fn();
const mockReadEntryByPlayerId = vi.fn();
const mockUpsertPlayerTrackPersonalBest = vi.fn();
const mockRedisIncrBy = vi.fn(async () => 1);
const mockRedisExpire = vi.fn(async () => true);
const mockRedisExpireTime = vi.fn(async () => Math.floor(Date.now() / 1000) + 60);
const mockRedisGet = vi.fn(async () => null);

vi.mock('@devvit/redis', () => ({
    redis: {
        incrBy: (...args) => mockRedisIncrBy(...args),
        expire: (...args) => mockRedisExpire(...args),
        expireTime: (...args) => mockRedisExpireTime(...args),
        get: (...args) => mockRedisGet(...args),
    },
}));

vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: (...args) => mockValidateDailyGpReplayDetailed(...args),
}));

vi.mock('../src/server/redis-lock.js', () => ({
    acquireRedisLock: (...args) => mockAcquireRedisLock(...args),
    releaseRedisLock: (...args) => mockReleaseRedisLock(...args),
    beginOwnedRedisLockTransaction: (...args) => mockBeginOwnedRedisLockTransaction(...args),
}));

vi.mock('../src/server/competition-leaderboard.js', () => ({
    writeEntry: (...args) => mockWriteEntry(...args),
    readEntryByPlayerId: (...args) => mockReadEntryByPlayerId(...args),
}));

vi.mock('../src/server/pb-ghost-store.js', () => ({
    upsertPlayerTrackPersonalBest: (...args) => mockUpsertPlayerTrackPersonalBest(...args),
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
    allowGuests: true,
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
        } = await import('../src/server/competition-submit.ts');

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
        const { submitCompetitionRun } = await import('../src/server/competition-submit.ts');
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
        const { submitCompetitionRun } = await import('../src/server/competition-submit.ts');

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
        const { submitCompetitionRun } = await import('../src/server/competition-submit.ts');
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
        const { submitCompetitionRun } = await import('../src/server/competition-submit.ts');
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
        const { submitCompetitionRun } = await import('../src/server/competition-submit.ts');
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
        const { submitCompetitionRun } = await import('../src/server/competition-submit.ts');
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
        const { submitCompetitionRun } = await import('../src/server/competition-submit.ts');
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
});
