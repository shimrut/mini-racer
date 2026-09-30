import { redis, type TxClientLike } from '@devvit/redis';
import {
    acquireRedisLock, isRedisLockOwned, releaseRedisLock,
    type RedisLock,
} from '../redis/redis-lock.js';
import { isRedisTransactionConflict } from '../redis/redis-transaction-conflict.js';

// Moderator track edits and Daily/Campaign placement share this lock. A list
// does not need to lock every track: edits cannot cross its admission check.
const PLACEMENT_LOCK_KEY = 'dailygp:tracks:v1:placement-write-lock:v1';
const PLACEMENT_LOCK_TTL_MS = 30_000;

export class TrackPlacementRetryError extends Error {
    constructor(message = 'Tracks are being updated. Retry before racing.') {
        super(message);
    }
}

export async function withTrackPlacementLock<T>(work: (lock: RedisLock) => Promise<T>): Promise<T> {
    const lock = await acquireRedisLock(PLACEMENT_LOCK_KEY, PLACEMENT_LOCK_TTL_MS);
    if (!lock) throw new TrackPlacementRetryError();
    try {
        return await work(lock);
    } finally {
        await releaseRedisLock(lock).catch((error) => console.error('Track placement lock cleanup failed:', error));
    }
}

// Read through the base Redis client after WATCH; transaction reads queue.
// Every competing placement/edit owns the shared lock. Extra watched keys
// also protect challenge history from its independent maintenance writer.
export async function commitTrackPlacement<T>(
    locks: readonly RedisLock[],
    watchedKeys: readonly string[],
    prepare: () => Promise<{
        result: T;
        mutate?: (transaction: TxClientLike) => Promise<void>;
        confirm?: (results: unknown[]) => boolean;
        reconcile?: () => Promise<boolean>;
    }>,
): Promise<T> {
    const transaction = await redis.watch(...new Set([...locks.map((lock) => lock.key), ...watchedKeys]));
    try {
        if (!(await Promise.all(locks.map((lock) => isRedisLockOwned(lock)))).every(Boolean)) {
            throw new TrackPlacementRetryError();
        }
        const prepared = await prepare();
        if (!prepared.mutate) {
            await transaction.unwatch();
            return prepared.result;
        }
        await transaction.multi();
        await prepared.mutate(transaction);
        let results: unknown[];
        try {
            results = await transaction.exec();
        } catch (error) {
            // EXEC may have committed even when its reply was lost. Only the
            // operation's exact authoritative records can confirm success.
            if (!isRedisTransactionConflict(error) && prepared.reconcile
                && await prepared.reconcile().catch(() => false)) return prepared.result;
            throw new TrackPlacementRetryError('The save could not be confirmed. Retry before racing.');
        }
        if (!Array.isArray(results) || !results.length || prepared.confirm && !prepared.confirm(results)) {
            throw new TrackPlacementRetryError();
        }
        return prepared.result;
    } catch (error) {
        await transaction.discard().catch(() => {});
        if (isRedisTransactionConflict(error)) throw new TrackPlacementRetryError();
        throw error;
    }
}
