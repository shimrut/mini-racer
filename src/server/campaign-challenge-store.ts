import { createHash } from 'node:crypto';
import { redis, type RedisClient } from '@devvit/redis';
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

function challengeKey(challengeId: string): string {
    return `${PREFIX}:${challengeId}`;
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

export async function readCampaignChallenge(
    challengeId: string,
    client: RedisClient = redis,
): Promise<CampaignChallengeRecord | null> {
    return parseJson<CampaignChallengeRecord>(await client.get(challengeKey(challengeId)));
}

export async function writeCampaignChallenge(
    record: CampaignChallengeRecord,
    client: RedisClient = redis,
): Promise<void> {
    await client.set(challengeKey(record.challengeId), JSON.stringify(record));
}

export async function readCampaignChallengePostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
    client: RedisClient = redis,
): Promise<CampaignChallengePostIdentity | null> {
    return parseJson<CampaignChallengePostIdentity>(await client.get(
        postKey(subredditName, username, raceId, bestTimeMs),
    ));
}

export async function writeCampaignChallengePostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
    identity: CampaignChallengePostIdentity,
    client: RedisClient = redis,
): Promise<void> {
    await client.set(
        postKey(subredditName, username, raceId, bestTimeMs),
        JSON.stringify(identity),
    );
}

export async function deleteCampaignChallengePostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
    client: RedisClient = redis,
): Promise<void> {
    await client.del(postKey(subredditName, username, raceId, bestTimeMs));
}

export async function readCampaignChallengeResult(
    challengeId: string,
    username: string,
    client: RedisClient = redis,
): Promise<CampaignChallengeResult | null> {
    return parseJson<CampaignChallengeResult>(await client.get(resultKey(challengeId, username)));
}

export async function writeCampaignChallengeResult(
    result: CampaignChallengeResult,
    client: RedisClient = redis,
): Promise<void> {
    await client.set(
        resultKey(result.challengeId, result.viewerUsername),
        JSON.stringify(result),
    );
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
    username: string,
): Promise<RedisLock | null> {
    return acquireRedisLock(`${resultKey(challengeId, username)}:lock`, RESULT_LOCK_TTL_MS, redis);
}

export async function reserveCampaignChallengePostSlot(
    subredditName: string,
    username: string,
    now: Date,
    client: RedisClient = redis,
): Promise<boolean> {
    const utcDate = now.toISOString().slice(0, 10);
    const key = createCountKey(subredditName, username, utcDate);
    const count = await client.incrBy(key, 1);
    if (count === 1) {
        const nextUtcDay = Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
        );
        await client.expire(key, Math.max(1, Math.ceil((nextUtcDay - now.getTime()) / 1000)));
    }
    if (count <= 3) return true;
    await client.incrBy(key, -1);
    return false;
}

export async function releaseCampaignChallengePostSlot(
    subredditName: string,
    username: string,
    now: Date,
    client: RedisClient = redis,
): Promise<void> {
    const utcDate = now.toISOString().slice(0, 10);
    const key = createCountKey(subredditName, username, utcDate);
    const count = await client.incrBy(key, -1);
    if (count < 0) await client.set(key, '0');
}
