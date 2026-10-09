import { redis } from '@devvit/redis';
import { formatUtcChallengeDate } from '../daily/daily-gp-model.js';
import { playerFieldHash } from '../redis/redis-names.js';
import { safelyDiscard, safelyUnwatch } from '../redis/redis-lock.js';
import { isRedisTransactionConflict } from '../redis/redis-transaction-conflict.js';

// The UTC day each player last raced, keyed like ghost rows (`playerFieldHash` of the full player id).
// 64 small hashes, by the first character of that key, keep watch conflicts rare and are easy to name.

const KEY_PREFIX = 'miniracer:last-raced:v1';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const LAST_RACED_BUCKET_KEYS: readonly string[] = [...BASE64URL].map((char) => `${KEY_PREFIX}:${char}`);
export const LAST_RACED_KEY_PREFIX = KEY_PREFIX;

export function lastRacedBucketKey(field: string): string {
    return `${KEY_PREFIX}:${field[0]}`;
}

// A later day only; days are YYYY-MM-DD, so text order is day order.
function isLater(day: string, stored: string | null | undefined): boolean {
    return typeof stored !== 'string' || day > stored;
}

// Raises the player's day, never lowers it; a lost race skips, and the next event tries again.
export async function bumpLastRaced(playerId: string, day = formatUtcChallengeDate()): Promise<boolean> {
    const field = playerFieldHash(playerId);
    const key = lastRacedBucketKey(field);
    if (!isLater(day, await redis.hGet(key, field))) return false;
    const transaction = await redis.watch(key);
    try {
        // Transaction-client reads queue; read the base client.
        if (!isLater(day, await redis.hGet(key, field))) {
            await safelyUnwatch(transaction);
            return false;
        }
        await transaction.multi();
        await transaction.hSet(key, { [field]: day });
        const results = await transaction.exec();
        return Array.isArray(results) && results.length > 0;
    } catch (error) {
        await safelyDiscard(transaction);
        if (isRedisTransactionConflict(error)) return false;
        throw error;
    }
}

// Each ghost row key's day, or null when the record has none.
export async function readLastRacedDays(fields: readonly string[]): Promise<Map<string, string | null>> {
    const byBucket = new Map<string, string[]>();
    for (const field of new Set(fields)) {
        const key = lastRacedBucketKey(field);
        byBucket.set(key, [...(byBucket.get(key) ?? []), field]);
    }
    const days = new Map<string, string | null>();
    await Promise.all([...byBucket].map(async ([key, bucketFields]) => {
        const values = await redis.hMGet(key, bucketFields);
        bucketFields.forEach((field, index) => days.set(field, values[index] ?? null));
    }));
    return days;
}

export function lastRacedBucketKeysFor(fields: readonly string[]): string[] {
    return [...new Set(fields.map(lastRacedBucketKey))];
}
