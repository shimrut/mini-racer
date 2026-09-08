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
    releaseRedisLock,
    startRedisLockLeaseRenewal,
} from './redis-lock.js';

export const HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS = 10 * 60;
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
};

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

export async function deleteRedditCommentBestEffort(
    comment: { delete?: () => Promise<unknown> } | null,
): Promise<void> {
    try {
        await comment?.delete?.();
    } catch {
    }
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
    const lock = await acquireRedisLock(
        `${tokenKey}:lock`,
        HEAD_TO_HEAD_SHARE_LOCK_TTL_MS,
        redis,
    );
    if (!lock) return inProgressResult;

    const lease = startRedisLockLeaseRenewal(
        lock,
        HEAD_TO_HEAD_SHARE_LOCK_RENEWAL_INTERVAL_MS,
        redis,
    );
    try {
        // Read only after acquiring the lock: a prior confirmation may have consumed the token.
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
        const post = await reddit.getPostById(preview.postId) as { url?: string } | null;
        if (!post) {
            return {
                status: 404,
                body: { status: 'post_unavailable', error: 'The challenge post is unavailable.' },
            };
        }

        if (!await lease.confirmOwnership()) return inProgressResult;
        const comment = await reddit.submitComment({
            id: preview.postId,
            text: preview.commentText,
            runAs: 'USER',
        }) as {
            id?: string;
            url?: string;
            authorName?: string;
            delete?: () => Promise<unknown>;
        };
        if (
            normalizeHeadToHeadName(comment?.authorName || '')
            !== normalizeHeadToHeadName(preview.username)
        ) {
            await deleteRedditCommentBestEffort(comment);
            return {
                status: 409,
                body: {
                    status: 'user_action_unavailable',
                    error: `Reddit user-attributed ${action === 'brag' ? 'sharing' : 'commenting'} is not available for this app version.`,
                },
            };
        }
        const commentId = comment?.id;
        if (typeof commentId !== 'string' || !commentId.startsWith('t1_')) {
            await deleteRedditCommentBestEffort(comment);
            throw new Error(action === 'brag'
                ? 'Reddit did not return a brag comment ID.'
                : 'Reddit did not return a comment ID.');
        }
        await redis.del(tokenKey);
        return {
            status: 200,
            body: {
                status: action === 'brag' ? 'shared' : 'commented',
                commentText: preview.commentText,
                commentUrl: typeof comment.url === 'string'
                    ? comment.url
                    : (typeof post.url === 'string' ? post.url : ''),
                commentId: commentId as `t1_${string}`,
            },
        };
    } finally {
        await lease.stop();
        await releaseRedisLock(lock, redis);
    }
}
