import { reddit } from '@devvit/web/server';
import type { DailyGpChallenge } from './daily-gp-model.js';
import {
    ensureDailyGpScoreThread,
    registerDailyGpPostWithScoreThread,
    resolveDailyGpPostRecord,
} from './daily-gp-share.js';
import {
    acquireDailyGpPostCreationLock,
    releaseDailyGpPostCreationLock,
} from './daily-gp-post-store.js';
import {
    formatDailyMiniRacerPostTitle,
    formatDailyMiniRacerTextFallback,
} from './reddit-post-title.js';
import {
    readDailyAutopostSubscription,
    upsertDailyAutopostSubscription,
} from './daily-autopost-store.js';
import {
    getRequestAppSlug,
    getRequestUsername,
    readContextSubredditName,
} from './request-context.js';

export type DailyPostResult = {
    created: boolean;
    postUrl: string | null;
};

export async function enableDailyAutopost(subredditName: string): Promise<void> {
    await upsertDailyAutopostSubscription(subredditName, (previous) => ({
        subredditName,
        enabled: true,
        enabledAt: previous?.enabledAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastPostedChallengeId: previous?.lastPostedChallengeId ?? null,
        lastPostedAt: previous?.lastPostedAt ?? null,
        lastPostUrl: previous?.lastPostUrl ?? null,
    }));
}

async function submitDailyMiniRacerPost(
    subredditName: string,
    challenge: DailyGpChallenge,
    appSlug: string,
) {
    const post = await reddit.submitCustomPost({
        subredditName,
        title: formatDailyMiniRacerPostTitle(challenge),
        entry: 'default',
        postData: {
            challengeId: challenge.id,
            challenge,
        },
        textFallback: {
            text: formatDailyMiniRacerTextFallback(challenge),
        },
    });
    if (typeof post.id !== 'string' || !post.id.startsWith('t3_') || typeof post.url !== 'string') {
        throw new Error('Reddit did not return the daily post identity.');
    }
    await registerDailyGpPostWithScoreThread({
        subredditName,
        challengeId: challenge.id,
        postId: post.id as `t3_${string}`,
        postUrl: post.url,
        appSlug,
    });
    return post;
}

export async function ensureDailyMiniRacerPostForSubreddit(
    subredditName: string,
    challenge: DailyGpChallenge,
): Promise<DailyPostResult> {
    const current = await readDailyAutopostSubscription(subredditName);
    const appSlug = getRequestAppSlug();
    if (!appSlug) {
        throw new Error('Reddit did not provide the Mini Racer app identity.');
    }
    const existing = await resolveDailyGpPostRecord({
        subredditName,
        challengeId: challenge.id,
        appSlug,
        preferredPostUrl: current?.lastPostedChallengeId === challenge.id ? current.lastPostUrl : null,
    });
    if (existing) {
        await ensureDailyGpScoreThread(existing, appSlug);
        await upsertDailyAutopostSubscription(subredditName, (previous) => ({
            subredditName,
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: new Date().toISOString(),
            lastPostedChallengeId: challenge.id,
            lastPostedAt: previous?.lastPostedChallengeId === challenge.id
                ? previous.lastPostedAt
                : existing.createdAt,
            lastPostUrl: existing.postUrl,
        }));
        return {
            created: false,
            postUrl: existing.postUrl,
        };
    }

    const lock = await acquireDailyGpPostCreationLock(subredditName, challenge.id);
    if (!lock) {
        const raced = await resolveDailyGpPostRecord({ subredditName, challengeId: challenge.id, appSlug });
        if (raced) {
            const prepared = await ensureDailyGpScoreThread(raced, appSlug);
            return { created: false, postUrl: prepared.postUrl };
        }
        throw new Error('Today\'s Mini Racer post is already being created.');
    }
    try {
        const raced = await resolveDailyGpPostRecord({ subredditName, challengeId: challenge.id, appSlug });
        if (raced) {
            const prepared = await ensureDailyGpScoreThread(raced, appSlug);
            return { created: false, postUrl: prepared.postUrl };
        }
        const post = await submitDailyMiniRacerPost(subredditName, challenge, appSlug);
        await upsertDailyAutopostSubscription(subredditName, (previous) => ({
            subredditName,
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: new Date().toISOString(),
            lastPostedChallengeId: challenge.id,
            lastPostedAt: new Date().toISOString(),
            lastPostUrl: post.url,
        }));
        return { created: true, postUrl: post.url };
    } finally {
        await releaseDailyGpPostCreationLock(lock);
    }
}

export async function getDailyGpShareRequestContext(): Promise<Record<string, unknown>> {
    const subredditName = readContextSubredditName();
    const subscription = subredditName
        ? await readDailyAutopostSubscription(subredditName)
        : null;
    return {
        username: getRequestUsername(),
        subredditName,
        appSlug: getRequestAppSlug(),
        preferredPostUrl: subscription?.lastPostUrl ?? null,
    };
}
