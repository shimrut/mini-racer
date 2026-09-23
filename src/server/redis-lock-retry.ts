import { redis, type RedisClient } from '@devvit/redis';
import { acquireRedisLock, type RedisLock } from './redis-lock.js';

export async function acquireRedisLockWithRetry(
    key: string,
    ttlMs: number,
    retryDelaysMs: readonly number[],
    client: RedisClient = redis,
): Promise<RedisLock | null> {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        const lock = await acquireRedisLock(key, ttlMs, client);
        if (lock) return lock;
        if (attempt < retryDelaysMs.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        }
    }
    return null;
}
