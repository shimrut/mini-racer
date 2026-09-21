import { randomUUID } from 'node:crypto';
import type {
    HeadToHeadRequestContext,
    HeadToHeadServiceResult,
} from './head-to-head-service.js';
import { getTrackName } from '../../game/track/catalog.js';
import { readHeadToHeadAccept } from './head-to-head-store.js';
import {
    HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS,
    headToHeadShareResultKey,
    getSignedHeadToHeadContext,
    headToHeadSharePreviewKey,
    normalizeHeadToHeadName,
    resolveHeadToHeadShareChallenge,
    submitHeadToHeadShareComment,
    writeHeadToHeadSharePreview,
} from './head-to-head-share.js';

const PREFIX = 'miniracer:head-to-head:brag';

export function formatChallengeBragComment(
    bestTimeMs: number,
    targetTimeMs: number,
    trackName: string,
    roll: () => number = Math.random,
): string {
    const differenceMs = targetTimeMs - bestTimeMs;
    const tier = challengeBragTier(differenceMs);
    if (!tier) throw new Error('Challenge Brags require a positive millisecond lead.');
    const myTime = formatChallengeResultTime(bestTimeMs);
    const gap = `${(differenceMs / 1000).toFixed(3)}s`;
    const lines = challengeBragLines(tier, myTime, gap, trackName);
    return lines[roll() < 0.5 ? 0 : 1];
}

function challengeBragLines(
    tier: ChallengeBragTier,
    myTime: string,
    gap: string,
    trackName: string,
): readonly [string, string] {
    switch (tier) {
        case 'blink':
            return [
                `${myTime} on ${trackName}. Won by ${gap}. Didn’t think I had it.`,
                `This was a close win. ${myTime} on ${trackName}`,
            ];
        case 'chase':
            return [
                `I beat this challenge. ${myTime} on ${trackName}.`,
                `${myTime} Good pace on ${trackName}.`,
            ];
        case 'got_away':
            return [
                `Won it. Easier than expected. ${myTime} on ${trackName}.`,
                `Got a great time on ${trackName} - ${myTime}.`,
            ];
    }
}

function formatChallengeResultTime(timeMs: number): string {
    return `${(timeMs / 1000).toFixed(3)}s`;
}

type ChallengeBragTier =
    | 'blink'
    | 'chase'
    | 'got_away';

export function challengeBragTier(differenceMs: number): ChallengeBragTier | null {
    if (!Number.isSafeInteger(differenceMs) || differenceMs <= 0) return null;
    if (differenceMs <= 100) return 'blink';
    if (differenceMs <= 500) return 'chase';
    return 'got_away';
}

export async function previewHeadToHeadBrag(
    input: Record<string, unknown>,
    context: HeadToHeadRequestContext,
): Promise<HeadToHeadServiceResult> {
    const request = getSignedHeadToHeadContext(context);
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
    if (
        normalizeHeadToHeadName(acceptRecord.username)
        !== normalizeHeadToHeadName(request.username)
    ) {
        return {
            status: 403,
            body: { status: 'share_forbidden', error: 'This brag preview belongs to another Reddit account.' },
        };
    }
    const resolution = await resolveHeadToHeadShareChallenge(
        acceptRecord.challengeId,
        context,
        request,
        { action: 'brag', expectedPostId: acceptRecord.postId },
    );
    if ('error' in resolution) return resolution.error;
    const { challenge } = resolution;

    const commentText = formatChallengeBragComment(
        acceptRecord.bestTimeMs,
        acceptRecord.targetTimeMs,
        getTrackName(challenge.trackKey, challenge.trackKey),
    );
    const preview = {
        username: request.username,
        subredditName: request.subredditName,
        postId: challenge.postId,
        commentText,
        resultKey: headToHeadShareResultKey({
            action: 'brag',
            challengeId: acceptRecord.challengeId,
            username: request.username,
            timeMs: acceptRecord.bestTimeMs,
        }),
    };
    const shareToken = randomUUID();
    await writeHeadToHeadSharePreview(
        headToHeadSharePreviewKey(PREFIX, shareToken),
        preview,
    );
    return {
        status: 200,
        body: {
            status: 'ready',
            shareToken,
            username: preview.username,
            commentText: preview.commentText,
            expiresAt: new Date(
                Date.now() + HEAD_TO_HEAD_SHARE_PREVIEW_TTL_SECONDS * 1000,
            ).toISOString(),
        },
    };
}

export async function confirmHeadToHeadBrag(
    input: Record<string, unknown>,
    context: HeadToHeadRequestContext,
): Promise<HeadToHeadServiceResult> {
    const request = getSignedHeadToHeadContext(context);
    if (!request) {
        return {
            status: 401,
            body: { status: 'signed_in_required', error: 'Sign in to Reddit to brag about this win.' },
        };
    }
    const token = typeof input.shareToken === 'string' ? input.shareToken : '';
    const tokenKey = token ? headToHeadSharePreviewKey(PREFIX, token) : null;
    return submitHeadToHeadShareComment({ tokenKey, request, action: 'brag' });
}
