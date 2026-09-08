import { redis, type RedisClient, type TxClientLike } from '@devvit/redis';
import { randomUUID } from 'node:crypto';
import { isRedisTransactionConflict } from './redis-transaction-conflict.js';

export type RedisLock = {
    key: string;
    value: string;
    ttlMs: number;
};

export type RedisLockMutation = (transaction: TxClientLike) => Promise<void>;
export type RedisLockTransactionRunner = (
    locks: readonly RedisLock[],
    mutate: RedisLockMutation,
) => Promise<void>;

const OWNERSHIP_TRANSACTION_ATTEMPTS = 3;

function ttlSeconds(ttlMs: number): number {
    return Math.max(1, Math.ceil(ttlMs / 1000));
}

// One at a time. The 2026-08-12 hosted audit recorded Reddit answering this very path with
// "exceeded max concurrency limit on redis transactions", and this fallback only runs when a
// group release already failed — the moment the store is least able to take a burst. The batched
// group release is what makes cleanup cheap; this is only the safety net behind it.
const RELEASE_CONCURRENCY = 1;

async function safelyUnwatch(transaction: TxClientLike): Promise<void> {
    try {
        await transaction.unwatch();
    } catch (_error) {
        // The TTL remains the cleanup path if Redis cannot unwatch.
    }
}

async function safelyDiscard(transaction: TxClientLike): Promise<void> {
    try {
        await transaction.discard();
    } catch (_discardError) {
        // EXEC may already have closed the transaction.
    }
}

/**
 * One read for a whole group. Ownership is still proven token by token; only the round trips
 * collapse. `mGet` is read through the base client so a WATCH stays armed, and mocks that
 * predate it fall back to the per-key reads they already answer.
 */
async function readLockValues(
    locks: readonly RedisLock[],
    client: RedisClient,
): Promise<(string | null | undefined)[]> {
    if (locks.length === 1) return [await client.get(locks[0].key)];
    if (typeof client.mGet === 'function') {
        return await client.mGet(locks.map((lock) => lock.key));
    }
    return await Promise.all(locks.map(async (lock) => await client.get(lock.key)));
}

/**
 * Callers pass the live array a coordinated operation is still adding locks to, so the group is
 * snapshotted first: reading keys from one list and pairing tokens against a longer one would
 * call a valid lock lost.
 */
async function ownsEveryLock(
    locks: readonly RedisLock[],
    client: RedisClient,
): Promise<boolean> {
    const fenced = [...locks];
    if (fenced.length === 0) return false;
    const values = await readLockValues(fenced, client);
    if (values.length !== fenced.length) return false;
    return fenced.every((lock, index) => values[index] === lock.value);
}

async function forEachWithLimit<T>(
    items: readonly T[],
    limit: number,
    run: (item: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (next < items.length) {
                const item = items[next];
                next += 1;
                await run(item);
            }
        },
    );
    await Promise.all(workers);
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
        // @devvit/redis 0.13 queues transaction-client reads, so read through the base client after WATCH and let EXEC catch any change.
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

/**
 * Begin a transaction fenced by every lock in a coordinated operation. The
 * caller must not renew any of these locks between this WATCH and EXEC: an
 * EXPIRE on a watched key intentionally aborts the transaction.
 */
export async function beginOwnedRedisLockGroupTransaction(
    locks: readonly RedisLock[],
    client: RedisClient = redis,
): Promise<TxClientLike | null> {
    const fenced = [...locks];
    if (fenced.length === 0) return null;
    const transaction = await client.watch(...fenced.map((lock) => lock.key));
    try {
        if (!await ownsEveryLock(fenced, client)) {
            await safelyUnwatch(transaction);
            return null;
        }
        await transaction.multi();
        return transaction;
    } catch (error) {
        await safelyUnwatch(transaction);
        // A lost race is the same answer as a lost lock: this caller may not write.
        if (isRedisTransactionConflict(error)) return null;
        throw error;
    }
}

/** Refresh a group before it is watched for a fenced transaction. */
export async function renewRedisLockGroup(
    locks: readonly RedisLock[],
    client: RedisClient = redis,
): Promise<boolean> {
    const fenced = [...locks];
    if (fenced.length === 0) return false;
    const transaction = await client.watch(...fenced.map((lock) => lock.key));
    try {
        if (!await ownsEveryLock(fenced, client)) {
            await safelyUnwatch(transaction);
            return false;
        }
        await transaction.multi();
        for (const lock of fenced) {
            await transaction.expire(lock.key, ttlSeconds(lock.ttlMs));
        }
        const results = await transaction.exec();
        return Array.isArray(results) && results.length > 0;
    } catch (error) {
        await safelyDiscard(transaction);
        // Reddit throws on a lost race where the local double returns nothing. Both mean the
        // same thing here: this group is no longer provably ours to extend.
        if (isRedisTransactionConflict(error)) return false;
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
            await safelyDiscard(transaction);
            // Until this was caught, a lost race threw straight past the attempt loop this
            // function has always had. Retry it, then report the failure as a lost lock.
            if (!isRedisTransactionConflict(error)) throw error;
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

/**
 * Cleanup must not replace the operation's result or its original failure. The TTL remains the
 * recovery path if Redis is unavailable.
 */
export async function releaseRedisLocksSafely(
    locks: readonly (RedisLock | null)[],
    context: string,
    client: RedisClient = redis,
): Promise<void> {
    await forEachWithLimit(locks, RELEASE_CONCURRENCY, async (lock) => {
        try {
            await releaseRedisLock(lock, client);
        } catch (error) {
            console.error(`${context} lock cleanup failed:`, error);
        }
    });
}

/**
 * Drop a whole group in one fenced transaction instead of one five-call transaction per key.
 * Only keys this caller still owns are deleted, so the compare-and-delete a past incident
 * required is kept; anything the group cannot commit falls back to the per-lock path.
 */
export async function releaseRedisLockGroup(
    locks: readonly RedisLock[],
    context: string,
    client: RedisClient = redis,
): Promise<void> {
    const fenced = [...locks];
    if (fenced.length === 0) return;
    if (fenced.length === 1) {
        await releaseRedisLocksSafely(fenced, context, client);
        return;
    }
    let transaction: TxClientLike | null = null;
    try {
        transaction = await client.watch(...fenced.map((lock) => lock.key));
        const values = await readLockValues(fenced, client);
        // A short read cannot prove anything about the keys it did not answer for, so it must
        // not be read as "owns nothing" — that would skip cleanup and leave the group up.
        if (values.length !== fenced.length) {
            await safelyUnwatch(transaction);
            await releaseRedisLocksSafely(fenced, context, client);
            return;
        }
        const owned = fenced.filter((lock, index) => values[index] === lock.value);
        if (owned.length === 0) {
            await safelyUnwatch(transaction);
            return;
        }
        await transaction.multi();
        for (const lock of owned) {
            await transaction.del(lock.key);
        }
        const results = await transaction.exec();
        if (Array.isArray(results) && results.length > 0) return;
    } catch (error) {
        if (transaction) await safelyDiscard(transaction);
        if (!isRedisTransactionConflict(error)) {
            console.error(`${context} lock cleanup failed:`, error);
        }
    }
    await releaseRedisLocksSafely(fenced, context, client);
}

/**
 * Commit a fenced transaction and say whether it landed. Reddit throws on a lost race where the
 * local double returns nothing; both mean the write did not happen, and every caller already
 * has a retryable answer for that.
 */
export async function commitOwnedRedisLockTransaction(
    transaction: TxClientLike,
): Promise<boolean> {
    try {
        const results = await transaction.exec();
        return Array.isArray(results) && results.length > 0;
    } catch (error) {
        await safelyDiscard(transaction);
        if (isRedisTransactionConflict(error)) return false;
        throw error;
    }
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

export function startRedisLockGroupLeaseRenewal(
    locks: readonly RedisLock[],
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
                // One transaction for the group. Renewing key by key cost five calls each, on a
                // timer, while the work this lease protects was already the slow part.
                if (!await renewRedisLockGroup(locks, client)) ownershipLost = true;
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
                ownershipLost = !await ownsEveryLock(locks, client);
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
