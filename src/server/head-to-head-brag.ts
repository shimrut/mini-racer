import { randomUUID } from 'node:crypto';
import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import { getTrackName } from '../../game/track/catalog.js';
import { formatRaceTime } from './format-race-time.js';
import type {
    HeadToHeadRequestContext,
    HeadToHeadServiceResult,
} from './head-to-head-service.js';
import { resolveHeadToHeadRecord } from './head-to-head-post.js';
import { readHeadToHeadAccept } from './head-to-head-store.js';
import {
    acquireRedisLock,
    releaseRedisLock,
    startRedisLockLeaseRenewal,
} from './redis-lock.js';

const BRAG_PREVIEW_TTL_SECONDS = 10 * 60;
const BRAG_LOCK_TTL_MS = 30_000;
const BRAG_LOCK_RENEWAL_INTERVAL_MS = 10_000;
const PREFIX = 'miniracer:head-to-head:brag';

type BragPreviewRecord = {
    username: string;
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    bestTimeMs: number;
    commentText: string;
    createdAt: string;
};

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

function signedContext(context: HeadToHeadRequestContext): {
    username: string;
    subredditName: string;
} | null {
    const username = typeof context.username === 'string' ? context.username.trim() : '';
    const subredditName = typeof context.subredditName === 'string'
        ? context.subredditName.trim()
        : '';
    return username && subredditName ? { username, subredditName } : null;
}

function previewKey(token: string): string {
    return `${PREFIX}:preview:${token}`;
}

export function formatChallengeBragComment(
    bestTimeMs: number,
    trackKey: string,
): string {
    const time = formatRaceTime(bestTimeMs);
    const trackName = getTrackName(trackKey, 'this track');
    return `I beat this challenge with ${time} on ${trackName}. 🏁`;
}

function parsePreview(raw: string | null): BragPreviewRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<BragPreviewRecord>;
        if (
            typeof parsed?.username !== 'string'
            || typeof parsed?.subredditName !== 'string'
            || typeof parsed?.challengeId !== 'string'
            || typeof parsed?.postId !== 'string'
            || !parsed.postId.startsWith('t3_')
            || !Number.isInteger(parsed.bestTimeMs)
            || typeof parsed?.commentText !== 'string'
        ) {
            return null;
        }
        return parsed as BragPreviewRecord;
    } catch {
        return null;
    }
}

async function deleteCommentBestEffort(comment: { delete?: () => Promise<unknown> } | null): Promise<void> {
    try {
        await comment?.delete?.();
    } catch {
        // Best effort.
    }
}

export async function previewHeadToHeadBrag(
    input: Record<string, unknown>,
    context: HeadToHeadRequestContext,
): Promise<HeadToHeadServiceResult> {
    const request = signedContext(context);
    if (!request) {
        return {
            status: 401,
            body: { status: 'signed_in_required', error: 'Sign in to Reddit to brag about this win.' },
        };
    }
    const acceptToken = typeof input.acceptToken === 'string' ? input.acceptToken : '';
    if (!acceptToken) {
        return {
            status: 404,
            body: { status: 'result_unavailable', error: 'Beat this challenge before you can brag.' },
        };
    }
    const acceptRecord = await readHeadToHeadAccept(acceptToken);
    if (!acceptRecord) {
        return {
            status: 404,
            body: { status: 'result_unavailable', error: 'Beat this challenge before you can brag.' },
        };
    }
    if (acceptRecord.bestTimeMs >= acceptRecord.targetTimeMs) {
        return {
            status: 404,
            body: { status: 'result_unavailable', error: 'Beat this challenge before you can brag.' },
        };
    }
    if (normalizeName(acceptRecord.username) !== normalizeName(request.username)) {
        return {
            status: 403,
            body: { status: 'share_forbidden', error: 'This brag preview belongs to another Reddit account.' },
        };
    }
    const challenge = await resolveHeadToHeadRecord(acceptRecord.challengeId, context);
    if (!challenge || normalizeName(challenge.subredditName) !== normalizeName(request.subredditName)) {
        return {
            status: 404,
            body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.' },
        };
    }
    if (normalizeName(request.username) === normalizeName(challenge.challengerUsername)) {
        return {
            status: 403,
            body: { status: 'own_challenge', error: "You can't brag on your own challenge." },
        };
    }
    if (!challenge.postId) {
        return {
            status: 404,
            body: { status: 'post_unavailable', error: 'The challenge post is unavailable.' },
        };
    }
    if (challenge.postId !== acceptRecord.postId) {
        return {
            status: 404,
            body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.' },
        };
    }

    const commentText = acceptRecord.commentText;
    const preview: BragPreviewRecord = {
        username: request.username,
        subredditName: request.subredditName,
        challengeId: challenge.challengeId,
        postId: challenge.postId,
        bestTimeMs: acceptRecord.bestTimeMs,
        commentText,
        createdAt: new Date().toISOString(),
    };
    const shareToken = randomUUID();
    await redis.set(previewKey(shareToken), JSON.stringify(preview));
    await redis.expire(previewKey(shareToken), BRAG_PREVIEW_TTL_SECONDS);
    return {
        status: 200,
        body: {
            status: 'ready',
            shareToken,
            username: preview.username,
            commentText: preview.commentText,
            expiresAt: new Date(Date.now() + BRAG_PREVIEW_TTL_SECONDS * 1000).toISOString(),
        },
    };
}

export async function confirmHeadToHeadBrag(
    input: Record<string, unknown>,
    context: HeadToHeadRequestContext,
): Promise<HeadToHeadServiceResult> {
    const request = signedContext(context);
    if (!request) {
        return {
            status: 401,
            body: { status: 'signed_in_required', error: 'Sign in to Reddit to brag about this win.' },
        };
    }
    const token = typeof input.shareToken === 'string' ? input.shareToken : '';
    const tokenKey = previewKey(token);
    const preview = parsePreview(token ? await redis.get(tokenKey) : null);
    if (!preview) {
        return {
            status: 409,
            body: { status: 'preview_expired', error: 'This brag preview expired. Try again.' },
        };
    }
    if (
        normalizeName(preview.username) !== normalizeName(request.username)
        || normalizeName(preview.subredditName) !== normalizeName(request.subredditName)
    ) {
        return {
            status: 403,
            body: { status: 'share_forbidden', error: 'This brag preview belongs to another Reddit account.' },
        };
    }

    const lock = await acquireRedisLock(
        `${tokenKey}:lock`,
        BRAG_LOCK_TTL_MS,
        redis,
    );
    if (!lock) {
        return {
            status: 409,
            body: { status: 'share_in_progress', error: 'This brag is already being posted.' },
        };
    }
    const lease = startRedisLockLeaseRenewal(lock, BRAG_LOCK_RENEWAL_INTERVAL_MS, redis);
    try {
        const post = await reddit.getPostById(preview.postId);
        if (!post) {
            return {
                status: 404,
                body: { status: 'post_unavailable', error: 'The challenge post is unavailable.' },
            };
        }
        const comment = await reddit.submitComment({
            id: preview.postId,
            text: preview.commentText,
        });
        if (normalizeName((comment as { authorName?: string })?.authorName || '') !== normalizeName(preview.username)) {
            await deleteCommentBestEffort(comment as { delete?: () => Promise<unknown> });
            return {
                status: 409,
                body: {
                    status: 'user_action_unavailable',
                    error: 'Reddit user-attributed sharing is not available for this app version.',
                },
            };
        }
        const commentId = (comment as { id?: string })?.id;
        if (typeof commentId !== 'string' || !commentId.startsWith('t1_')) {
            await deleteCommentBestEffort(comment as { delete?: () => Promise<unknown> });
            throw new Error('Reddit did not return a brag comment ID.');
        }
        await redis.del(tokenKey);
        return {
            status: 200,
            body: {
                status: 'shared',
                commentText: preview.commentText,
                commentUrl: typeof (comment as { url?: string })?.url === 'string'
                    ? (comment as { url: string }).url
                    : (typeof (post as { url?: string })?.url === 'string' ? (post as { url: string }).url : ''),
                commentId: commentId as `t1_${string}`,
            },
        };
    } finally {
        await lease.stop();
        await releaseRedisLock(lock, redis);
    }
}
