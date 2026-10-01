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

// Reddit caps concurrent Redis transactions.
const RELEASE_CONCURRENCY = 1;

async function safelyUnwatch(transaction: TxClientLike): Promise<void> {
    try {
        await transaction.unwatch();
    } catch (_error) {
    }
}

async function safelyDiscard(transaction: TxClientLike): Promise<void> {
    try {
        await transaction.discard();
    } catch (_discardError) {
    }
}

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

// `watchedKeys` are watched with the lock. `check` runs after WATCH and before
// MULTI, so a state it reads cannot change before EXEC without failing the
// commit. When `check` throws, the transaction is given up.
export async function beginOwnedRedisLockTransaction(
    lock: RedisLock,
    client: RedisClient = redis,
    { watchedKeys = [], check }: {
        watchedKeys?: readonly string[];
        check?: () => Promise<void>;
    } = {},
): Promise<TxClientLike | null> {
    const transaction = await client.watch(...new Set([lock.key, ...watchedKeys]));
    try {
        // Transaction-client reads queue; read the base client.
        if (!await isRedisLockOwned(lock, client)) {
            await safelyUnwatch(transaction);
            return null;
        }
        if (check) await check();
        await transaction.multi();
        return transaction;
    } catch (error) {
        await safelyUnwatch(transaction);
        throw error;
    }
}

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
        if (isRedisTransactionConflict(error)) return null;
        throw error;
    }
}

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

// Runs each mutation in one transaction that watches the owner locks and the
// step locks, after it renews them all. It throws `failure('lost')` when a lock
// is no longer owned, and `failure('interrupted')` when a watched key changed.
export function createOwnedLockGroupRunner(
    ownerLocks: readonly RedisLock[],
    failure: (reason: 'lost' | 'interrupted') => Error,
    client: RedisClient = redis,
): RedisLockTransactionRunner {
    return async (stepLocks, mutate) => {
        const fenced = [...new Map(
            [...ownerLocks, ...stepLocks].map((lock) => [lock.key, lock]),
        ).values()];
        if (!await renewRedisLockGroup(fenced, client)) throw failure('lost');
        const transaction = await beginOwnedRedisLockGroupTransaction(fenced, client);
        if (!transaction) throw failure('lost');
        let committed: boolean;
        try {
            await mutate(transaction);
            committed = await commitOwnedRedisLockTransaction(transaction);
        } catch (error) {
            await safelyDiscard(transaction);
            throw error;
        }
        if (!committed) throw failure('interrupted');
    };
}

export type RedisLockLease = {
    isOwned(): boolean;
    confirmOwnership(): Promise<boolean>;
    stop(): Promise<void>;
};

function startLeaseRenewal(
    renew: () => Promise<boolean>,
    isOwned: () => Promise<boolean>,
    renewalIntervalMs: number,
): RedisLockLease {
    let stopped = false;
    let ownershipLost = false;
    let renewal = Promise.resolve();

    const queueRenewal = (): void => {
        renewal = renewal.then(async () => {
            if (stopped || ownershipLost) return;
            try {
                if (!await renew()) ownershipLost = true;
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
                ownershipLost = !await isOwned();
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

export function startRedisLockLeaseRenewal(
    lock: RedisLock,
    renewalIntervalMs: number,
    client: RedisClient = redis,
): RedisLockLease {
    return startLeaseRenewal(
        () => renewRedisLock(lock, client),
        () => isRedisLockOwned(lock, client),
        renewalIntervalMs,
    );
}

export function startRedisLockGroupLeaseRenewal(
    locks: readonly RedisLock[],
    renewalIntervalMs: number,
    client: RedisClient = redis,
): RedisLockLease {
    return startLeaseRenewal(
        () => renewRedisLockGroup(locks, client),
        () => ownsEveryLock(locks, client),
        renewalIntervalMs,
    );
}
