import { redis, type RedisClient, type TxClientLike } from '@devvit/redis';
import { randomUUID } from 'node:crypto';

export type RedisLock = {
    key: string;
    value: string;
    ttlMs: number;
};

const OWNERSHIP_TRANSACTION_ATTEMPTS = 3;

function ttlSeconds(ttlMs: number): number {
    return Math.max(1, Math.ceil(ttlMs / 1000));
}

async function safelyUnwatch(transaction: TxClientLike): Promise<void> {
    try {
        await transaction.unwatch();
    } catch (_error) {
        // The TTL remains the cleanup path if Redis cannot unwatch.
    }
}

export async function acquireRedisLock(
    key: string,
    ttlMs: number,
    client: RedisClient = redis,
): Promise<RedisLock | null> {
    const value = randomUUID();
    const acquired = await client.set(key, value, {
        nx: true,
        expiration: new Date(Date.now() + ttlMs),
    });
    return acquired ? { key, value, ttlMs } : null;
}

export async function isRedisLockOwned(
    lock: RedisLock,
    client: RedisClient = redis,
): Promise<boolean> {
    return await client.get(lock.key) === lock.value;
}

export async function beginOwnedRedisLockTransaction(
    lock: RedisLock,
    client: RedisClient = redis,
): Promise<TxClientLike | null> {
    const transaction = await client.watch(lock.key);
    try {
        // @devvit/redis 0.13 queues transaction-client reads, so read through
        // the base client after WATCH and let EXEC detect any intervening change.
        if (!await isRedisLockOwned(lock, client)) {
            await safelyUnwatch(transaction);
            return null;
        }
        await transaction.multi();
        return transaction;
    } catch (error) {
        await safelyUnwatch(transaction);
        throw error;
    }
}

async function mutateOwnedRedisLock(
    lock: RedisLock,
    mutate: (transaction: TxClientLike) => Promise<void>,
    client: RedisClient,
): Promise<boolean> {
    for (let attempt = 0; attempt < OWNERSHIP_TRANSACTION_ATTEMPTS; attempt += 1) {
        const transaction = await beginOwnedRedisLockTransaction(lock, client);
        if (!transaction) return false;
        try {
            await mutate(transaction);
            const results = await transaction.exec();
            if (Array.isArray(results) && results.length > 0) return true;
        } catch (error) {
            try {
                await transaction.discard();
            } catch (_discardError) {
                // EXEC may already have closed the transaction.
            }
            throw error;
        }
    }
    return false;
}

export async function renewRedisLock(
    lock: RedisLock,
    client: RedisClient = redis,
): Promise<boolean> {
    return mutateOwnedRedisLock(
        lock,
        async (transaction) => {
            await transaction.expire(lock.key, ttlSeconds(lock.ttlMs));
        },
        client,
    );
}

export async function releaseRedisLock(
    lock: RedisLock | null,
    client: RedisClient = redis,
): Promise<boolean> {
    if (!lock) return false;
    return mutateOwnedRedisLock(
        lock,
        async (transaction) => {
            await transaction.del(lock.key);
        },
        client,
    );
}

export type RedisLockLease = {
    isOwned(): boolean;
    confirmOwnership(): Promise<boolean>;
    stop(): Promise<void>;
};

export function startRedisLockLeaseRenewal(
    lock: RedisLock,
    renewalIntervalMs: number,
    client: RedisClient = redis,
): RedisLockLease {
    let stopped = false;
    let ownershipLost = false;
    let renewal = Promise.resolve();

    const queueRenewal = (): void => {
        renewal = renewal.then(async () => {
            if (stopped || ownershipLost) return;
            try {
                if (!await renewRedisLock(lock, client)) ownershipLost = true;
            } catch (_error) {
                ownershipLost = true;
            }
        });
    };
    const timer = setInterval(queueRenewal, renewalIntervalMs);
    timer.unref?.();

    return {
        isOwned: () => !ownershipLost,
        async confirmOwnership(): Promise<boolean> {
            await renewal;
            if (stopped || ownershipLost) return false;
            try {
                ownershipLost = !await isRedisLockOwned(lock, client);
            } catch (_error) {
                ownershipLost = true;
            }
            return !ownershipLost;
        },
        async stop(): Promise<void> {
            stopped = true;
            clearInterval(timer);
            await renewal;
        },
    };
}
