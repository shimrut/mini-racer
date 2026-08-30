import { redis } from '@devvit/redis';
import { acquireRedisLock, releaseRedisLock, type RedisLock } from './redis-lock.js';

export const LAUNCHER_POST_CREATE_CLAIM_TTL_MS = 15 * 60 * 1000;

export type LauncherPostKind = 'daily' | 'campaign' | 'lobby';

export type LauncherPostRecord = {
    subredditName: string;
    kind: LauncherPostKind;
    postId: `t3_${string}`;
    postUrl: string;
    createdAt: string;
};

export const LAUNCHER_POSTS_KEY = 'miniracer:launcher-posts';

function normalizeSubredditName(subredditName: string): string {
    return subredditName.trim().toLowerCase();
}

function parseLauncherPostRecord(raw: string | null): LauncherPostRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<LauncherPostRecord>;
        if (
            typeof parsed.subredditName !== 'string'
            || (parsed.kind !== 'daily' && parsed.kind !== 'campaign' && parsed.kind !== 'lobby')
            || typeof parsed.postId !== 'string'
            || !parsed.postId.startsWith('t3_')
            || typeof parsed.postUrl !== 'string'
            || !parsed.postUrl
        ) {
            return null;
        }
        return {
            subredditName: parsed.subredditName,
            kind: parsed.kind,
            postId: parsed.postId as `t3_${string}`,
            postUrl: parsed.postUrl,
            createdAt: typeof parsed.createdAt === 'string'
                ? parsed.createdAt
                : new Date(0).toISOString(),
        };
    } catch (_error) {
        return null;
    }
}

function launcherField(subredditName: string, kind: LauncherPostKind): string {
    return `${normalizeSubredditName(subredditName)}:${kind}`;
}

function launcherLockKey(subredditName: string, kind: LauncherPostKind): string {
    return `miniracer:launcher-post-create-lock:${normalizeSubredditName(subredditName)}:${kind}`;
}

export async function readLauncherPostRecord(
    subredditName: string,
    kind: LauncherPostKind,
): Promise<LauncherPostRecord | null> {
    return parseLauncherPostRecord(
        await redis.hGet(LAUNCHER_POSTS_KEY, launcherField(subredditName, kind)),
    );
}

export async function writeLauncherPostRecord(record: LauncherPostRecord): Promise<void> {
    await redis.hSet(
        LAUNCHER_POSTS_KEY,
        { [launcherField(record.subredditName, record.kind)]: JSON.stringify(record) },
    );
}

export async function acquireLauncherPostCreationLock(
    subredditName: string,
    kind: LauncherPostKind,
): Promise<RedisLock | null> {
    return acquireRedisLock(
        launcherLockKey(subredditName, kind),
        LAUNCHER_POST_CREATE_CLAIM_TTL_MS,
        redis,
    );
}

export async function releaseLauncherPostCreationLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
}
