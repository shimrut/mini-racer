import { context } from '@devvit/web/server';
import { createRequestRateLimitIdentity } from './request-rate-limit-identity.js';

export function getRequestUsername(): string | null {
    return typeof context.username === 'string' && context.username.trim()
        ? context.username.trim()
        : null;
}

export function getRequestUserId(): string | null {
    const id = typeof context.userId === 'string' ? context.userId.trim() : '';
    return id.startsWith('t2_') ? id : null;
}

export function getRequestAnalyticsViewerIdentity(): string | null {
    const userId = getRequestUserId();
    if (userId) return `user:${userId}`;
    const loid = typeof context.loid === 'string' ? context.loid.trim() : '';
    return loid ? `loid:${loid}` : null;
}

export function getRequestRateLimitIdentity(): string | null {
    return createRequestRateLimitIdentity({
        loid: context.loid,
        userId: context.userId,
    });
}

export function getRequestAppSlug(): string | null {
    const appSlug = (context as { appSlug?: unknown }).appSlug;
    return typeof appSlug === 'string' && appSlug.trim() ? appSlug.trim() : null;
}

export function readContextSubredditName(): string | null {
    const name = (context as { subredditName?: unknown }).subredditName;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
}

export function readContextPostId(): string | null {
    const id = (context as { postId?: unknown }).postId;
    return typeof id === 'string' && id.startsWith('t3_') ? id : null;
}

export function readContextPostData(): Record<string, unknown> | null {
    const postData = (context as { postData?: unknown }).postData;
    return postData && typeof postData === 'object'
        ? postData as Record<string, unknown>
        : null;
}
