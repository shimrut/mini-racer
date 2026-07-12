import { redis } from '@devvit/redis';
import { reddit } from '@devvit/web/server';

const COMMUNITY_MEMBER_COUNT_CACHE_TTL_MS = 5 * 60 * 1000;

function coerceCommunityMemberCount(raw: unknown): number | undefined {
    if (raw == null) {
        return undefined;
    }
    const count = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(count) || count < 1) {
        return undefined;
    }
    return Math.min(Math.trunc(count), 1_000_000);
}

function createCommunityMemberCountCacheKey({
    subredditId,
    subredditName,
}: {
    subredditId?: string | null;
    subredditName?: string | null;
}): string | null {
    if (subredditId) {
        return `dailygp:community-member-count:id:${subredditId}`;
    }
    if (subredditName) {
        return `dailygp:community-member-count:name:${subredditName.toLowerCase()}`;
    }
    return null;
}

export async function getCommunityMemberCount({
    subredditId,
    subredditName,
}: {
    subredditId?: string | null;
    subredditName?: string | null;
}): Promise<number | undefined> {
    const cacheKey = createCommunityMemberCountCacheKey({ subredditId, subredditName });
    if (!cacheKey) {
        return undefined;
    }

    try {
        const cachedCount = coerceCommunityMemberCount(await redis.get(cacheKey));
        if (cachedCount != null) {
            return cachedCount;
        }
    } catch (error) {
        console.error('Failed to read cached leaderboard community size:', error);
    }

    try {
        const info = subredditId
            ? await reddit.getSubredditInfoById(subredditId as `t5_${string}`)
            : await reddit.getSubredditInfoByName(String(subredditName));
        const count = coerceCommunityMemberCount(info?.subscribersCount);
        if (count == null) {
            return undefined;
        }

        try {
            await redis.set(cacheKey, String(count), {
                expiration: new Date(Date.now() + COMMUNITY_MEMBER_COUNT_CACHE_TTL_MS),
            });
        } catch (error) {
            console.error('Failed to cache leaderboard community size:', error);
        }
        return count;
    } catch (error) {
        console.error('Failed to fetch leaderboard community size:', error);
        return undefined;
    }
}
