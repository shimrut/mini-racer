import { redis } from '@devvit/web/server';
import {
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from '../redis/redis-lock.js';
import { acquireRedisLockWithRetry } from '../redis/redis-lock-retry.js';

const AUTOPOST_SUBSCRIPTION_LOCK_TTL_MS = 30_000;
const AUTOPOST_SUBSCRIPTION_LOCK_RETRY_DELAYS_MS = [5, 5, 5, 5];

export type AutopostSubscription = {
    subredditName: string;
    enabled: boolean;
    enabledAt: string | null;
    updatedAt: string;
    lastPostedChallengeId: string | null;
    lastPostedAt: string | null;
    lastPostUrl: string | null;
};

export function parseAutopostSubscription(
    subredditName: string,
    raw: string | null | undefined,
): AutopostSubscription | null {
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        return {
            subredditName,
            enabled: parsed.enabled !== false,
            enabledAt: typeof parsed.enabledAt === 'string' && parsed.enabledAt ? parsed.enabledAt : null,
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
            lastPostedChallengeId: typeof parsed.lastPostedChallengeId === 'string' && parsed.lastPostedChallengeId
                ? parsed.lastPostedChallengeId
                : null,
            lastPostedAt: typeof parsed.lastPostedAt === 'string' && parsed.lastPostedAt
                ? parsed.lastPostedAt
                : null,
            lastPostUrl: typeof parsed.lastPostUrl === 'string' && parsed.lastPostUrl
                ? parsed.lastPostUrl
                : null,
        };
    } catch (_error) {
        return null;
    }
}

class AutopostSubscriptionBusyError extends Error {}

export function createAutopostSubscriptionStore({
    subredditsKey,
    lockKeyPrefix,
    label,
}: {
    subredditsKey: string;
    lockKeyPrefix: string;
    label: string;
}) {
    async function readSubscription(subredditName: string): Promise<AutopostSubscription | null> {
        const raw = await redis.hGet(subredditsKey, subredditName);
        return parseAutopostSubscription(subredditName, raw);
    }

    async function readAllSubscriptions(): Promise<AutopostSubscription[]> {
        const rawMap = await redis.hGetAll(subredditsKey);
        return Object.entries(rawMap)
            .map(([subredditName, raw]) => parseAutopostSubscription(subredditName, raw))
            .filter((entry): entry is AutopostSubscription => Boolean(entry));
    }

    async function acquireLock(subredditName: string): Promise<RedisLock> {
        const lock = await acquireRedisLockWithRetry(
            `${lockKeyPrefix}${subredditName.trim().toLowerCase()}`,
            AUTOPOST_SUBSCRIPTION_LOCK_TTL_MS,
            AUTOPOST_SUBSCRIPTION_LOCK_RETRY_DELAYS_MS,
            redis,
        );
        if (lock) return lock;
        throw new AutopostSubscriptionBusyError(
            `${label} subscription update is already in progress.`,
        );
    }

    async function releaseLock(lock: RedisLock): Promise<void> {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error(`${label} subscription lock cleanup failed:`, error);
        });
    }

    async function writeSubscription(subscription: AutopostSubscription, lock: RedisLock): Promise<void> {
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) {
            throw new AutopostSubscriptionBusyError(`${label} subscription lock was lost.`);
        }
        await transaction.hSet(
            subredditsKey,
            { [subscription.subredditName]: JSON.stringify(subscription) },
        );
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            throw new AutopostSubscriptionBusyError(
                `${label} subscription save was interrupted.`,
            );
        }
    }

    async function deleteSubscription(subredditName: string): Promise<void> {
        const lock = await acquireLock(subredditName);
        try {
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) {
                throw new AutopostSubscriptionBusyError(`${label} subscription lock was lost.`);
            }
            await transaction.hDel(subredditsKey, [subredditName]);
            const results = await transaction.exec();
            if (!Array.isArray(results) || results.length === 0) {
                throw new AutopostSubscriptionBusyError(
                    `${label} subscription delete was interrupted.`,
                );
            }
        } finally {
            await releaseLock(lock);
        }
    }

    async function upsertSubscription(
        subredditName: string,
        updater: (previous: AutopostSubscription | null) => AutopostSubscription,
    ): Promise<AutopostSubscription> {
        const lock = await acquireLock(subredditName);
        try {
            const previous = await readSubscription(subredditName);
            const next = updater(previous);
            await writeSubscription(next, lock);
            return next;
        } finally {
            await releaseLock(lock);
        }
    }

    return {
        readSubscription,
        readAllSubscriptions,
        deleteSubscription,
        upsertSubscription,
    };
}
