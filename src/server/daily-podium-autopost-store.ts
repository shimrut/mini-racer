import { redis } from '@devvit/web/server';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from './redis-lock.js';

export const DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY = 'dailygp:podium-autopost:subreddits';
const DAILY_PODIUM_AUTOPOST_SUBSCRIPTION_LOCK_TTL_MS = 30_000;
const DAILY_PODIUM_AUTOPOST_SUBSCRIPTION_LOCK_ATTEMPTS = 5;
const DAILY_PODIUM_AUTOPOST_SUBSCRIPTION_LOCK_RETRY_MS = 5;

export type DailyPodiumAutopostSubscription = {
    subredditName: string;
    enabled: boolean;
    enabledAt: string | null;
    updatedAt: string;
    lastPostedChallengeId: string | null;
    lastPostedAt: string | null;
    lastPostUrl: string | null;
};

export function parseDailyPodiumAutopostSubscription(
    subredditName: string,
    raw: string | null | undefined,
): DailyPodiumAutopostSubscription | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        return {
            subredditName,
            enabled: parsed.enabled !== false,
            enabledAt: typeof parsed.enabledAt === 'string' && parsed.enabledAt
                ? parsed.enabledAt
                : null,
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
            lastPostedChallengeId: typeof parsed.lastPostedChallengeId === 'string'
                && parsed.lastPostedChallengeId
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

export async function readDailyPodiumAutopostSubscription(
    subredditName: string,
): Promise<DailyPodiumAutopostSubscription | null> {
    const raw = await redis.hGet(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY, subredditName);
    return parseDailyPodiumAutopostSubscription(subredditName, raw);
}

export async function readAllDailyPodiumAutopostSubscriptions(): Promise<
    DailyPodiumAutopostSubscription[]
> {
    const rawMap = await redis.hGetAll(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY);
    return Object.entries(rawMap)
        .map(([subredditName, raw]) => parseDailyPodiumAutopostSubscription(subredditName, raw))
        .filter((entry): entry is DailyPodiumAutopostSubscription => Boolean(entry));
}

class DailyPodiumAutopostSubscriptionBusyError extends Error {}

function dailyPodiumAutopostSubscriptionLockKey(subredditName: string): string {
    return `dailygp:podium-autopost:subscription-lock:${subredditName.trim().toLowerCase()}`;
}

async function acquireDailyPodiumAutopostSubscriptionLock(
    subredditName: string,
): Promise<RedisLock> {
    const key = dailyPodiumAutopostSubscriptionLockKey(subredditName);
    for (
        let attempt = 0;
        attempt < DAILY_PODIUM_AUTOPOST_SUBSCRIPTION_LOCK_ATTEMPTS;
        attempt += 1
    ) {
        const lock = await acquireRedisLock(
            key,
            DAILY_PODIUM_AUTOPOST_SUBSCRIPTION_LOCK_TTL_MS,
            redis,
        );
        if (lock) return lock;
        if (attempt < DAILY_PODIUM_AUTOPOST_SUBSCRIPTION_LOCK_ATTEMPTS - 1) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, DAILY_PODIUM_AUTOPOST_SUBSCRIPTION_LOCK_RETRY_MS);
            });
        }
    }
    throw new DailyPodiumAutopostSubscriptionBusyError(
        'Daily podium autopost subscription update is already in progress.',
    );
}

async function writeDailyPodiumAutopostSubscription(
    subscription: DailyPodiumAutopostSubscription,
    lock: RedisLock,
): Promise<void> {
    const transaction = await beginOwnedRedisLockTransaction(lock, redis);
    if (!transaction) {
        throw new DailyPodiumAutopostSubscriptionBusyError(
            'Daily podium autopost subscription lock was lost.',
        );
    }
    await transaction.hSet(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY, {
        [subscription.subredditName]: JSON.stringify(subscription),
    });
    const results = await transaction.exec();
    if (!Array.isArray(results) || results.length === 0) {
        throw new DailyPodiumAutopostSubscriptionBusyError(
            'Daily podium autopost subscription save was interrupted.',
        );
    }
}

export async function deleteDailyPodiumAutopostSubscription(
    subredditName: string,
): Promise<void> {
    const lock = await acquireDailyPodiumAutopostSubscriptionLock(subredditName);
    try {
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) {
            throw new DailyPodiumAutopostSubscriptionBusyError(
                'Daily podium autopost subscription lock was lost.',
            );
        }
        await transaction.hDel(DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY, [subredditName]);
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            throw new DailyPodiumAutopostSubscriptionBusyError(
                'Daily podium autopost subscription delete was interrupted.',
            );
        }
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Daily podium autopost subscription lock cleanup failed:', error);
        });
    }
}

export async function upsertDailyPodiumAutopostSubscription(
    subredditName: string,
    updater: (
        previous: DailyPodiumAutopostSubscription | null,
    ) => DailyPodiumAutopostSubscription,
): Promise<DailyPodiumAutopostSubscription> {
    const lock = await acquireDailyPodiumAutopostSubscriptionLock(subredditName);
    try {
        const previous = await readDailyPodiumAutopostSubscription(subredditName);
        const next = updater(previous);
        await writeDailyPodiumAutopostSubscription(next, lock);
        return next;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Daily podium autopost subscription lock cleanup failed:', error);
        });
    }
}
