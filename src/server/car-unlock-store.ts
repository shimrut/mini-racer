import { redis, type RedisClient } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    buildCarUnlockSnapshot,
} from '../../game/car/car-unlock-policy.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
} from './redis-lock.js';

type CampaignResultMap = Record<string, { medal?: unknown }>;
export type CarUnlockSnapshot = ReturnType<typeof buildCarUnlockSnapshot>;

const COMPLETED_RACE_FIELD = 'race:completed';
const POSTED_TRACK_PREFIX = 'post:track:';
const WON_CHALLENGE_PREFIX = 'win:challenge:';
const CAR_UNLOCK_PROMOTION_LOCK_TTL_MS = 30_000;
const CAR_UNLOCK_PROMOTION_LOCK_ATTEMPTS = 5;

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
    throw new Error('Car unlock progress update is already in progress.');
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

async function writeCarUnlockEvent(
    playerId: string,
    write: (key: string) => Promise<void>,
    client: RedisClient,
): Promise<void> {
    const lock = await acquirePromotionLock(playerId, client);
    try {
        await write(carUnlockHashKey(await resolvePromotedPlayerId(playerId, client)));
    } finally {
        await releaseRedisLock(lock, client);
    }
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
    await writeCarUnlockEvent(
        playerId,
        async (key) => recordUniqueFieldUntil(
            key,
            `${POSTED_TRACK_PREFIX}${safeFieldPart(trackKey)}`,
            POSTED_TRACK_PREFIX,
            5,
            client,
        ),
        client,
    );
}

export async function recordHeadToHeadWin(
    playerId: string,
    challengeId: string,
    client: RedisClient = redis,
): Promise<void> {
    if (!challengeId.trim()) return;
    await writeCarUnlockEvent(
        playerId,
        async (key) => recordUniqueFieldUntil(
            key,
            `${WON_CHALLENGE_PREFIX}${safeFieldPart(challengeId)}`,
            WON_CHALLENGE_PREFIX,
            10,
            client,
        ),
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
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    client?: RedisClient;
    replace?: boolean;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return false;
    }
    const lock = await acquirePromotionLock(guestPlayerId, client);
    try {
        const alreadyPromotedTo = await client.get(promotionKey(guestPlayerId));
        if (alreadyPromotedTo) return false;
        const guestKey = carUnlockHashKey(guestPlayerId);
        const fields = await client.hGetAll(guestKey);
        const hadGuestProgress = Object.keys(fields).length > 0;
        const transaction = await beginOwnedRedisLockTransaction(lock, client);
        if (!transaction) throw new Error('Car unlock promotion lock was lost.');
        if (replace) {
            await transaction.del(carUnlockHashKey(redditPlayerId));
            if (hadGuestProgress) await transaction.hSet(carUnlockHashKey(redditPlayerId), fields);
        } else if (hadGuestProgress) {
            await transaction.hSet(carUnlockHashKey(redditPlayerId), fields);
        }
        await transaction.set(promotionKey(guestPlayerId), redditPlayerId);
        await transaction.del(guestKey);
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            throw new Error('Car unlock promotion was interrupted.');
        }
        return hadGuestProgress;
    } finally {
        await releaseRedisLock(lock, client);
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
    const lock = await acquirePromotionLock(guestPlayerId, client);
    try {
        const hadGuestProgress = Object.keys(await client.hGetAll(carUnlockHashKey(guestPlayerId))).length > 0;
        const transaction = await beginOwnedRedisLockTransaction(lock, client);
        if (!transaction) throw new Error('Car unlock discard lock was lost.');
        await transaction.set(promotionKey(guestPlayerId), redditPlayerId);
        await transaction.del(carUnlockHashKey(guestPlayerId));
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            throw new Error('Car unlock discard was interrupted.');
        }
        return hadGuestProgress;
    } finally {
        await releaseRedisLock(lock, client);
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
    const lock = await acquirePromotionLock(guestPlayerId, client);
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
