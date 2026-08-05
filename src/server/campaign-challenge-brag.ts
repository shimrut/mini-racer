import { randomUUID, createHash } from 'node:crypto';
import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import { getTrackName } from '../../game/track/catalog.js';
import { formatRaceTime } from './format-race-time.js';
import type {
    CampaignChallengeRequestContext,
    CampaignChallengeServiceResult,
} from './campaign-challenge-service.js';
import { resolveCampaignChallengeRecord } from './campaign-challenge-post.js';
import { readCampaignChallengeResult } from './campaign-challenge-store.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    startRedisLockLeaseRenewal,
} from './redis-lock.js';

const BRAG_PREVIEW_TTL_SECONDS = 10 * 60;
const BRAG_LOCK_TTL_MS = 30_000;
const BRAG_LOCK_RENEWAL_INTERVAL_MS = 10_000;
const BRAG_RECORD_TTL_SECONDS = 45 * 24 * 60 * 60;
const PREFIX = 'miniracer:campaign-challenge:brag';

type BragPreviewRecord = {
    username: string;
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    bestTimeMs: number;
    commentText: string;
    createdAt: string;
};

type BragSharedRecord = {
    commentId: `t1_${string}`;
    commentUrl: string;
    commentText: string;
    username: string;
    createdAt: string;
};

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

function signedContext(context: CampaignChallengeRequestContext): {
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

function sharedKey(challengeId: string, username: string): string {
    const viewerHash = createHash('sha256')
        .update(username.trim().toLowerCase())
        .digest('hex');
    return `${PREFIX}:shared:${challengeId}:${viewerHash}`;
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

function parseShared(raw: string | null): BragSharedRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<BragSharedRecord>;
        if (
            typeof parsed?.commentId !== 'string'
            || !parsed.commentId.startsWith('t1_')
            || typeof parsed?.commentUrl !== 'string'
            || typeof parsed?.commentText !== 'string'
            || typeof parsed?.username !== 'string'
        ) {
            return null;
        }
        return parsed as BragSharedRecord;
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

function alreadySharedBody(shared: BragSharedRecord): Record<string, unknown> {
    return {
        status: 'already_shared',
        commentText: shared.commentText,
        commentUrl: shared.commentUrl,
        commentId: shared.commentId,
    };
}

export async function previewCampaignChallengeBrag(
    input: Record<string, unknown>,
    context: CampaignChallengeRequestContext,
): Promise<CampaignChallengeServiceResult> {
    const request = signedContext(context);
    if (!request) {
        return {
            status: 401,
            body: { status: 'signed_in_required', error: 'Sign in to Reddit to brag about this win.' },
        };
    }
    const challengeId = typeof input.challengeId === 'string' ? input.challengeId : '';
    const challenge = await resolveCampaignChallengeRecord(challengeId, context);
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
    const result = await readCampaignChallengeResult(challenge.challengeId, request.username);
    if (!result || result.bestTimeMs >= challenge.targetTimeMs) {
        return {
            status: 404,
            body: { status: 'result_unavailable', error: 'Beat this challenge before you can brag.' },
        };
    }
    const sharedRaw = await redis.get(sharedKey(challenge.challengeId, request.username));
    const shared = parseShared(sharedRaw);
    if (shared) {
        return { status: 200, body: alreadySharedBody(shared) };
    }

    const commentText = formatChallengeBragComment(result.bestTimeMs, challenge.trackKey);
    const preview: BragPreviewRecord = {
        username: request.username,
        subredditName: request.subredditName,
        challengeId: challenge.challengeId,
        postId: challenge.postId,
        bestTimeMs: result.bestTimeMs,
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

export async function confirmCampaignChallengeBrag(
    input: Record<string, unknown>,
    context: CampaignChallengeRequestContext,
): Promise<CampaignChallengeServiceResult> {
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
        `${sharedKey(preview.challengeId, preview.username)}:lock`,
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
        const existing = parseShared(await redis.get(sharedKey(preview.challengeId, preview.username)));
        if (existing) {
            await redis.del(tokenKey);
            return { status: 200, body: alreadySharedBody(existing) };
        }

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
        const saved: BragSharedRecord = {
            commentId: commentId as `t1_${string}`,
            commentUrl: typeof (comment as { url?: string })?.url === 'string'
                ? (comment as { url: string }).url
                : (typeof (post as { url?: string })?.url === 'string' ? (post as { url: string }).url : ''),
            commentText: preview.commentText,
            username: preview.username,
            createdAt: new Date().toISOString(),
        };
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) {
            await deleteCommentBestEffort(comment as { delete?: () => Promise<unknown> });
            return {
                status: 409,
                body: { status: 'share_in_progress', error: 'This brag is already being posted.' },
            };
        }
        await transaction.set(sharedKey(preview.challengeId, preview.username), JSON.stringify(saved));
        await transaction.expire(sharedKey(preview.challengeId, preview.username), BRAG_RECORD_TTL_SECONDS);
        await transaction.del(tokenKey);
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            await deleteCommentBestEffort(comment as { delete?: () => Promise<unknown> });
            return {
                status: 409,
                body: { status: 'share_in_progress', error: 'This brag is already being posted.' },
            };
        }
        return {
            status: 200,
            body: {
                status: 'shared',
                commentText: saved.commentText,
                commentUrl: saved.commentUrl,
                commentId: saved.commentId,
            },
        };
    } finally {
        await lease.stop();
        await releaseRedisLock(lock, redis);
    }
}
