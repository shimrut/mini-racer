import { redis } from '@devvit/redis';
import { randomUUID } from 'node:crypto';
import { DAILY_GP_REDIS_TTL_SECONDS } from './daily-gp-model.js';

/** How long a create-claim may sit if the winner crashes before release. */
export const DAILY_GP_POST_CREATE_CLAIM_TTL_MS = 15 * 60 * 1000;

export type DailyGpPostRecord = {
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
    scoreThreadCommentId: `t1_${string}` | null;
    createdAt: string;
    updatedAt: string;
};

type DailyGpPostCreationLock = { key: string; value: string };

function createPostRecordExpiration(): Date {
    return new Date(Date.now() + (DAILY_GP_REDIS_TTL_SECONDS * 1000));
}

function normalizeSubredditName(subredditName: string): string {
    return subredditName.trim().toLowerCase();
}

function createPostRecordKey(subredditName: string, challengeId: string): string {
    return `dailygp:post:${normalizeSubredditName(subredditName)}:${challengeId}`;
}

function createPostCreationLockKey(subredditName: string, challengeId: string): string {
    return `dailygp:post-create-lock:${normalizeSubredditName(subredditName)}:${challengeId}`;
}

function parsePostRecord(raw: string | null): DailyGpPostRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<DailyGpPostRecord>;
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
            scoreThreadCommentId: typeof parsed.scoreThreadCommentId === 'string'
                && parsed.scoreThreadCommentId.startsWith('t1_')
                ? parsed.scoreThreadCommentId as `t1_${string}`
                : null,
            createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
        };
    } catch (_error) {
        return null;
    }
}

export async function readDailyGpPostRecord(
    subredditName: string,
    challengeId: string,
): Promise<DailyGpPostRecord | null> {
    return parsePostRecord(await redis.get(createPostRecordKey(subredditName, challengeId)));
}

export async function writeDailyGpPostRecord(record: DailyGpPostRecord): Promise<void> {
    const key = createPostRecordKey(record.subredditName, record.challengeId);
    await redis.set(key, JSON.stringify(record));
    await redis.expire(key, DAILY_GP_REDIS_TTL_SECONDS);
}

/** First-writer-wins create. Returns false if a record already exists. */
export async function writeDailyGpPostRecordIfAbsent(record: DailyGpPostRecord): Promise<boolean> {
    const key = createPostRecordKey(record.subredditName, record.challengeId);
    const result = await redis.set(key, JSON.stringify(record), {
        nx: true,
        expiration: createPostRecordExpiration(),
    });
    return Boolean(result);
}

export async function acquireDailyGpPostCreationLock(
    subredditName: string,
    challengeId: string,
): Promise<DailyGpPostCreationLock | null> {
    const key = createPostCreationLockKey(subredditName, challengeId);
    const value = randomUUID();
    const acquired = await redis.set(key, value, {
        nx: true,
        expiration: new Date(Date.now() + DAILY_GP_POST_CREATE_CLAIM_TTL_MS),
    });
    return acquired ? { key, value } : null;
}

export async function releaseDailyGpPostCreationLock(
    lock: DailyGpPostCreationLock | null,
): Promise<void> {
    if (!lock) return;
    if (await redis.get(lock.key) === lock.value) {
        await redis.del(lock.key);
    }
}
