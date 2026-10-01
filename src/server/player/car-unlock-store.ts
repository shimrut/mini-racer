import { redis, type RedisClient } from '@devvit/redis';
import {
    buildCarUnlockSnapshot,
} from '../../../game/car/car-unlock-policy.js';
import {
    beginOwnedRedisLockGroupTransaction,
    beginOwnedRedisLockTransaction,
    commitOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
    type RedisLockMutation,
    type RedisLockTransactionRunner,
} from '../redis/redis-lock.js';
import {
    GuestProgressRecoveryRequiredError,
    GuestProgressSelectionRetryableError,
} from '../guest-transfer/guest-progress-selection-error.js';
import { playerFieldHash } from '../redis/redis-names.js';
import { acquireRedisLockWithRetry } from '../redis/redis-lock-retry.js';

type CampaignResultMap = Record<string, { medal?: unknown }>;
export type CarUnlockSnapshot = ReturnType<typeof buildCarUnlockSnapshot>;

const COMPLETED_RACE_FIELD = 'race:completed';
const POSTED_TRACK_PREFIX = 'post:track:';
const WON_CHALLENGE_PREFIX = 'win:challenge:';
const REWARD_FIELD_RULES = [
    { prefix: POSTED_TRACK_PREFIX, limit: 5 },
    { prefix: WON_CHALLENGE_PREFIX, limit: 10 },
] as const;
const CAR_UNLOCK_PROMOTION_LOCK_TTL_MS = 30_000;
const TRANSFER_LOCK_RETRY_DELAYS_MS = [5, 5, 5, 5];
const REWARD_LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];

class CarUnlockProgressBusyError extends Error {}

export function carUnlockHashKey(playerId: string): string {
    return `miniracer:car-unlocks:v1:${playerFieldHash(playerId)}`;
}

// Set when a guest's transfer is chosen. It names the account the guest went to.
export function guestPromotionKey(playerId: string): string {
    return `miniracer:car-unlocks:promotion:v1:${playerFieldHash(playerId)}`;
}

const promotionKey = guestPromotionKey;

function owedRewardKey(playerId: string): string {
    return `miniracer:car-unlocks:owed:v1:${playerFieldHash(playerId)}`;
}

function promotionLockKey(playerId: string): string {
    return `${promotionKey(playerId)}:lock`;
}

async function acquirePromotionLock(
    playerId: string,
    client: RedisClient,
    retryDelaysMs: readonly number[] = TRANSFER_LOCK_RETRY_DELAYS_MS,
) {
    const lock = await acquireRedisLockWithRetry(
        promotionLockKey(playerId),
        CAR_UNLOCK_PROMOTION_LOCK_TTL_MS,
        retryDelaysMs,
        client,
    );
    if (lock) return lock;
    throw new CarUnlockProgressBusyError('Car unlock progress update is already in progress.');
}

async function acquireTransferPromotionLock(playerId: string, client: RedisClient) {
    try {
        return await acquirePromotionLock(playerId, client);
    } catch (error) {
        if (error instanceof CarUnlockProgressBusyError) {
            throw new GuestProgressSelectionRetryableError(
                'Garage progress is temporarily busy. Try again.',
            );
        }
        throw error;
    }
}

async function resolvePromotedPlayerId(playerId: string, client: RedisClient): Promise<string> {
    return await client.get(promotionKey(playerId)) || playerId;
}

export async function readGuestPromotionTarget(
    guestPlayerId: string,
    client: RedisClient = redis,
): Promise<string | null> {
    if (!guestPlayerId.startsWith('guest:')) return null;
    return await client.get(promotionKey(guestPlayerId)) || null;
}

export function isValidCarUnlockEventField(field: string, value: unknown): boolean {
    if (value !== '1') return false;
    if (field === COMPLETED_RACE_FIELD) return true;
    for (const prefix of [POSTED_TRACK_PREFIX, WON_CHALLENGE_PREFIX]) {
        if (!field.startsWith(prefix)) continue;
        const part = field.slice(prefix.length);
        return Boolean(part) && readFieldPart(part) !== null;
    }
    return false;
}

async function writeRewardField(
    hashKey: string,
    field: string,
    client: RedisClient,
): Promise<void> {
    if (field === COMPLETED_RACE_FIELD) {
        await client.hSetNX(hashKey, field, '1');
        return;
    }
    const rule = REWARD_FIELD_RULES.find(({ prefix }) => field.startsWith(prefix));
    if (!rule) return;
    await recordUniqueFieldUntil(hashKey, field, rule.prefix, rule.limit, client);
}

async function writeCarUnlockEvent(
    playerId: string,
    field: string,
    client: RedisClient,
): Promise<void> {
    try {
        const lock = await acquirePromotionLock(playerId, client, REWARD_LOCK_RETRY_DELAYS_MS);
        try {
            const ownerPlayerId = await resolvePromotedPlayerId(playerId, client);
            await writeRewardField(carUnlockHashKey(ownerPlayerId), field, client);
        } finally {
            await releaseRedisLock(lock, client);
        }
    } catch (error) {
        await rememberOwedReward(playerId, field, client);
        throw error;
    }
}

async function rememberOwedReward(
    playerId: string,
    field: string,
    client: RedisClient,
): Promise<void> {
    try {
        await writeRewardField(owedRewardKey(playerId), field, client);
    } catch (error) {
        console.error('An earned reward could not be remembered:', error);
    }
}

export async function settleOwedRewards(
    playerId: string,
    client: RedisClient = redis,
): Promise<boolean> {
    const key = owedRewardKey(playerId);
    try {
        const owed = await client.hGetAll(key);
        for (const field of Object.keys(owed ?? {})) {
            await writeCarUnlockEvent(playerId, field, client);
            await client.hDel(key, [field]);
        }
        return true;
    } catch (error) {
        console.error('An owed Garage reward could not be granted:', error);
        return false;
    }
}

function wonChallengeField(challengeId: string): string {
    return `${WON_CHALLENGE_PREFIX}${safeFieldPart(challengeId)}`;
}

function safeFieldPart(value: string): string {
    return encodeURIComponent(value.trim());
}

function readFieldPart(value: string): string | null {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

async function recordUniqueFieldUntil(
    key: string,
    field: string,
    prefix: string,
    limit: number,
    client: RedisClient,
): Promise<void> {
    const fields = await client.hGetAll(key);
    if (fields[field] === '1') return;
    if (Object.keys(fields).filter((candidate) => candidate.startsWith(prefix)).length >= limit) {
        return;
    }
    await client.hSetNX(key, field, '1');
}

async function readEventFields(
    playerId: string,
    client: RedisClient = redis,
): Promise<Record<string, string>> {
    return client.hGetAll(carUnlockHashKey(playerId));
}

export async function hasCarUnlockProgress(
    playerId: string,
    client: RedisClient = redis,
): Promise<boolean> {
    return Object.keys(await readEventFields(playerId, client)).length > 0;
}

export async function hasRecordedCompletedRace(
    playerId: string,
    client: RedisClient = redis,
): Promise<boolean> {
    const ownerPlayerId = await resolvePromotedPlayerId(playerId, client);
    return await client.hGet(carUnlockHashKey(ownerPlayerId), COMPLETED_RACE_FIELD) === '1';
}

export async function recordCompletedRace(
    playerId: string,
    client: RedisClient = redis,
): Promise<void> {
    await writeCarUnlockEvent(playerId, COMPLETED_RACE_FIELD, client);
}

export async function recordHeadToHeadPost(
    playerId: string,
    trackKey: string,
    client: RedisClient = redis,
): Promise<void> {
    if (!trackKey.trim()) return;
    await writeCarUnlockEvent(playerId, `${POSTED_TRACK_PREFIX}${safeFieldPart(trackKey)}`, client);
}

export async function recordHeadToHeadWin(
    playerId: string,
    challengeId: string,
    client: RedisClient = redis,
): Promise<void> {
    if (!challengeId.trim()) return;
    await writeCarUnlockEvent(playerId, wonChallengeField(challengeId), client);
}

export async function getCarUnlockSnapshot(
    playerId: string,
    campaignResultsByRaceId: CampaignResultMap = {},
    client: RedisClient = redis,
    completedRaceEvidence = false,
): Promise<CarUnlockSnapshot> {
    const fields = await readEventFields(playerId, client);
    return buildCarUnlockSnapshot({
        completedRace: completedRaceEvidence || fields[COMPLETED_RACE_FIELD] === '1',
        postedTrackKeys: Object.keys(fields)
            .filter((field) => field.startsWith(POSTED_TRACK_PREFIX))
            .map((field) => readFieldPart(field.slice(POSTED_TRACK_PREFIX.length)))
            .filter((value): value is string => value !== null),
        wonChallengeIds: Object.keys(fields)
            .filter((field) => field.startsWith(WON_CHALLENGE_PREFIX))
            .map((field) => readFieldPart(field.slice(WON_CHALLENGE_PREFIX.length)))
            .filter((value): value is string => value !== null),
        campaignResultsByRaceId,
    });
}

export async function mergeGuestCarUnlockProgress({
    guestPlayerId,
    redditPlayerId,
    client = redis,
    preserveSource = false,
    verifyGuestSource,
    transactionRunner,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    client?: RedisClient;
    preserveSource?: boolean;
    verifyGuestSource?: (observed: { unlocks: Record<string, string> }) => void | Promise<void>;
    transactionRunner?: RedisLockTransactionRunner;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return false;
    }
    const locks: RedisLock[] = [];
    try {
        for (const playerId of [guestPlayerId, redditPlayerId].sort()) {
            const lock = await acquireTransferPromotionLock(playerId, client);
            locks.push(lock);
        }
    } catch (error) {
        await Promise.all(locks.map((lock) => releaseRedisLock(lock, client).catch(() => false)));
        throw error;
    }
    try {
        const alreadyPromotedTo = await client.get(promotionKey(guestPlayerId));
        if (alreadyPromotedTo) {
            if (alreadyPromotedTo !== redditPlayerId) {
                throw new GuestProgressRecoveryRequiredError(
                    'This guest garage was already promoted to another account.',
                );
            }
            return false;
        }
        const guestKey = carUnlockHashKey(guestPlayerId);
        const fields = await client.hGetAll(guestKey);
        await verifyGuestSource?.({ unlocks: fields });
        const hadGuestProgress = Object.keys(fields).length > 0;

        // Every Garage field is a one-time event flag, so adding the guest's
        // fields to the account's is a union of both Garages.
        const enqueue: RedisLockMutation = async (transaction) => {
            if (hadGuestProgress) {
                await transaction.hSet(carUnlockHashKey(redditPlayerId), fields);
            }
            await transaction.set(promotionKey(guestPlayerId), redditPlayerId);
            if (!preserveSource) await transaction.del(guestKey);
        };
        if (transactionRunner) {
            await transactionRunner(locks, enqueue);
        } else {
            const transaction = await beginOwnedRedisLockGroupTransaction(locks, client);
            if (!transaction) {
                throw new GuestProgressSelectionRetryableError(
                    'Garage progress lost its ownership lock. Try again.',
                );
            }
            await enqueue(transaction);
            if (!await commitOwnedRedisLockTransaction(transaction)) {
                throw new GuestProgressSelectionRetryableError(
                    'Car unlock promotion was interrupted.',
                );
            }
        }
        return hadGuestProgress;
    } finally {
        await Promise.all(locks.map(async (lock) => {
            try {
                await releaseRedisLock(lock, client);
            } catch (error) {
                console.error('Car unlock promotion lock cleanup failed:', error);
            }
        }));
    }
}

export async function cleanupGuestCarUnlockProgress({
    guestPlayerId,
    redditPlayerId,
    client = redis,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    client?: RedisClient;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) return false;
    const lock = await acquireTransferPromotionLock(guestPlayerId, client);
    try {
        const promotedTo = await client.get(promotionKey(guestPlayerId));
        if (promotedTo && promotedTo !== redditPlayerId) {
            throw new GuestProgressRecoveryRequiredError(
                'This guest garage was already promoted to another account.',
            );
        }
        const hadGuestProgress = Object.keys(await client.hGetAll(carUnlockHashKey(guestPlayerId))).length > 0;
        const transaction = await beginOwnedRedisLockTransaction(lock, client);
        if (!transaction) throw new GuestProgressSelectionRetryableError('Garage cleanup lost its ownership lock.');
        await transaction.del(carUnlockHashKey(guestPlayerId));
        if (!await commitOwnedRedisLockTransaction(transaction)) {
            throw new GuestProgressSelectionRetryableError('Garage cleanup was interrupted.');
        }
        return hadGuestProgress;
    } finally {
        await releaseRedisLock(lock, client).catch((error) => {
            console.error('Garage cleanup lock release failed:', error);
        });
    }
}

export async function discardGuestCarUnlockProgress({
    guestPlayerId,
    redditPlayerId,
    client = redis,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    client?: RedisClient;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) return false;
    const lock = await acquireTransferPromotionLock(guestPlayerId, client);
    try {
        const promotedTo = await client.get(promotionKey(guestPlayerId));
        if (promotedTo && promotedTo !== redditPlayerId) {
            throw new GuestProgressRecoveryRequiredError(
                'This guest garage was already promoted to another account.',
            );
        }
        const hadGuestProgress = Object.keys(await client.hGetAll(carUnlockHashKey(guestPlayerId))).length > 0;
        const transaction = await beginOwnedRedisLockTransaction(lock, client);
        if (!transaction) {
            throw new GuestProgressSelectionRetryableError(
                'Garage progress lost its ownership lock. Try again.',
            );
        }
        await transaction.set(promotionKey(guestPlayerId), redditPlayerId);
        await transaction.del(carUnlockHashKey(guestPlayerId));
        if (!await commitOwnedRedisLockTransaction(transaction)) {
            throw new GuestProgressSelectionRetryableError(
                'Car unlock discard was interrupted.',
            );
        }
        return hadGuestProgress;
    } finally {
        try {
            await releaseRedisLock(lock, client);
        } catch (error) {
            console.error('Car unlock discard lock cleanup failed:', error);
        }
    }
}

export async function retireEmptyGuestIdentity({
    guestPlayerId,
    redditPlayerId,
    client = redis,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    client?: RedisClient;
}): Promise<void> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) return;
    const lock = await acquireTransferPromotionLock(guestPlayerId, client);
    try {
        if (await client.get(promotionKey(guestPlayerId))) return;
        const transaction = await beginOwnedRedisLockTransaction(lock, client);
        if (!transaction) throw new Error('Empty guest retirement lock was lost.');
        await transaction.set(promotionKey(guestPlayerId), redditPlayerId);
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            throw new Error('Empty guest retirement was interrupted.');
        }
    } finally {
        await releaseRedisLock(lock, client);
    }
}
