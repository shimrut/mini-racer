import { redis } from '@devvit/redis';
import { randomUUID } from 'node:crypto';
import { DAILY_GP_REDIS_TTL_SECONDS } from './daily-gp-model.js';

export type DailyGpPodiumPostRecord = {
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
    createdAt: string;
};

type DailyGpPodiumPostCreationLock = { key: string; value: string };

function normalizeSubredditName(subredditName: string): string {
    return subredditName.trim().toLowerCase();
}

function createPodiumPostRecordKey(subredditName: string, challengeId: string): string {
    return `dailygp:podium-post:${normalizeSubredditName(subredditName)}:${challengeId}`;
}

function createPodiumPostCreationLockKey(subredditName: string, challengeId: string): string {
    return `dailygp:podium-post-create-lock:${normalizeSubredditName(subredditName)}:${challengeId}`;
}

function parsePodiumPostRecord(raw: string | null): DailyGpPodiumPostRecord | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as Partial<DailyGpPodiumPostRecord>;
        if (
            typeof parsed.subredditName !== 'string'
            || typeof parsed.challengeId !== 'string'
            || typeof parsed.postId !== 'string'
            || !parsed.postId.startsWith('t3_')
            || typeof parsed.postUrl !== 'string'
            || !parsed.postUrl
        ) {
            return null;
        }

        return {
            subredditName: parsed.subredditName,
            challengeId: parsed.challengeId,
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

export async function readDailyGpPodiumPostRecord(
    subredditName: string,
    challengeId: string,
): Promise<DailyGpPodiumPostRecord | null> {
    return parsePodiumPostRecord(
        await redis.get(createPodiumPostRecordKey(subredditName, challengeId)),
    );
}

export async function writeDailyGpPodiumPostRecord(
    record: DailyGpPodiumPostRecord,
): Promise<void> {
    const key = createPodiumPostRecordKey(record.subredditName, record.challengeId);
    await redis.set(key, JSON.stringify(record));
    await redis.expire(key, DAILY_GP_REDIS_TTL_SECONDS);
}

export async function acquireDailyGpPodiumPostCreationLock(
    subredditName: string,
    challengeId: string,
): Promise<DailyGpPodiumPostCreationLock | null> {
    const key = createPodiumPostCreationLockKey(subredditName, challengeId);
    const value = randomUUID();
    const acquired = await redis.set(key, value, {
        nx: true,
        expiration: new Date(Date.now() + 30_000),
    });
    return acquired ? { key, value } : null;
}

export async function releaseDailyGpPodiumPostCreationLock(
    lock: DailyGpPodiumPostCreationLock | null,
): Promise<void> {
    if (!lock) return;
    if (await redis.get(lock.key) === lock.value) {
        await redis.del(lock.key);
    }
}
