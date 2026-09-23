import { redis } from '@devvit/redis';
import type { Competition } from './competition.js';
import {
    isCompleteOpponentRecord,
    markStoredEntryOpponentRaceReady,
    readEntryByPlayerId,
    withOpponentRaceReady,
    writeEntry,
} from './competition-leaderboard.js';
import { upsertPlayerTrackPersonalBest } from './pb-ghost-store.js';
import { validateDailyGpReplayDetailed, type ReplayValidationResult } from './replay-validator.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
} from './redis-lock.js';
import { normalizeCheckpointTimesSec } from '../../game/shared/checkpoint-times.js';
import { sanitizeRedditUsername } from '../../game/shared/leaderboard-identity.js';
import { TRACKS } from '../../game/track/tracks.js';
import type { DailyGpLeaderboardEntry } from './daily-gp-model.js';
import { isProgressTransferPending } from './guest-retirement.js';
import { checkFixedWindowRateLimit, type RateLimitResult } from './rate-limit.js';

export const SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60;
export const SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 12;
export const SUBMISSION_LOCK_TTL_MS = 30_000;

function rateLimitKey(competition: Competition, identity: string): string {
    return `${competition.mode === 'daily' ? 'dailygp' : 'campaign'}:submit-rate-limit:${competition.id}:${identity}`;
}

export function competitionSubmissionLockKey(competition: Competition, playerId: string): string {
    return `${competition.mode === 'daily' ? 'dailygp' : 'campaign'}:submit-lock:${competition.id}:${playerId}`;
}

export async function checkSubmissionRateLimit(
    competition: Competition,
    identity: string,
): Promise<RateLimitResult> {
    return checkFixedWindowRateLimit(
        rateLimitKey(competition, identity),
        SUBMISSION_RATE_LIMIT_MAX_REQUESTS,
        SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
    );
}

function resolveRateLimitIdentity(
    playerId: string,
    redditUsername: unknown,
    requestRateLimitIdentity: unknown,
): string {
    const safeRequestIdentity = typeof requestRateLimitIdentity === 'string'
        && requestRateLimitIdentity.trim()
        ? requestRateLimitIdentity.trim()
        : null;
    return !sanitizeRedditUsername(redditUsername) && safeRequestIdentity
        ? `request:${safeRequestIdentity}`
        : playerId;
}

export function isMismatchedSubmissionOwner(
    playerId: string,
    submissionOwnerId: unknown,
): boolean {
    const claimedOwnerId = typeof submissionOwnerId === 'string' && submissionOwnerId.trim()
        ? submissionOwnerId.trim()
        : null;
    return Boolean(claimedOwnerId) && claimedOwnerId !== playerId;
}

export type JudgedCompetitionContract = {
    trackKey: string;
    lapCount: number;
    rulesRevision: number;
    objectiveType: Competition['objectiveType'];
};

export type RankedSubmitReuseOptions = {
    verifiedRun?: ReplayValidationResult;
    judgedContract?: JudgedCompetitionContract;
    countTowardRateLimit?: boolean;
};

function isWellFormedVerifiedRun(run: unknown): run is ReplayValidationResult {
    if (!run || typeof run !== 'object') return false;
    const candidate = run as ReplayValidationResult;
    if (!Number.isFinite(candidate.bestTimeMs) || candidate.bestTimeMs <= 0) return false;
    if (candidate.ghost == null) return false;
    return candidate.completedLaps === 1
        || candidate.completedLaps === 2
        || candidate.completedLaps === 3;
}

function judgedContractMatches(
    contract: unknown,
    competition: Competition,
): contract is JudgedCompetitionContract {
    if (!contract || typeof contract !== 'object') return false;
    const judged = contract as JudgedCompetitionContract;
    return judged.trackKey === competition.trackKey
        && judged.lapCount === competition.lapCount
        && judged.rulesRevision === competition.rulesRevision
        && judged.objectiveType === competition.objectiveType;
}

export function validateCompetitionReplay(competition: Competition, replay: unknown) {
    return validateDailyGpReplayDetailed({
        challenge: {
            trackKey: competition.trackKey,
            rulesRevision: competition.rulesRevision,
            objectiveType: competition.objectiveType,
            objectiveParams: { lapCount: competition.lapCount },
        } as never,
        replay,
    });
}

export const SUBMISSION_IDENTITY_CHANGED_RESULT = {
    status: 409,
    body: {
        accepted: false,
        error: 'This result belongs to a different account. Sign back in to rank it.',
        reason: 'submission_identity_changed',
    },
} as const;

export async function submitCompetitionRun(
    {
        competition,
        playerId,
        redditUsername,
        trackKey,
        replay,
        requestRateLimitIdentity,
        submissionOwnerId,
    }: {
        competition: Competition;
        playerId: string;
        redditUsername?: unknown;
        trackKey?: unknown;
        replay?: unknown;
        requestRateLimitIdentity?: unknown;
        submissionOwnerId?: unknown;
    },
    reuse: RankedSubmitReuseOptions = {},
) {
    let releaseLock: Promise<unknown> = Promise.resolve();

    if (isMismatchedSubmissionOwner(playerId, submissionOwnerId)) {
        return { ...SUBMISSION_IDENTITY_CHANGED_RESULT, releaseLock };
    }

    if (trackKey !== competition.trackKey) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission track does not match challenge.',
                reason: 'track_mismatch',
            },
            releaseLock,
        };
    }

    if (reuse.countTowardRateLimit !== false) {
        const rateLimitResult = await checkSubmissionRateLimit(
            competition,
            resolveRateLimitIdentity(playerId, redditUsername, requestRateLimitIdentity),
        );
        if (rateLimitResult.allowed === false) {
            return {
                status: 429,
                body: {
                    accepted: false,
                    error: 'Too many submission attempts. Try again soon.',
                    retryAfterSeconds: rateLimitResult.retryAfterSeconds,
                },
                releaseLock,
            };
        }
    }

    const verifiedRun = reuse.verifiedRun;
    let strictReplayOutcome;
    if (verifiedRun != null) {
        if (
            isWellFormedVerifiedRun(verifiedRun)
            && judgedContractMatches(reuse.judgedContract, competition)
        ) {
            strictReplayOutcome = { ok: true as const, run: verifiedRun };
        } else {
            console.error('Competition submit could not reuse a judged run:', {
                reason: isWellFormedVerifiedRun(verifiedRun)
                    ? 'judged_contract_mismatch'
                    : 'malformed_verified_run',
                competitionId: competition.id,
                competitionMode: competition.mode,
            });
            strictReplayOutcome = validateCompetitionReplay(competition, replay);
        }
    } else {
        strictReplayOutcome = validateCompetitionReplay(competition, replay);
    }
    if (!strictReplayOutcome.ok) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: strictReplayOutcome.failure.reason,
                strictReplayFailureReason: strictReplayOutcome.failure.reason,
            },
            releaseLock,
        };
    }

    const track = TRACKS[competition.trackKey];
    if (!track) {
        return {
            status: 500,
            body: { accepted: false, error: 'Daily challenge track is unavailable.' },
            releaseLock,
        };
    }

    const nextBestTimeMs = strictReplayOutcome.run.bestTimeMs;
    const normalizedCheckpointTimesSec = normalizeCheckpointTimesSec(
        strictReplayOutcome.run.bestTimeSec,
        strictReplayOutcome.run.checkpointTimesSec,
    ) ?? strictReplayOutcome.run.checkpointTimesSec ?? null;

    const submissionLock = await acquireRedisLock(
        competitionSubmissionLockKey(competition, playerId),
        SUBMISSION_LOCK_TTL_MS,
        redis,
    );
    if (!submissionLock) {
        return {
            status: 429,
            body: {
                accepted: false,
                error: 'Submission already in progress. Try again in a moment.',
                retryAfterSeconds: 1,
            },
            releaseLock,
        };
    }

    if (await isProgressTransferPending(playerId)) {
        const pendingRelease = releaseRedisLock(submissionLock, redis).catch((error) => {
            console.error('Pending transfer submission lock cleanup failed:', error);
        });
        return {
            status: 503,
            body: {
                accepted: false,
                error: 'A progress transfer is in progress. Retrying automatically.',
                reason: 'progress_transfer_pending',
                retryAfterSeconds: 1,
            },
            releaseLock: pendingRelease,
        };
    }

    const nextEntry: DailyGpLeaderboardEntry = withOpponentRaceReady(
        {
            playerId,
            trackKey: competition.trackKey,
            bestTimeMs: nextBestTimeMs,
            updatedAt: new Date().toISOString(),
            completedLaps: strictReplayOutcome.run.completedLaps === 2
                || strictReplayOutcome.run.completedLaps === 3
                ? strictReplayOutcome.run.completedLaps
                : 1,
            checkpointTimesSec: normalizedCheckpointTimesSec,
            validationMethod: 'strict-replay',
            strictReplayFailureReason: null,
        },
        {
            bestTimeMs: nextBestTimeMs,
            checkpointTimesSec: normalizedCheckpointTimesSec,
            ghost: strictReplayOutcome.run.ghost ?? null,
        },
        competition,
    );

    let previousEntry: DailyGpLeaderboardEntry | null = null;
    let boardPersistence: PromiseSettledResult<{
        interrupted: boolean;
        improved: boolean;
        entry: DailyGpLeaderboardEntry;
    }>;
    let trackPbPersistence: PromiseSettledResult<Awaited<ReturnType<typeof upsertPlayerTrackPersonalBest>>>;
    try {
        previousEntry = await readEntryByPlayerId(competition, playerId);
        const boardWrite = async () => {
            if (previousEntry && previousEntry.bestTimeMs <= nextBestTimeMs) {
                return { interrupted: false, improved: false, entry: previousEntry };
            }

            const tx = await beginOwnedRedisLockTransaction(submissionLock, redis);
            if (!tx) {
                return { interrupted: true, improved: false, entry: previousEntry ?? nextEntry };
            }
            await writeEntry(competition, playerId, nextEntry, tx);
            const transactionResults = await tx.exec();
            return {
                interrupted: !Array.isArray(transactionResults) || transactionResults.length === 0,
                improved: true,
                entry: nextEntry,
            };
        };
        const retainedPersonalBest = previousEntry?.validationMethod === 'strict-replay'
            ? {
                bestTimeMs: previousEntry.bestTimeMs,
                checkpointTimesSec: previousEntry.checkpointTimesSec,
                updatedAt: previousEntry.updatedAt,
            }
            : null;
        [boardPersistence, trackPbPersistence] = await Promise.allSettled([
            boardWrite(),
            upsertPlayerTrackPersonalBest({
                playerId,
                competition,
                track,
                bestTimeMs: nextBestTimeMs,
                checkpointTimesSec: normalizedCheckpointTimesSec,
                lapCompletionTimesSec: strictReplayOutcome.run.lapCompletionTimesSec,
                ghost: strictReplayOutcome.run.ghost ?? null,
                updatedAt: nextEntry.updatedAt,
                retainedPersonalBest,
            }),
        ]);
    } finally {
        releaseLock = releaseRedisLock(submissionLock, redis).catch((error) => {
            console.error('Competition submission lock cleanup failed:', error);
        });
    }

    if (boardPersistence!.status === 'rejected') {
        await releaseLock;
        throw boardPersistence!.reason;
    }
    if (boardPersistence!.value.interrupted) {
        await releaseLock;
        return {
            status: 503,
            body: {
                accepted: false,
                error: 'Submission save was interrupted. Retrying automatically.',
            },
            releaseLock,
        };
    }

    const storedEntry = boardPersistence!.value.entry;
    const trackPbSettled = trackPbPersistence!;
    const trackPbAvailable = trackPbSettled.status === 'fulfilled';
    if (trackPbSettled.status === 'rejected') {
        console.error('Challenge PB persistence failed after a valid run:', trackPbSettled.reason);
    }
    const trackPbResult = trackPbSettled.status === 'fulfilled' ? trackPbSettled.value : null;
    if (
        trackPbResult?.record
        && isCompleteOpponentRecord(storedEntry, trackPbResult.record, competition)
        && storedEntry.opponentRaceReady !== true
    ) {
        try {
            await markStoredEntryOpponentRaceReady(competition, playerId, storedEntry);
        } catch (error) {
            console.error('Opponent-race ready marker failed after a valid run:', error);
        }
    }
    return {
        status: 200,
        body: {
            accepted: true,
            improved: boardPersistence!.value.improved,
            bestTimeMs: storedEntry.bestTimeMs,
            trackPbPersistenceStatus: trackPbAvailable
                ? (trackPbResult!.improved ? 'stored' : 'unchanged')
                : 'unavailable',
            trackPersonalBest: trackPbResult?.record ?? null,
            trackBestTimeMs: trackPbResult?.record.bestTimeMs ?? null,
            trackPbImproved: trackPbResult?.improved ?? false,
            trackGhostAvailable: Boolean(trackPbResult?.record.ghost),
            completedLaps: storedEntry.completedLaps,
            checkpointTimesSec: storedEntry.checkpointTimesSec ?? null,
            validationMethod: storedEntry.validationMethod ?? 'strict-replay',
            strictReplayFailureReason: storedEntry.strictReplayFailureReason ?? null,
        },
        releaseLock,
    };
}
