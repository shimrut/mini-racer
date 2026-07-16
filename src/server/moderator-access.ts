import { reddit } from '@devvit/web/server';
import {
    getRequestUsername,
    readContextSubredditName,
} from './request-context.js';

export async function resolveMenuTargetSubredditName(targetId: string): Promise<string | null> {
    const subredditInfo = targetId.startsWith('t5_')
        ? await reddit.getSubredditInfoById(targetId as `t5_${string}`)
        : null;
    const subredditName = subredditInfo?.name || readContextSubredditName();
    return typeof subredditName === 'string' && subredditName.trim()
        ? subredditName.trim()
        : null;
}

export async function isModeratorForSubreddit(
    subredditName: string,
    username: string,
): Promise<boolean> {
    try {
        const subreddit = await reddit.getSubredditByName(subredditName);
        const moderators = await subreddit.getModerators({ limit: 1000, pageSize: 100 }).all();
        return moderators.some((moderator) => (
            typeof moderator?.username === 'string'
            && moderator.username.trim().toLowerCase() === username.trim().toLowerCase()
        ));
    } catch (error) {
        console.error(`Failed to verify moderator access for r/${subredditName}:`, error);
        return false;
    }
}

export async function assertModeratorForSubreddit(subredditName: string): Promise<string> {
    const username = getRequestUsername();
    if (!username) {
        throw new Error('Reddit did not provide the acting username.');
    }

    const isModerator = await isModeratorForSubreddit(subredditName, username);
    if (!isModerator) {
        throw new Error(`Moderator access required for r/${subredditName}.`);
    }

    return username;
}
