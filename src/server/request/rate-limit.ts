import { redis } from '@devvit/redis';

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function checkFixedWindowRateLimit(
    key: string,
    maxRequests: number,
    windowSeconds: number,
): Promise<RateLimitResult> {
    const attemptCount = await redis.incrBy(key, 1);
    if (attemptCount === 1) {
        await redis.expire(key, windowSeconds);
    }
    if (attemptCount <= maxRequests) {
        return { allowed: true };
    }
    const expiresAt = await redis.expireTime(key);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, expiresAt - Math.floor(Date.now() / 1000)),
        };
    }
    await redis.expire(key, windowSeconds);
    return { allowed: false, retryAfterSeconds: windowSeconds };
}
