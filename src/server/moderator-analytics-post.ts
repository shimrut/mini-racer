import { reddit, redis } from '@devvit/web/server';
import {
    readContextPostData,
    readContextSubredditName,
} from './request-context.js';

export const MOD_ANALYTICS_POSTS_KEY = 'dailygp:mod-analytics:posts';

export type ModAnalyticsPostRecord = {
    subredditName: string;
    postId: `t3_${string}` | null;
    postUrl: string | null;
    updatedAt: string;
};

export function parseModAnalyticsPostRecord(
    subredditName: string,
    raw: string | null | undefined,
): ModAnalyticsPostRecord | null {
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const postId = typeof parsed.postId === 'string' && parsed.postId.startsWith('t3_')
            ? parsed.postId as `t3_${string}`
            : null;
        const postUrl = typeof parsed.postUrl === 'string' && parsed.postUrl.trim()
            ? parsed.postUrl.trim()
            : null;

        return {
            subredditName,
            postId,
            postUrl,
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
        };
    } catch (_error) {
        return null;
    }
}

export async function readModAnalyticsPostRecord(
    subredditName: string,
): Promise<ModAnalyticsPostRecord | null> {
    const raw = await redis.hGet(MOD_ANALYTICS_POSTS_KEY, subredditName);
    return parseModAnalyticsPostRecord(subredditName, raw);
}

export async function writeModAnalyticsPostRecord(record: ModAnalyticsPostRecord): Promise<void> {
    await redis.hSet(
        MOD_ANALYTICS_POSTS_KEY,
        { [record.subredditName]: JSON.stringify(record) },
    );
}

async function submitModeratorAnalyticsPost(subredditName: string) {
    const post = await reddit.submitCustomPost({
        subredditName,
        title: 'Mini Racer Moderator Analytics',
        entry: 'mod-analytics',
        sendreplies: false,
        postData: {
            tool: 'mod-analytics',
            subredditName,
        },
        textFallback: {
            text: [
                '# Mini Racer Moderator Analytics',
                '',
                `Subreddit: r/${subredditName}`,
                '',
                'This custom post hosts the moderator-only Mini Racer summary.',
                'Open it from the subreddit moderator menu.',
            ].join('\n'),
        },
    });

    try {
        await post.lock();
    } catch (error) {
        console.error(`Failed to lock moderator analytics post for r/${subredditName}:`, error);
    }

    try {
        await post.remove(false);
    } catch (error) {
        console.error(`Failed to remove moderator analytics post for r/${subredditName}:`, error);
    }

    return post;
}

export async function resolveAnalyticsToolSubredditName(): Promise<string | null> {
    const contextName = readContextSubredditName();
    if (contextName) {
        return contextName;
    }

    const postDataName = readContextPostData()?.subredditName;
    if (typeof postDataName === 'string' && postDataName.trim()) {
        return postDataName.trim();
    }

    return null;
}

export async function ensureModeratorAnalyticsPostForSubreddit(
    subredditName: string,
): Promise<{ created: boolean; postUrl: string | null }> {
    const current = await readModAnalyticsPostRecord(subredditName);
    if (current?.postId) {
        try {
            const post = await reddit.getPostById(current.postId);
            const postUrl = typeof post?.url === 'string' && post.url.trim()
                ? post.url.trim()
                : current.postUrl;
            if (postUrl) {
                if (postUrl !== current.postUrl) {
                    await writeModAnalyticsPostRecord({
                        subredditName,
                        postId: current.postId,
                        postUrl,
                        updatedAt: new Date().toISOString(),
                    });
                }
                return { created: false, postUrl };
            }
        } catch (error) {
            console.error(`Stored moderator analytics post lookup failed for r/${subredditName}:`, error);
        }
    }

    const post = await submitModeratorAnalyticsPost(subredditName);
    const postId = typeof post.id === 'string' && post.id.startsWith('t3_')
        ? post.id as `t3_${string}`
        : null;
    const postUrl = typeof post.url === 'string' && post.url.trim()
        ? post.url.trim()
        : null;

    await writeModAnalyticsPostRecord({
        subredditName,
        postId,
        postUrl,
        updatedAt: new Date().toISOString(),
    });

    return {
        created: true,
        postUrl,
    };
}
