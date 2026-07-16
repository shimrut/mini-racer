import { reddit } from '@devvit/web/server';
import { getCommunityMemberCount } from './community-member-count.js';
import {
    readContextPostId,
    readContextSubredditId,
    readContextSubredditName,
} from './request-context.js';

export type PostSubredditContext = {
    id?: `t5_${string}`;
    name?: string;
};

export async function getPostSubredditContext(): Promise<PostSubredditContext | null> {
    const postId = readContextPostId();
    if (!postId) {
        return null;
    }

    try {
        const post = await reddit.getPostById(postId as `t3_${string}`);
        return {
            id: typeof post?.subredditId === 'string' && post.subredditId.startsWith('t5_')
                ? post.subredditId as `t5_${string}`
                : undefined,
            name: typeof post?.subredditName === 'string' && post.subredditName.trim()
                ? post.subredditName.trim()
                : undefined,
        };
    } catch (error) {
        console.error('getPostById failed for leaderboard community context:', error);
        return null;
    }
}

export async function getCommunityMemberTotalForLeaderboard(): Promise<number | undefined> {
    let subredditId = readContextSubredditId();
    let subredditName = readContextSubredditName();
    if (!subredditId && !subredditName) {
        const postSubreddit = await getPostSubredditContext();
        subredditId = postSubreddit?.id || null;
        subredditName = postSubreddit?.name || null;
    }
    return getCommunityMemberCount({ subredditId, subredditName });
}
