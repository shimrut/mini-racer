import { reddit } from '@devvit/web/server';
import { isRedditAvatarUrl } from '../../../game/shared/reddit-avatar.js';
import { cacheSharedJson } from '../redis/shared-cache.js';

const SNOOVATAR_CACHE_TTL_SECONDS = 60 * 60;
const SNOOVATAR_CACHE_KEY_PREFIX = 'mini-racer:snoovatar:v1:';

export async function resolveRedditAvatarUrl(displayName: string): Promise<string | null> {
    const username = displayName.trim().replace(/^u\//i, '').trim();
    const cacheUsername = username.toLowerCase();
    if (!cacheUsername) return null;

    try {
        return await cacheSharedJson(async () => {
            const avatarUrl = await reddit.getSnoovatarUrl(username);
            return isRedditAvatarUrl(avatarUrl) ? avatarUrl : null;
        }, {
            key: `${SNOOVATAR_CACHE_KEY_PREFIX}${encodeURIComponent(cacheUsername)}`,
            ttl: SNOOVATAR_CACHE_TTL_SECONDS,
        });
    } catch {
        return null;
    }
}
