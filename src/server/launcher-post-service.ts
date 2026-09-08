import { reddit } from '@devvit/web/server';
import {
    acquireLauncherPostCreationLock,
    readLauncherPostRecord,
    releaseLauncherPostCreationLock,
    writeLauncherPostRecord,
    type LauncherPostKind,
} from './launcher-post-store.js';
import {
    getRequestAppSlug,
} from './request-context.js';
import { resolveMiniRacerPostFlairId } from './post-flair-service.js';

type LauncherPostConfig = {
    entry: 'daily' | 'campaign' | 'game';
    postType: 'daily-launcher' | 'campaign-launcher' | 'lobby-launcher';
    launchMode: 'daily' | 'campaign' | 'home';
    title: string;
    fallback: string;
};

export type LauncherPostResult = {
    created: boolean;
    postUrl: string;
};

const LAUNCHER_POST_CONFIG: Record<LauncherPostKind, LauncherPostConfig> = {
    daily: {
        entry: 'daily',
        postType: 'daily-launcher',
        launchMode: 'daily',
        title: 'Mini Racer Daily',
        fallback: [
            '# Mini Racer Daily',
            '',
            'This post always shows today\'s featured track.',
            '',
            'Open it on Reddit and select **Race Today** to play in Daily mode.',
        ].join('\n'),
    },
    campaign: {
        entry: 'campaign',
        postType: 'campaign-launcher',
        launchMode: 'campaign',
        title: 'Mini Racer Campaign',
        fallback: [
            '# Mini Racer Campaign',
            '',
            'Race the permanent Mini Racer stage series and unlock the next challenge.',
            '',
            'Open it on Reddit and select **Race Campaign** to play.',
        ].join('\n'),
    },
    lobby: {
        entry: 'game',
        postType: 'lobby-launcher',
        launchMode: 'home',
        title: 'Mini Racer Lobby',
        fallback: [
            '# Mini Racer Lobby',
            '',
            'Open the Mini Racer lobby to choose Daily, Campaign, or Garage.',
        ].join('\n'),
    },
};

function requireAppSlug(): void {
    if (!getRequestAppSlug()) {
        throw new Error('Reddit did not provide the Mini Racer app identity.');
    }
}

async function submitLauncherPost(
    subredditName: string,
    kind: LauncherPostKind,
) {
    const config = LAUNCHER_POST_CONFIG[kind];
    const flairId = await resolveMiniRacerPostFlairId(subredditName, config.postType);
    const post = await reddit.submitCustomPost({
        subredditName,
        title: config.title,
        flairId,
        entry: config.entry,
        postData: {
            postType: config.postType,
            launchMode: config.launchMode,
        },
        textFallback: { text: config.fallback },
    });
    if (typeof post.id !== 'string' || !post.id.startsWith('t3_') || typeof post.url !== 'string') {
        throw new Error(`Reddit did not return the ${kind} launcher post identity.`);
    }
    return post;
}

export async function ensureMiniRacerLauncherPostForSubreddit(
    subredditName: string,
    kind: LauncherPostKind,
): Promise<LauncherPostResult> {
    requireAppSlug();
    const existing = await readLauncherPostRecord(subredditName, kind);
    if (existing) return { created: false, postUrl: existing.postUrl };

    const lock = await acquireLauncherPostCreationLock(subredditName, kind);
    if (!lock) {
        const raced = await readLauncherPostRecord(subredditName, kind);
        if (raced) return { created: false, postUrl: raced.postUrl };
        throw new Error(`The Mini Racer ${kind} launcher post is already being created.`);
    }

    try {
        const raced = await readLauncherPostRecord(subredditName, kind);
        if (raced) return { created: false, postUrl: raced.postUrl };
        const post = await submitLauncherPost(subredditName, kind);
        await writeLauncherPostRecord({
            subredditName,
            kind,
            postId: post.id as `t3_${string}`,
            postUrl: post.url,
            createdAt: new Date().toISOString(),
        });
        return { created: true, postUrl: post.url };
    } finally {
        await releaseLauncherPostCreationLock(lock);
    }
}
