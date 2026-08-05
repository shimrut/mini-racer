import { createHash } from 'node:crypto';
import { redis } from '@devvit/redis';
import type {
    CampaignChallengeRecord,
    CampaignChallengeResult,
} from './campaign-challenge-model.js';
import {
    acquireRedisLock,
    releaseRedisLock,
    type RedisLock,
} from './redis-lock.js';

const PREFIX = 'miniracer:campaign-challenge';
const CREATE_LOCK_TTL_MS = 15 * 60_000;
const RESULT_LOCK_TTL_MS = 30_000;

export type CampaignChallengePostIdentity = {
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
};

function keyPart(value: string): string {
    return encodeURIComponent(value.trim().toLowerCase());
}

function postKey(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): string {
    return `${PREFIX}:post:${keyPart(subredditName)}:${keyPart(username)}:${raceId}:${bestTimeMs}`;
}

function resultKey(challengeId: string, username: string): string {
    const viewerHash = createHash('sha256')
        .update(username.trim().toLowerCase())
        .digest('hex');
    return `${PREFIX}:result:${challengeId}:${viewerHash}`;
}

function challengeKey(challengeId: string): string {
    return `${PREFIX}:${challengeId}`;
}

function canonicalPlayerId(value: string): string {
    const normalized = value.trim();
    if (normalized.startsWith('reddit:')) {
        return `reddit:${normalized.slice('reddit:'.length).toLowerCase()}`;
    }
    if (normalized.startsWith('guest:')) return normalized;
    return `reddit:${normalized.toLowerCase()}`;
}

function resultCollectionKey(playerId: string): string {
    const playerHash = createHash('sha256')
        .update(canonicalPlayerId(playerId), 'utf8')
        .digest('base64url');
    return `${PREFIX}:results:${playerHash}`;
}

function createCountKey(subredditName: string, username: string, utcDate: string): string {
    return `${PREFIX}:create-count:${keyPart(subredditName)}:${keyPart(username)}:${utcDate}`;
}

function createLockKey(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): string {
    return `${postKey(subredditName, username, raceId, bestTimeMs)}:lock`;
}

function parseJson<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as T : null;
    } catch {
        return null;
    }
}

/** Legacy challenge records remain readable while old posts migrate. */
export async function readCampaignChallenge(
    challengeId: string,
): Promise<CampaignChallengeRecord | null> {
    return parseJson<CampaignChallengeRecord>(await redis.get(challengeKey(challengeId)));
}

export async function writeCampaignChallenge(
    record: CampaignChallengeRecord,
): Promise<void> {
    await redis.set(challengeKey(record.challengeId), JSON.stringify(record));
}

function challengePostIdentityKey(challengeId: string): string {
    return `${PREFIX}:post-identity:${challengeId}`;
}

/** Stores only the Reddit post identity; the replay remains in the post body. */
export async function readCampaignChallengePostIdentityByChallengeId(
    challengeId: string,
): Promise<CampaignChallengePostIdentity | null> {
    return parseJson<CampaignChallengePostIdentity>(await redis.get(
        challengePostIdentityKey(challengeId),
    ));
}

export async function writeCampaignChallengePostIdentityByChallengeId(
    identity: CampaignChallengePostIdentity,
): Promise<void> {
    await redis.set(
        challengePostIdentityKey(identity.challengeId),
        JSON.stringify(identity),
    );
}

export async function readCampaignChallengePostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): Promise<CampaignChallengePostIdentity | null> {
    return parseJson<CampaignChallengePostIdentity>(await redis.get(
        postKey(subredditName, username, raceId, bestTimeMs),
    ));
}

export async function writeCampaignChallengePostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
    identity: CampaignChallengePostIdentity,
): Promise<void> {
    await redis.set(
        postKey(subredditName, username, raceId, bestTimeMs),
        JSON.stringify(identity),
    );
}

export async function deleteCampaignChallengePostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): Promise<void> {
    await redis.del(postKey(subredditName, username, raceId, bestTimeMs));
}

export async function readCampaignChallengeResult(
    challengeId: string,
    playerIdOrUsername: string,
): Promise<CampaignChallengeResult | null> {
    const identity = canonicalPlayerId(playerIdOrUsername);
    const collection = await redis.hGetAll(resultCollectionKey(identity));
    const current = parseJson<CampaignChallengeResult>(collection?.[challengeId] ?? null);
    if (current) return current;

    // Preserve results written by the previous per-challenge Reddit key until
    // the viewer improves that result or signs in and the guest record merges.
    if (!identity.startsWith('reddit:')) {
        return null;
    }
    const username = identity.slice('reddit:'.length);
    return parseJson<CampaignChallengeResult>(await redis.get(
        resultKey(challengeId, username),
    ));
}

export async function writeCampaignChallengeResult(
    result: CampaignChallengeResult,
): Promise<void> {
    const identity = result.viewerPlayerId || canonicalPlayerId(result.viewerUsername);
    await redis.hSet(resultCollectionKey(identity), {
        [result.challengeId]: JSON.stringify(result),
    });
}

export async function mergeGuestCampaignChallengeResults({
    guestPlayerId,
    redditPlayerId,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return false;
    }
    const guestResults = await redis.hGetAll(resultCollectionKey(guestPlayerId));
    const guestEntries = Object.entries(guestResults || {})
        .map(([challengeId, raw]) => [
            challengeId,
            parseJson<CampaignChallengeResult>(raw),
        ] as const)
        .filter((entry): entry is readonly [string, CampaignChallengeResult] => Boolean(entry[1]));
    if (!guestEntries.length) return false;

    const updates: Record<string, string> = {};
    const redditUsername = redditPlayerId.slice('reddit:'.length);
    for (const [challengeId, guestResult] of guestEntries) {
        const existing = await readCampaignChallengeResult(challengeId, redditUsername);
        if (existing && existing.bestTimeMs <= guestResult.bestTimeMs) continue;
        updates[challengeId] = JSON.stringify({
            ...guestResult,
            viewerUsername: redditUsername,
            viewerPlayerId: redditPlayerId,
        });
    }
    if (Object.keys(updates).length) {
        await redis.hSet(resultCollectionKey(redditPlayerId), updates);
    }
    await redis.del(resultCollectionKey(guestPlayerId));
    return true;
}

export async function acquireCampaignChallengeCreationLock(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): Promise<RedisLock | null> {
    return acquireRedisLock(
        createLockKey(subredditName, username, raceId, bestTimeMs),
        CREATE_LOCK_TTL_MS,
        redis,
    );
}

export async function releaseCampaignChallengeCreationLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
}

export async function acquireCampaignChallengeResultLock(
    challengeId: string,
    playerId: string,
): Promise<RedisLock | null> {
    return acquireRedisLock(
        `${resultCollectionKey(playerId)}:${challengeId}:lock`,
        RESULT_LOCK_TTL_MS,
        redis,
    );
}

export async function reserveCampaignChallengePostSlot(
    subredditName: string,
    username: string,
    now: Date,
): Promise<boolean> {
    const utcDate = now.toISOString().slice(0, 10);
    const key = createCountKey(subredditName, username, utcDate);
    const count = await redis.incrBy(key, 1);
    if (count === 1) {
        const nextUtcDay = Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
        );
        await redis.expire(key, Math.max(1, Math.ceil((nextUtcDay - now.getTime()) / 1000)));
    }
    if (count <= 3) return true;
    await redis.incrBy(key, -1);
    return false;
}

export async function releaseCampaignChallengePostSlot(
    subredditName: string,
    username: string,
    now: Date,
): Promise<void> {
    const utcDate = now.toISOString().slice(0, 10);
    const key = createCountKey(subredditName, username, utcDate);
    const count = await redis.incrBy(key, -1);
    if (count < 0) await redis.set(key, '0');
}
