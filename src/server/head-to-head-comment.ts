import { randomUUID } from 'node:crypto';
import type {
    HeadToHeadRequestContext,
    HeadToHeadServiceResult,
} from './head-to-head-service.js';
import {
    HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS,
    headToHeadShareResultKey,
    getSignedHeadToHeadContext,
    headToHeadSharePreviewKey,
    resolveHeadToHeadShareChallenge,
    submitHeadToHeadShareComment,
    writeHeadToHeadSharePreview,
} from './head-to-head-share.js';

const COMMENT_PREFIX = 'miniracer:head-to-head:comment';

type ChallengeCommentTier =
    | 'tie'
    | 'blink'
    | 'chase'
    | 'got_away';

export function challengeCommentTier(differenceMs: number): ChallengeCommentTier | null {
    if (!Number.isSafeInteger(differenceMs) || differenceMs < 0) return null;
    if (differenceMs === 0) return 'tie';
    if (differenceMs <= 100) return 'blink';
    if (differenceMs <= 500) return 'chase';
    return 'got_away';
}

export function formatChallengeComment(
    reportedTimeMs: number,
    differenceMs: number,
): string {
    if (!Number.isSafeInteger(reportedTimeMs) || reportedTimeMs <= 0) {
        throw new Error('Challenge comments require a positive reported time.');
    }
    const tier = challengeCommentTier(differenceMs);
    if (!tier) throw new Error('Challenge comments require a non-negative millisecond difference.');
    if (tier === 'tie') {
        return 'I tried so hard and all I got was a tie 🙄';
    }
    const gap = `${(differenceMs / 1000).toFixed(3)}s`;
    const myTime = formatChallengeResultTime(reportedTimeMs);
    switch (tier) {
        case 'blink':
            return `${myTime}. Can’t believe I lost by ${gap}😤`;
        case 'chase':
            return `${myTime}. Definitely not my best run 😬`;
        case 'got_away':
            return `${myTime} - I have some improvements to do 😓`;
    }
}

function formatChallengeResultTime(timeMs: number): string {
    return `${(timeMs / 1000).toFixed(3)}s`;
}

export async function previewHeadToHeadComment(
    input: Record<string, unknown>,
    context: HeadToHeadRequestContext,
): Promise<HeadToHeadServiceResult> {
    const request = getSignedHeadToHeadContext(context);
    if (!request) {
        return {
            status: 401,
            body: { status: 'signed_in_required', error: 'Sign in to Reddit to comment on this challenge.' },
        };
    }
    const challengeId = typeof input.challengeId === 'string' ? input.challengeId : '';
    const reportedTimeMs = Number(input.reportedTimeMs);
    if (!challengeId || !Number.isSafeInteger(reportedTimeMs) || reportedTimeMs <= 0) {
        return {
            status: 400,
            body: { status: 'invalid_comment', error: 'This finish cannot be shared.' },
        };
    }
    const resolution = await resolveHeadToHeadShareChallenge(
        challengeId,
        context,
        request,
        { action: 'comment' },
    );
    if ('error' in resolution) return resolution.error;
    const { challenge } = resolution;
    const differenceMs = reportedTimeMs - challenge.targetTimeMs;
    if (differenceMs < 0) {
        return {
            status: 409,
            body: { status: 'win_uses_brag', error: 'Faster finishes use the Brag action.' },
        };
    }
    const commentText = formatChallengeComment(reportedTimeMs, differenceMs);
    const token = randomUUID();
    await writeHeadToHeadSharePreview(
        headToHeadSharePreviewKey(COMMENT_PREFIX, token),
        {
            username: request.username,
            subredditName: request.subredditName,
            postId: challenge.postId,
            commentText,
            resultKey: headToHeadShareResultKey({
                action: 'comment',
                challengeId,
                username: request.username,
                timeMs: reportedTimeMs,
            }),
        },
    );
    return {
        status: 200,
        body: {
            status: 'ready',
            shareToken: token,
            username: request.username,
            commentText,
            expiresAt: new Date(
                Date.now() + HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS * 1000,
            ).toISOString(),
        },
    };
}

export async function confirmHeadToHeadComment(
    input: Record<string, unknown>,
    context: HeadToHeadRequestContext,
): Promise<HeadToHeadServiceResult> {
    const request = getSignedHeadToHeadContext(context);
    if (!request) {
        return {
            status: 401,
            body: { status: 'signed_in_required', error: 'Sign in to Reddit to comment on this challenge.' },
        };
    }
    const token = typeof input.shareToken === 'string' ? input.shareToken : '';
    const tokenKey = token ? headToHeadSharePreviewKey(COMMENT_PREFIX, token) : null;
    return submitHeadToHeadShareComment({ tokenKey, request, action: 'comment' });
}
