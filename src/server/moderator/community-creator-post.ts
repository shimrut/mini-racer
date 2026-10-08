import { reddit, redis } from '@devvit/web/server';
import { readContextPostData, readContextSubredditName } from '../request/request-context.js';
import { acquireRedisLock, releaseRedisLock } from '../redis/redis-lock.js';

const CREATOR_POSTS_KEY = 'dailygp:community:creator-posts:v1';

type CreatorPostRecord = {
    postId: `t3_${string}`;
    postUrl: string;
};

function parseRecord(raw: string | null | undefined): CreatorPostRecord | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw);
        return typeof value?.postId === 'string' && value.postId.startsWith('t3_')
            && typeof value.postUrl === 'string' && value.postUrl
            ? value as CreatorPostRecord : null;
    } catch {
        return null;
    }
}

export function resolveCreatorToolSubredditName(): string | null {
    const postData = readContextPostData();
    const fromContext = readContextSubredditName();
    // Some requests omit postData; the signed subreddit still scopes them, and every route checks the moderator.
    if (!postData) return fromContext;
    if (postData.tool !== 'community-creator') return null;
    const fromPost = typeof postData.subredditName === 'string' ? postData.subredditName.trim() : '';
    if (!fromPost || fromContext && fromContext.toLowerCase() !== fromPost.toLowerCase()) return null;
    return fromPost;
}

export async function ensureCommunityCreatorPostForSubreddit(subredditName: string): Promise<{
    created: boolean;
    postUrl: string | null;
}> {
    const field = subredditName.toLowerCase();
    const resolveExisting = async (): Promise<string | null> => {
        const current = parseRecord(await redis.hGet(CREATOR_POSTS_KEY, field));
        if (!current) return null;
        try {
            const post = await reddit.getPostById(current.postId);
            // A removed post stays in the small window. Reddit will not open it full screen.
            if (post?.removed) {
                try {
                    await post.approve();
                } catch (error) {
                    console.error(`Failed to restore Creator post for full screen:`, error);
                }
            }
            return typeof post?.url === 'string' && post.url.trim()
                ? post.url.trim() : current.postUrl;
        } catch (error) {
            console.error(`Stored Creator post lookup failed for r/${subredditName}:`, error);
            return null;
        }
    };
    const existingUrl = await resolveExisting();
    if (existingUrl) return { created: false, postUrl: existingUrl };

    const lock = await acquireRedisLock(`dailygp:community:creator-post-lock:v1:${field}`, 60_000);
    if (!lock) {
        return { created: false, postUrl: await resolveExisting() };
    }
    try {
        const currentUrl = await resolveExisting();
        if (currentUrl) return { created: false, postUrl: currentUrl };
        const post = await reddit.submitCustomPost({
            subredditName,
            title: 'Mini Racer Creator',
            entry: 'map-creator',
            sendreplies: false,
            postData: { tool: 'community-creator', subredditName },
            textFallback: {
                text: [
                    '# Mini Racer Creator',
                    '',
                    'Moderators open this tool from the subreddit menu to make tracks, the Daily list and Campaign series.',
                ].join('\n'),
            },
        });
        try {
            await post.lock();
        } catch (error) {
            console.error(`Failed to lock Creator post for r/${subredditName}:`, error);
        }
        const postId = typeof post.id === 'string' && post.id.startsWith('t3_')
            ? post.id as `t3_${string}` : null;
        const postUrl = typeof post.url === 'string' && post.url.trim() ? post.url.trim() : null;
        if (!postId || !postUrl) return { created: true, postUrl };
        await redis.hSet(CREATOR_POSTS_KEY, {
            [field]: JSON.stringify({ postId, postUrl }),
        });
        return { created: true, postUrl };
    } finally {
        try {
            await releaseRedisLock(lock);
        } catch (error) {
            console.error(`Failed to release Creator post lock for r/${subredditName}:`, error);
        }
    }
}
