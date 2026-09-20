import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import type {
    HeadToHeadRequestContext,
    HeadToHeadServiceResult,
} from './head-to-head-service.js';
import { resolveHeadToHeadRecord } from './head-to-head-post.js';
import type { HeadToHeadRecord } from './head-to-head-model.js';
import {
    acquireRedisLock,
    releaseRedisLocksSafely,
    startRedisLockLeaseRenewal,
} from './redis-lock.js';
import {
    readUserCommentRecord,
    submitUserComment,
    type UserCommentRecord,
} from './user-comment-submit.js';

export const HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS = 10 * 60;
/**
 * The record that guards one brag or one comment. It must outlive any attempt that could follow it,
 * so it keeps the term the Daily share record keeps.
 */
export const HEAD_TO_HEAD_SHARE_RECORD_TTL_SECONDS = 365 * 24 * 60 * 60;
export const HEAD_TO_HEAD_SHARE_LOCK_TTL_MS = 30_000;
export const HEAD_TO_HEAD_SHARE_LOCK_RENEWAL_INTERVAL_MS = 10_000;

export type SignedHeadToHeadContext = {
    username: string;
    subredditName: string;
};

export type HeadToHeadSharePreview = {
    username: string;
    subredditName: string;
    postId: `t3_${string}`;
    commentText: string;
    /** The result this preview posts about. Its record guards it, and its lock serialises it. */
    resultKey: string;
};

/**
 * One key per result, and the action is part of it: a brag and a comment on one challenge hold
 * different opinions of the same race, and must never share a record or a lock.
 */
export function headToHeadShareResultKey({
    action,
    challengeId,
    username,
    timeMs,
}: {
    action: 'brag' | 'comment';
    challengeId: string;
    username: string;
    timeMs: number;
}): string {
    return [
        'miniracer:head-to-head:shared',
        action,
        challengeId,
        normalizeHeadToHeadName(username),
        timeMs,
    ].join(':');
}

export type HeadToHeadShareChallengeResolution = {
    challenge: HeadToHeadRecord;
} | {
    error: HeadToHeadServiceResult;
};

export function normalizeHeadToHeadName(value: string): string {
    return value.trim().toLowerCase();
}

export function getSignedHeadToHeadContext(
    context: HeadToHeadRequestContext,
): SignedHeadToHeadContext | null {
    const username = typeof context.username === 'string' ? context.username.trim() : '';
    const subredditName = typeof context.subredditName === 'string'
        ? context.subredditName.trim()
        : '';
    return username && subredditName ? { username, subredditName } : null;
}

export function headToHeadSharePreviewKey(prefix: string, token: string): string {
    return `${prefix}:preview:${token}`;
}

export async function writeHeadToHeadSharePreview(
    key: string,
    record: HeadToHeadSharePreview,
): Promise<void> {
    await redis.set(key, JSON.stringify(record), {
        expiration: new Date(Date.now() + HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS * 1000),
    });
}

async function readHeadToHeadSharePreview(key: string): Promise<HeadToHeadSharePreview | null> {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<HeadToHeadSharePreview>;
        if (
            typeof parsed?.username !== 'string'
            || typeof parsed?.subredditName !== 'string'
            || typeof parsed?.postId !== 'string'
            || !parsed.postId.startsWith('t3_')
            || typeof parsed?.commentText !== 'string'
            || typeof parsed?.resultKey !== 'string'
            || !parsed.resultKey
        ) return null;
        return parsed as HeadToHeadSharePreview;
    } catch {
        return null;
    }
}

export async function resolveHeadToHeadShareChallenge(
    challengeId: string,
    context: HeadToHeadRequestContext,
    request: SignedHeadToHeadContext,
    {
        action,
        expectedPostId = null,
    }: {
        action: 'brag' | 'comment';
        expectedPostId?: string | null;
    },
): Promise<HeadToHeadShareChallengeResolution> {
    const challenge = await resolveHeadToHeadRecord(challengeId, context);
    if (!challenge || normalizeHeadToHeadName(challenge.subredditName)
        !== normalizeHeadToHeadName(request.subredditName)) {
        return {
            error: {
                status: 404,
                body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.' },
            },
        };
    }
    if (normalizeHeadToHeadName(request.username)
        === normalizeHeadToHeadName(challenge.challengerUsername)) {
        return {
            error: {
                status: 403,
                body: {
                    status: 'own_challenge',
                    error: action === 'brag'
                        ? "You can't brag on your own challenge."
                        : "You can't comment on your own challenge.",
                },
            },
        };
    }
    if (!challenge.postId) {
        return {
            error: {
                status: 404,
                body: { status: 'post_unavailable', error: 'The challenge post is unavailable.' },
            },
        };
    }
    if (expectedPostId && challenge.postId !== expectedPostId) {
        return {
            error: {
                status: 404,
                body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.' },
            },
        };
    }
    return { challenge };
}

export async function submitHeadToHeadShareComment({
    tokenKey,
    request,
    action,
}: {
    tokenKey: string | null;
    request: SignedHeadToHeadContext;
    action: 'brag' | 'comment';
}): Promise<HeadToHeadServiceResult> {
    const expiredResult = {
        status: 409,
        body: { status: 'preview_expired', error: `This ${action} preview expired. Try again.` },
    };
    if (!tokenKey) return expiredResult;
    const inProgressResult = {
        status: 409,
        body: {
            status: action === 'brag' ? 'share_in_progress' : 'comment_in_progress',
            error: `This ${action} is already being posted.`,
        },
    };
    // The preview names the result, and the result names the lock. Two previews of one result
    // therefore wait for each other, which is what lets a record left behind be treated as dead.
    const claimed = await readHeadToHeadSharePreview(tokenKey);
    if (!claimed) return expiredResult;
    const lock = await acquireRedisLock(
        `${claimed.resultKey}:lock`,
        HEAD_TO_HEAD_SHARE_LOCK_TTL_MS,
        redis,
    );
    if (!lock) return inProgressResult;

    const lease = startRedisLockLeaseRenewal(
        lock,
        HEAD_TO_HEAD_SHARE_LOCK_RENEWAL_INTERVAL_MS,
        redis,
    );
    const postedBody = (record: UserCommentRecord, postUrl: string) => ({
        status: 200,
        body: {
            status: action === 'brag' ? 'shared' : 'commented',
            commentText: record.commentText,
            commentUrl: record.commentUrl || postUrl,
            commentId: record.commentId as `t1_${string}`,
        },
    });
    try {
        // Read again inside the lock: the copy above was read before it, and another confirmation
        // may have finished in between.
        const preview = await readHeadToHeadSharePreview(tokenKey);
        if (!preview) return expiredResult;
        if (
            normalizeHeadToHeadName(preview.username) !== normalizeHeadToHeadName(request.username)
            || normalizeHeadToHeadName(preview.subredditName) !== normalizeHeadToHeadName(request.subredditName)
        ) {
            return {
                status: 403,
                body: {
                    status: 'share_forbidden',
                    error: `This ${action} preview belongs to another Reddit account.`,
                },
            };
        }
        // A record with a comment answers from Redis alone, so a repeat asks Reddit nothing.
        const stored = await readUserCommentRecord(preview.resultKey);
        if (stored?.commentId) {
            await redis.del(tokenKey);
            return postedBody(stored, '');
        }
        const post = await reddit.getPostById(preview.postId) as { url?: string } | null;
        if (!post) {
            return {
                status: 404,
                body: { status: 'post_unavailable', error: 'The challenge post is unavailable.' },
            };
        }
        const postUrl = typeof post.url === 'string' ? post.url : '';
        const outcome = await submitUserComment({
            postId: preview.postId,
            username: preview.username,
            text: preview.commentText,
            record: {
                key: preview.resultKey,
                ttlSeconds: HEAD_TO_HEAD_SHARE_RECORD_TTL_SECONDS,
                stored,
            },
            fallbackCommentUrl: postUrl,
            confirmOwnership: () => lease.confirmOwnership(),
        });
        if (outcome.status === 'lock_lost') return inProgressResult;
        if (outcome.status === 'unconfirmed') {
            return {
                status: 409,
                body: {
                    status: 'comment_unconfirmed',
                    error: `Reddit did not confirm this ${action}. Try again to check.`,
                },
            };
        }
        if (outcome.status === 'already') {
            await redis.del(tokenKey);
            return postedBody(outcome.record, postUrl);
        }
        // The helper recorded the publication. Both answers below describe a live comment, so
        // nothing here deletes it.
        const published = outcome.record;
        if (
            normalizeHeadToHeadName(published.authorName || '')
            !== normalizeHeadToHeadName(preview.username)
        ) {
            return {
                status: 409,
                body: {
                    status: 'user_action_unavailable',
                    error: `Reddit user-attributed ${action === 'brag' ? 'sharing' : 'commenting'} is not available for this app version.`,
                },
            };
        }
        if (outcome.status === 'posted_without_link') {
            return {
                status: 409,
                body: {
                    status: 'posted_without_link',
                    error: 'Reddit did not return a link to your comment.',
                },
            };
        }
        await redis.del(tokenKey).catch((error: unknown) => {
            console.error('Head to Head share preview cleanup failed:', error);
        });
        return postedBody(published, postUrl);
    } finally {
        // The comment may already be live, so cleanup must not replace the result.
        await lease.stop();
        await releaseRedisLocksSafely([lock], 'Head to Head share', redis);
    }
}
