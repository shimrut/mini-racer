import { redis, type RedisClient } from '@devvit/redis';
import { createHash } from 'node:crypto';
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

type CampaignResultMap = Record<string, { medal?: unknown }>;
export type CarUnlockSnapshot = ReturnType<typeof buildCarUnlockSnapshot>;

const COMPLETED_RACE_FIELD = 'race:completed';
const POSTED_TRACK_PREFIX = 'post:track:';
const WON_CHALLENGE_PREFIX = 'win:challenge:';
const CAR_UNLOCK_PROMOTION_LOCK_TTL_MS = 30_000;
const CAR_UNLOCK_PROMOTION_LOCK_ATTEMPTS = 5;

class CarUnlockProgressBusyError extends Error {}

export function carUnlockHashKey(playerId: string): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `miniracer:car-unlocks:v1:${playerHash}`;
}

function promotionKey(playerId: string): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `miniracer:car-unlocks:promotion:v1:${playerHash}`;
}

function promotionLockKey(playerId: string): string {
    return `${promotionKey(playerId)}:lock`;
}

async function acquirePromotionLock(playerId: string, client: RedisClient) {
    for (let attempt = 0; attempt < CAR_UNLOCK_PROMOTION_LOCK_ATTEMPTS; attempt += 1) {
        const lock = await acquireRedisLock(
            promotionLockKey(playerId),
            CAR_UNLOCK_PROMOTION_LOCK_TTL_MS,
            client,
        );
        if (lock) return lock;
        if (attempt < CAR_UNLOCK_PROMOTION_LOCK_ATTEMPTS - 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
    }
    throw new CarUnlockProgressBusyError('Car unlock progress update is already in progress.');
}

/**
 * The promotion lock, with contention reported the way the transfer contract names it.
 *
 * Every transfer path takes the lock through here. Contention is ordinary: another writer holds the
 * account for a moment, and the browser's retry resolves it. Letting the raw busy error out instead
 * answers 500 with a stack trace, which reads as an unclassified fault and sends someone looking for
 * a problem that is not there. The contract calls this 503 progress_selection_retryable.
 */
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

/** The account a guest was promoted into, if any. Written inside the promotion transaction, so its presence is proof the promotion committed. */
export async function readGuestPromotionTarget(
    guestPlayerId: string,
    client: RedisClient = redis,
): Promise<string | null> {
    if (!guestPlayerId.startsWith('guest:')) return null;
    return await client.get(promotionKey(guestPlayerId)) || null;
}

/**
 * The account's Garage as it stood when its transfer was prepared. Replacement may delete only
 * what this names, so a reward earned after the player chose is never taken away with the rest.
 */
function transferBaselineKey(accountPlayerId: string): string {
    const playerHash = createHash('sha256').update(accountPlayerId, 'utf8').digest('base64url');
    return `miniracer:car-unlocks:transfer-baseline:v1:${playerHash}`;
}

/**
 * Events accepted for the account while its transfer was open.
 *
 * A baseline alone is not enough. `recordUniqueFieldUntil` returns without touching the hash when
 * the field is already `'1'` or the event cap is reached, so an entitlement can be earned again
 * and leave no trace. Deleting the baseline field would then lose it. This records the event even
 * when the ordinary write is a no-op.
 */
function transferJournalKey(accountPlayerId: string): string {
    const playerHash = createHash('sha256').update(accountPlayerId, 'utf8').digest('base64url');
    return `miniracer:car-unlocks:transfer-journal:v1:${playerHash}`;
}

/** Keeps the journal from growing without bound if a transfer is left open for a long time. */
const TRANSFER_JOURNAL_FIELD_LIMIT = 64;

/**
 * Whether one hash field is an ordinary Garage event this build writes.
 *
 * A transfer uses this to tell a legitimate late event from tampering. Every writer stores `'1'`,
 * and only these three shapes exist, so anything else appearing under a guest mid-transfer is not
 * something the game did.
 */
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

/**
 * Records one accepted reward event against an open transfer.
 *
 * Called while the promotion lock is held, so it cannot interleave with replacement. Costs one
 * `GET` on a race finish for a signed-in account, and nothing at all for a guest: a guest hash is
 * the transfer's source, and it is protected by the recorded source inventory instead.
 */
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
        // No identifier: one transfer's logging says what happened, never who it happened to.
        console.error('Guest transfer reward journal is full.');
        return;
    }
    await client.hSetNX(journalKey, field, '1');
}

async function writeCarUnlockEvent(
    playerId: string,
    field: string,
    write: (key: string) => Promise<void>,
    client: RedisClient,
): Promise<void> {
    const lock = await acquirePromotionLock(playerId, client);
    try {
        const ownerPlayerId = await resolvePromotedPlayerId(playerId, client);
        await write(carUnlockHashKey(ownerPlayerId));
        // After the ordinary write, and regardless of whether it changed anything.
        await journalAcceptedTransferEvent(ownerPlayerId, field, client);
    } finally {
        await releaseRedisLock(lock, client);
    }
}

/**
 * Freezes the account's Garage baseline for one transfer.
 *
 * Write-once **for that transfer**: a retry, including one that re-enters preparation, keeps the
 * original, because recapturing would fold rewards earned since the choice into the deletion
 * baseline. That is the loss this exists to prevent.
 *
 * A baseline belonging to a *different* transfer is replaced rather than reused. The keys are
 * collected when a transfer finishes, but that cleanup is best-effort, and a completed transfer
 * never re-enters the copy that would retry it. Reusing whatever survived would replace this
 * account against a snapshot frozen for some earlier choice, and preserve Garage entries the player
 * has just asked to give up. The journal goes with it: its fields record rewards accepted during
 * the transfer that is now over.
 *
 * Takes the account promotion lock, so it cannot run while a reward write or a replacement holds it.
 */
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
                // Unreadable, so it cannot prove it belongs to this transfer. Replace it.
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

/**
 * Removes a finished transfer's baseline and journal. Safe to repeat.
 *
 * Both keys are attempted, whatever the other one does. Awaiting them in sequence meant a refused
 * baseline delete skipped the journal delete entirely, so one failure left two keys behind.
 *
 * Returns false when either key survived. A leftover baseline is reused as the starting Garage for
 * this account's next transfer, because the capture is write-once, and a leftover journal preserves
 * fields that transfer never earned. The caller retries rather than leaving that for a person.
 */
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

/**
 * The account's frozen Garage baseline, for a reviewed repair. Read-only.
 *
 * A baseline outliving its transfer is itself the fault: the capture is write-once, so the next
 * transfer for this account would replace against this snapshot instead of its own.
 */
export async function readGuestTransferGarageBaseline(
    accountPlayerId: string,
    client: RedisClient = redis,
): Promise<Record<string, string> | null> {
    if (!accountPlayerId.startsWith('reddit:')) return null;
    return parseTransferBaseline(await client.get(transferBaselineKey(accountPlayerId)));
}

/** The reward events accepted while a transfer was open, for a reviewed repair. Read-only. */
export async function readGuestTransferGarageJournalFields(
    accountPlayerId: string,
    client: RedisClient = redis,
): Promise<string[]> {
    if (!accountPlayerId.startsWith('reddit:')) return [];
    return Object.keys(await client.hGetAll(transferJournalKey(accountPlayerId)) ?? {});
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

export async function recordCompletedRace(
    playerId: string,
    client: RedisClient = redis,
): Promise<void> {
    await writeCarUnlockEvent(
        playerId,
        COMPLETED_RACE_FIELD,
        async (key) => { await client.hSetNX(key, COMPLETED_RACE_FIELD, '1'); },
        client,
    );
}

export async function recordHeadToHeadPost(
    playerId: string,
    trackKey: string,
    client: RedisClient = redis,
): Promise<void> {
    if (!trackKey.trim()) return;
    const field = `${POSTED_TRACK_PREFIX}${safeFieldPart(trackKey)}`;
    await writeCarUnlockEvent(
        playerId,
        field,
        async (key) => recordUniqueFieldUntil(key, field, POSTED_TRACK_PREFIX, 5, client),
        client,
    );
}

export async function recordHeadToHeadWin(
    playerId: string,
    challengeId: string,
    client: RedisClient = redis,
): Promise<void> {
    if (!challengeId.trim()) return;
    const field = `${WON_CHALLENGE_PREFIX}${safeFieldPart(challengeId)}`;
    await writeCarUnlockEvent(
        playerId,
        field,
        async (key) => recordUniqueFieldUntil(key, field, WON_CHALLENGE_PREFIX, 10, client),
        client,
    );
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
    /**
     * Called under the promotion locks with the exact fields this merge is about to copy, so the
     * check and the copy cannot see different data.
     */
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
            // The pointer is the proof the copy committed. It is accepted only when it names this
            // transfer's account. Another account is a conflict, and no retry can resolve it.
            if (alreadyPromotedTo !== redditPlayerId) {
                throw new GuestProgressRecoveryRequiredError(
                    'This guest garage was already promoted to another account.',
                );
            }
            // The copy committed on an earlier attempt, but its evidence cleanup is best-effort and
            // may not have. This is the only path a retry takes, so without this the keys are never
            // collected: the baseline would be reused by this account's next transfer.
            if (replace) await clearGuestTransferGarageEvidence(redditPlayerId, client);
            return false;
        }
        const guestKey = carUnlockHashKey(guestPlayerId);
        const fields = await client.hGetAll(guestKey);
        await verifyGuestSource?.({ unlocks: fields });
        const hadGuestProgress = Object.keys(fields).length > 0;

        // Replacement discards the Garage the player chose to give up. It must not discard what
        // they earned afterwards, while the transfer was still open.
        const preserved: Record<string, string> = Object.create(null);
        if (replace) {
            const baseline = parseTransferBaseline(
                await client.get(transferBaselineKey(redditPlayerId)),
            );
            const accountFields = await client.hGetAll(carUnlockHashKey(redditPlayerId));
            if (!baseline) {
                // No preparation evidence. This is a transfer recorded before baselines existed,
                // and today's hash cannot be read backwards into what the account held when the
                // player chose. Keep everything rather than treat earned rewards as disposable.
                // The player keeps more than a Guest choice would normally leave, and loses none.
                console.error('Guest transfer Garage baseline missing; keeping the account Garage.');
                Object.assign(preserved, accountFields);
            } else {
                const journal = await client.hGetAll(transferJournalKey(redditPlayerId));
                for (const [field, value] of Object.entries(accountFields)) {
                    // Absent from the baseline means earned since the choice.
                    if (!(field in baseline)) preserved[field] = value;
                }
                for (const field of Object.keys(journal)) {
                    // Earned again during the transfer. The ordinary write was a no-op, because
                    // the field was already set or its event cap was reached, so the hash alone
                    // cannot show it. The journal is the only record that it happened.
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
        // The promotion pointer is now committed, so a later retry returns above without reaching
        // replacement again. The baseline and journal have done their work and may go.
        // A failure here is reported by the helper and repaired by the retry above, which is the
        // path a lost checkpoint response takes back into this function.
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

/** Deletes the old Garage event hash only after the transfer coordinator checkpointed promotion. */
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
        // The pointer records which account claimed this guest. Discarding must not take it from
        // another account that already copied this garage, so a foreign pointer is a conflict.
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
