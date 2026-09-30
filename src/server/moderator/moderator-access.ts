import { reddit } from '@devvit/web/server';
import { cacheSharedJson } from '../redis/shared-cache.js';
import {
    getRequestUsername,
    readContextSubredditName,
} from '../request/request-context.js';

export async function resolveMenuTargetSubredditName(targetId: string): Promise<string | null> {
    const subredditInfo = targetId.startsWith('t5_')
        ? await reddit.getSubredditInfoById(targetId as `t5_${string}`)
        : null;
    const subredditName = subredditInfo?.name || readContextSubredditName();
    return typeof subredditName === 'string' && subredditName.trim()
        ? subredditName.trim()
        : null;
}

// Every Creator request checks the moderator, and the moderator list costs two
// calls to Reddit. The list is shared for a few minutes, so a moderator added
// or removed on Reddit counts here within that time. A failed read is not kept.
const MODERATOR_LIST_TTL_SECONDS = 5 * 60;

async function readModeratorNames(subredditName: string): Promise<string[]> {
    return cacheSharedJson(async () => {
        const subreddit = await reddit.getSubredditByName(subredditName);
        const moderators = await subreddit.getModerators({ limit: 1000, pageSize: 100 }).all();
        return moderators.flatMap((moderator) => (
            typeof moderator?.username === 'string' ? [moderator.username.trim().toLowerCase()] : []
        ));
    }, {
        key: `mini-racer:moderators:v1:${subredditName.trim().toLowerCase()}`,
        ttl: MODERATOR_LIST_TTL_SECONDS,
    });
}

export async function isModeratorForSubreddit(
    subredditName: string,
    username: string,
): Promise<boolean> {
    try {
        const names = await readModeratorNames(subredditName);
        return names.includes(username.trim().toLowerCase());
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
