import { redis, type RedisClient } from '@devvit/redis';
import {
    buildCarUnlockSnapshot,
} from '../../game/car/car-unlock-policy.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockGroupTransaction,
    beginOwnedRedisLockTransaction,
    commitOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
    type RedisLockMutation,
    type RedisLockTransactionRunner,
} from './redis-lock.js';
import {
    GuestProgressRecoveryRequiredError,
    GuestProgressSelectionRetryableError,
} from './guest-progress-selection-error.js';
import { playerFieldHash } from './value-guards.js';

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

function promotionKey(playerId: string): string {
    return `miniracer:car-unlocks:promotion:v1:${playerFieldHash(playerId)}`;
}

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
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        const lock = await acquireRedisLock(
            promotionLockKey(playerId),
            CAR_UNLOCK_PROMOTION_LOCK_TTL_MS,
            client,
        );
        if (lock) return lock;
        if (attempt < retryDelaysMs.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        }
    }
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

function transferBaselineKey(accountPlayerId: string): string {
    return `miniracer:car-unlocks:transfer-baseline:v1:${playerFieldHash(accountPlayerId)}`;
}

function transferJournalKey(accountPlayerId: string): string {
    return `miniracer:car-unlocks:transfer-journal:v1:${playerFieldHash(accountPlayerId)}`;
}

const TRANSFER_JOURNAL_FIELD_LIMIT = 64;

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

async function journalAcceptedTransferEvent(
    accountPlayerId: string,
    field: string,
    client: RedisClient,
): Promise<void> {
    if (!accountPlayerId.startsWith('reddit:')) return;
    const baseline = await client.get(transferBaselineKey(accountPlayerId));
    if (!baseline) return;
    const journalKey = transferJournalKey(accountPlayerId);
    const existing = await client.hGetAll(journalKey);
    if (existing[field] === '1') return;
    if (Object.keys(existing).length >= TRANSFER_JOURNAL_FIELD_LIMIT) {
        console.error('Guest transfer reward journal is full.');
        return;
    }
    await client.hSetNX(journalKey, field, '1');
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
            await journalAcceptedTransferEvent(ownerPlayerId, field, client);
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

export async function clearOwedRewards(
    playerId: string,
    client: RedisClient = redis,
): Promise<void> {
    try {
        await client.del(owedRewardKey(playerId));
    } catch (error) {
        console.error('An owed reward list could not be cleared:', error);
    }
}

export async function captureGuestTransferGarageBaseline(
    accountPlayerId: string,
    transferId: string,
    client: RedisClient = redis,
): Promise<boolean> {
    if (!accountPlayerId.startsWith('reddit:')) return false;
    const key = transferBaselineKey(accountPlayerId);
    const lock = await acquireTransferPromotionLock(accountPlayerId, client);
    try {
        const stored = await client.get(key);
        if (stored) {
            let storedTransferId: unknown = null;
            try {
                storedTransferId = (JSON.parse(stored) as { transferId?: unknown })?.transferId;
            } catch (_error) {
            }
            if (storedTransferId === transferId) return false;
            await client.del(transferJournalKey(accountPlayerId));
        }
        await client.set(key, JSON.stringify({
            version: 2,
            accountPlayerId,
            transferId,
            fields: await client.hGetAll(carUnlockHashKey(accountPlayerId)),
            capturedAt: new Date().toISOString(),
        }));
        return true;
    } finally {
        await releaseRedisLock(lock, client);
    }
}

function parseTransferBaseline(raw: string | null | undefined): Record<string, string> | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const fields = (parsed as { fields?: unknown }).fields;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
        return fields as Record<string, string>;
    } catch (_error) {
        return null;
    }
}

export async function clearGuestTransferGarageEvidence(
    accountPlayerId: string,
    client: RedisClient = redis,
): Promise<boolean> {
    if (!accountPlayerId.startsWith('reddit:')) return true;
    const outcomes = await Promise.allSettled([
        client.del(transferBaselineKey(accountPlayerId)),
        client.del(transferJournalKey(accountPlayerId)),
    ]);
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    for (const outcome of failed) {
        console.error('Guest transfer Garage evidence cleanup failed:', (outcome as PromiseRejectedResult).reason);
    }
    return failed.length === 0;
}

export async function readGuestTransferGarageBaseline(
    accountPlayerId: string,
    client: RedisClient = redis,
): Promise<Record<string, string> | null> {
    if (!accountPlayerId.startsWith('reddit:')) return null;
    return parseTransferBaseline(await client.get(transferBaselineKey(accountPlayerId)));
}

export async function readGuestTransferGarageJournalFields(
    accountPlayerId: string,
    client: RedisClient = redis,
): Promise<string[]> {
    if (!accountPlayerId.startsWith('reddit:')) return [];
    return Object.keys(await client.hGetAll(transferJournalKey(accountPlayerId)) ?? {});
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
    replace = false,
    preserveSource = false,
    verifyGuestSource,
    transactionRunner,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    client?: RedisClient;
    replace?: boolean;
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
            if (replace) await clearGuestTransferGarageEvidence(redditPlayerId, client);
            return false;
        }
        const guestKey = carUnlockHashKey(guestPlayerId);
        const fields = await client.hGetAll(guestKey);
        await verifyGuestSource?.({ unlocks: fields });
        const hadGuestProgress = Object.keys(fields).length > 0;

        const preserved: Record<string, string> = Object.create(null);
        if (replace) {
            const baseline = parseTransferBaseline(
                await client.get(transferBaselineKey(redditPlayerId)),
            );
            const accountFields = await client.hGetAll(carUnlockHashKey(redditPlayerId));
            if (!baseline) {
                console.error('Guest transfer Garage baseline missing; keeping the account Garage.');
                Object.assign(preserved, accountFields);
            } else {
                const journal = await client.hGetAll(transferJournalKey(redditPlayerId));
                for (const [field, value] of Object.entries(accountFields)) {
                    if (!(field in baseline)) preserved[field] = value;
                }
                for (const field of Object.keys(journal)) {
                    preserved[field] = accountFields[field] ?? '1';
                }
            }
        }

        const enqueue: RedisLockMutation = async (transaction) => {
            if (replace) {
                await transaction.del(carUnlockHashKey(redditPlayerId));
                const next = { ...fields, ...preserved };
                if (Object.keys(next).length > 0) {
                    await transaction.hSet(carUnlockHashKey(redditPlayerId), next);
                }
            } else if (hadGuestProgress) {
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
        if (replace) await clearGuestTransferGarageEvidence(redditPlayerId, client);
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
