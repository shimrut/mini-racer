/**
 * One path from "a player finished" to "the player is ranked": match track,
 * rate limit, validate replay, normalise splits, lock, keep only if better,
 * persist PB + ghost. Daily and Campaign each had their own copy of this;
 * the response shape is Daily's, unchanged, since it's the one with clients.
 */
import { redis } from '@devvit/redis';
import type { Competition } from './competition.js';
import { writeEntry, readEntryByPlayerId } from './competition-leaderboard.js';
import { upsertPlayerTrackPersonalBest } from './pb-ghost-store.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
} from './redis-lock.js';
import { normalizeCheckpointTimesSec } from '../../game/shared/checkpoint-times.js';
import { sanitizeRedditUsername } from '../../game/shared/leaderboard-identity.js';
import { TRACKS } from '../../game/track/tracks.js';
import type { DailyGpLeaderboardEntry } from './daily-gp-model.js';

export const SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60;
export const SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 12;
export const SUBMISSION_LOCK_TTL_MS = 30_000;

function rateLimitKey(competition: Competition, identity: string): string {
    return `${competition.mode === 'daily' ? 'dailygp' : 'campaign'}:submit-rate-limit:${competition.id}:${identity}`;
}

function lockKey(competition: Competition, playerId: string): string {
    return `${competition.mode === 'daily' ? 'dailygp' : 'campaign'}:submit-lock:${competition.id}:${playerId}`;
}

export async function checkSubmissionRateLimit(
    competition: Competition,
    identity: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    const key = rateLimitKey(competition, identity);
    const attemptCount = await redis.incrBy(key, 1);
    if (attemptCount === 1) {
        await redis.expire(key, SUBMISSION_RATE_LIMIT_WINDOW_SECONDS);
    }
    if (attemptCount <= SUBMISSION_RATE_LIMIT_MAX_REQUESTS) {
        return { allowed: true };
    }
    const expiresAt = await redis.expireTime(key);
    return {
        allowed: false,
        retryAfterSeconds: Number.isFinite(expiresAt) && expiresAt > 0
            ? Math.max(1, expiresAt - Math.floor(Date.now() / 1000))
            : SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
    };
}

/**
 * A guest can mint a fresh player id at will, so their attempts are counted
 * against the request identity instead. A signed-in player cannot, so their own
 * id is the fairer bucket.
 */
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

export async function submitCompetitionRun({
    competition,
    playerId,
    redditUsername,
    trackKey,
    replay,
    requestRateLimitIdentity,
}: {
    competition: Competition;
    playerId: string;
    redditUsername?: unknown;
    trackKey?: unknown;
    replay?: unknown;
    requestRateLimitIdentity?: unknown;
}) {
    if (trackKey !== competition.trackKey) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission track does not match challenge.',
                reason: 'track_mismatch',
            },
        };
    }

    const rateLimitResult = await checkSubmissionRateLimit(
        competition,
        resolveRateLimitIdentity(playerId, redditUsername, requestRateLimitIdentity),
    );
    if (!rateLimitResult.allowed) {
        return {
            status: 429,
            body: {
                accepted: false,
                error: 'Too many submission attempts. Try again soon.',
                retryAfterSeconds: rateLimitResult.retryAfterSeconds,
            },
        };
    }

    const strictReplayOutcome = validateDailyGpReplayDetailed({
        challenge: {
            trackKey: competition.trackKey,
            rulesRevision: competition.rulesRevision,
            objectiveType: competition.objectiveType,
            objectiveParams: { lapCount: competition.lapCount },
        } as never,
        replay,
    });
    if (!strictReplayOutcome.ok) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: strictReplayOutcome.failure.reason,
                strictReplayFailureReason: strictReplayOutcome.failure.reason,
            },
        };
    }

    const track = TRACKS[competition.trackKey];
    if (!track) {
        return {
            status: 500,
            body: { accepted: false, error: 'Daily challenge track is unavailable.' },
        };
    }

    const nextBestTimeMs = strictReplayOutcome.run.bestTimeMs;
    const normalizedCheckpointTimesSec = normalizeCheckpointTimesSec(
        strictReplayOutcome.run.bestTimeSec,
        strictReplayOutcome.run.checkpointTimesSec,
    ) ?? strictReplayOutcome.run.checkpointTimesSec ?? null;

    const submissionLock = await acquireRedisLock(
        lockKey(competition, playerId),
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
        };
    }

    const nextEntry: DailyGpLeaderboardEntry = {
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
    };

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
        try {
            await releaseRedisLock(submissionLock, redis);
        } catch (error) {
            // Lock cleanup is best-effort; it must not replace a committed outcome.
            console.error('Competition submission lock cleanup failed:', error);
        }
    }

    if (boardPersistence!.status === 'rejected') {
        throw boardPersistence!.reason;
    }
    if (boardPersistence!.value.interrupted) {
        return {
            status: 503,
            body: {
                accepted: false,
                error: 'Submission save was interrupted. Retrying automatically.',
            },
        };
    }

    const storedEntry = boardPersistence!.value.entry;
    const trackPbAvailable = trackPbPersistence!.status === 'fulfilled';
    if (!trackPbAvailable) {
        console.error('Challenge PB persistence failed after a valid run:', trackPbPersistence!.reason);
    }
    const trackPbResult = trackPbAvailable ? trackPbPersistence!.value : null;
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
    };
}
