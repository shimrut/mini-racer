import { randomUUID } from 'node:crypto';
import type {
    HeadToHeadRequestContext,
    HeadToHeadServiceResult,
} from './head-to-head-service.js';
import { getTrackName } from '../../game/track/catalog.js';
import {
    HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS,
    headToHeadShareResultKey,
    getSignedHeadToHeadContext,
    headToHeadSharePreviewKey,
    resolveHeadToHeadShareChallenge,
    submitHeadToHeadShareComment,
    writeHeadToHeadSharePreview,
} from './head-to-head-share.js';
import { readUserCommentRecord } from './user-comment-submit.js';
import { formatChallengeResultTime } from './format-race-time.js';

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
    trackName: string,
    roll: () => number = Math.random,
): string {
    if (!Number.isSafeInteger(reportedTimeMs) || reportedTimeMs <= 0) {
        throw new Error('Challenge comments require a positive reported time.');
    }
    const tier = challengeCommentTier(differenceMs);
    if (!tier) throw new Error('Challenge comments require a non-negative millisecond difference.');
    const myTime = formatChallengeResultTime(reportedTimeMs);
    const gap = `${(differenceMs / 1000).toFixed(3)}s`;
    const lines = challengeCommentLines(tier, myTime, gap, trackName);
    return lines[roll() < 0.5 ? 0 : 1];
}

function challengeCommentLines(
    tier: ChallengeCommentTier,
    myTime: string,
    gap: string,
    trackName: string,
): readonly [string, string] {
    switch (tier) {
        case 'tie':
            return [
                `${myTime}. Same time. That’s worse than losing.`,
                'I tried so hard and all I got was a tie 🙄',
            ];
        case 'blink':
            return [
                `${myTime} - Lost by ${gap} on ${trackName}. I was sure I had this 😤`,
                `${myTime} on ${trackName}. Can’t believe I lost by ${gap} 🫠`,
            ];
        case 'chase':
            return [
                `${myTime} - Not enough pace on ${trackName}.`,
                `Definitely not my best run on ${trackName} - ${myTime}.`,
            ];
        case 'got_away':
            return [
                `${myTime} - I have some improvements to do on ${trackName}.`,
                `Need more practice on ${trackName} - ${myTime} 🏎️`,
            ];
    }
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
    const commentText = formatChallengeComment(
        reportedTimeMs,
        differenceMs,
        getTrackName(challenge.trackKey, challenge.trackKey),
    );
    const resultKey = headToHeadShareResultKey({
        action: 'comment',
        challengeId,
        username: request.username,
        timeMs: reportedTimeMs,
    });
    const posted = await readUserCommentRecord(resultKey);
    if (posted?.commentId) {
        return {
            status: 200,
            body: {
                status: 'already_commented',
                username: posted.username,
                commentText: posted.commentText,
                commentUrl: posted.commentUrl ?? '',
            },
        };
    }
    const token = randomUUID();
    await writeHeadToHeadSharePreview(
        headToHeadSharePreviewKey(COMMENT_PREFIX, token),
        {
            username: request.username,
            subredditName: request.subredditName,
            postId: challenge.postId,
            commentText,
            resultKey,
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
