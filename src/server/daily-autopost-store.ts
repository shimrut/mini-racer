import { redis } from '@devvit/web/server';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from './redis-lock.js';

const DAILY_AUTPOST_SUBREDDITS_KEY = 'dailygp:autopost:subreddits';
const DAILY_AUTOPOST_SUBSCRIPTION_LOCK_TTL_MS = 30_000;
const DAILY_AUTOPOST_SUBSCRIPTION_LOCK_ATTEMPTS = 5;
const DAILY_AUTOPOST_SUBSCRIPTION_LOCK_RETRY_MS = 5;

export type DailyAutopostSubscription = {
    subredditName: string;
    enabled: boolean;
    enabledAt: string | null;
    updatedAt: string;
    lastPostedChallengeId: string | null;
    lastPostedAt: string | null;
    lastPostUrl: string | null;
};

export function parseDailyAutopostSubscription(
    subredditName: string,
    raw: string | null | undefined,
): DailyAutopostSubscription | null {
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

export async function readDailyAutopostSubscription(
    subredditName: string,
): Promise<DailyAutopostSubscription | null> {
    const raw = await redis.hGet(DAILY_AUTPOST_SUBREDDITS_KEY, subredditName);
    return parseDailyAutopostSubscription(subredditName, raw);
}

export async function readAllDailyAutopostSubscriptions(): Promise<DailyAutopostSubscription[]> {
    const rawMap = await redis.hGetAll(DAILY_AUTPOST_SUBREDDITS_KEY);
    return Object.entries(rawMap)
        .map(([subredditName, raw]) => parseDailyAutopostSubscription(subredditName, raw))
        .filter((entry): entry is DailyAutopostSubscription => Boolean(entry));
}

class DailyAutopostSubscriptionBusyError extends Error {}

function dailyAutopostSubscriptionLockKey(subredditName: string): string {
    return `dailygp:autopost:subscription-lock:${subredditName.trim().toLowerCase()}`;
}

async function acquireDailyAutopostSubscriptionLock(
    subredditName: string,
): Promise<RedisLock> {
    const key = dailyAutopostSubscriptionLockKey(subredditName);
    for (let attempt = 0; attempt < DAILY_AUTOPOST_SUBSCRIPTION_LOCK_ATTEMPTS; attempt += 1) {
        const lock = await acquireRedisLock(
            key,
            DAILY_AUTOPOST_SUBSCRIPTION_LOCK_TTL_MS,
            redis,
        );
        if (lock) return lock;
        if (attempt < DAILY_AUTOPOST_SUBSCRIPTION_LOCK_ATTEMPTS - 1) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, DAILY_AUTOPOST_SUBSCRIPTION_LOCK_RETRY_MS);
            });
        }
    }
    throw new DailyAutopostSubscriptionBusyError(
        'Daily autopost subscription update is already in progress.',
    );
}

async function writeDailyAutopostSubscription(
    subscription: DailyAutopostSubscription,
    lock: RedisLock,
): Promise<void> {
    const transaction = await beginOwnedRedisLockTransaction(lock, redis);
    if (!transaction) {
        throw new DailyAutopostSubscriptionBusyError('Daily autopost subscription lock was lost.');
    }
    await transaction.hSet(
        DAILY_AUTPOST_SUBREDDITS_KEY,
        { [subscription.subredditName]: JSON.stringify(subscription) },
    );
    const results = await transaction.exec();
    if (!Array.isArray(results) || results.length === 0) {
        throw new DailyAutopostSubscriptionBusyError(
            'Daily autopost subscription save was interrupted.',
        );
    }
}

export async function deleteDailyAutopostSubscription(subredditName: string): Promise<void> {
    const lock = await acquireDailyAutopostSubscriptionLock(subredditName);
    try {
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) {
            throw new DailyAutopostSubscriptionBusyError(
                'Daily autopost subscription lock was lost.',
            );
        }
        await transaction.hDel(DAILY_AUTPOST_SUBREDDITS_KEY, [subredditName]);
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            throw new DailyAutopostSubscriptionBusyError(
                'Daily autopost subscription delete was interrupted.',
            );
        }
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Daily autopost subscription lock cleanup failed:', error);
        });
    }
}

export async function upsertDailyAutopostSubscription(
    subredditName: string,
    updater: (previous: DailyAutopostSubscription | null) => DailyAutopostSubscription,
): Promise<DailyAutopostSubscription> {
    const lock = await acquireDailyAutopostSubscriptionLock(subredditName);
    try {
        const previous = await readDailyAutopostSubscription(subredditName);
        const next = updater(previous);
        await writeDailyAutopostSubscription(next, lock);
        return next;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Daily autopost subscription lock cleanup failed:', error);
        });
    }
}
