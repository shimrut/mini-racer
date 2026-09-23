import { redis } from '@devvit/redis';
import type { HeadToHeadMedal } from './head-to-head-model.js';
import {
    acquireRedisLock,
    releaseRedisLock,
    type RedisLock,
} from '../redis/redis-lock.js';
import { redisKeyPart } from '../redis/redis-names.js';

const PREFIX = 'miniracer:head-to-head';
const CREATE_LOCK_TTL_MS = 15 * 60_000;

const IDENTITY_TTL_SECONDS = 10 * 60;
const ACCEPT_TTL_SECONDS = 5 * 60;

export type HeadToHeadPostIdentity = {
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
};

export type HeadToHeadAcceptRecord = {
    challengeId: string;
    postId: `t3_${string}`;
    playerId: string;
    username: string;
    bestTimeMs: number;
    targetTimeMs: number;
    medal: HeadToHeadMedal;
};

function postKey(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): string {
    return `${PREFIX}:post:${redisKeyPart(subredditName)}:${redisKeyPart(username)}:${raceId}:${bestTimeMs}`;
}

function acceptKey(token: string): string {
    return `${PREFIX}:accept:${token}`;
}

function createCountKey(
    subredditName: string,
    username: string,
    trackKey: string,
    utcDate: string,
): string {
    return `${PREFIX}:create-count:${redisKeyPart(subredditName)}:${redisKeyPart(username)}:${redisKeyPart(trackKey)}:${utcDate}`;
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

async function setWithTtl(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await redis.set(key, JSON.stringify(value), {
        expiration: new Date(Date.now() + ttlSeconds * 1000),
    });
}

function challengePostIdentityKey(challengeId: string): string {
    return `${PREFIX}:post-identity:${challengeId}`;
}

export async function readHeadToHeadPostIdentityByChallengeId(
    challengeId: string,
): Promise<HeadToHeadPostIdentity | null> {
    return parseJson<HeadToHeadPostIdentity>(await redis.get(
        challengePostIdentityKey(challengeId),
    ));
}

export async function writeHeadToHeadPostIdentityByChallengeId(
    identity: HeadToHeadPostIdentity,
): Promise<void> {
    await setWithTtl(
        challengePostIdentityKey(identity.challengeId),
        identity,
        IDENTITY_TTL_SECONDS,
    );
}

export async function readHeadToHeadPostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): Promise<HeadToHeadPostIdentity | null> {
    return parseJson<HeadToHeadPostIdentity>(await redis.get(
        postKey(subredditName, username, raceId, bestTimeMs),
    ));
}

export async function writeHeadToHeadPostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
    identity: HeadToHeadPostIdentity,
): Promise<void> {
    await setWithTtl(
        postKey(subredditName, username, raceId, bestTimeMs),
        identity,
        IDENTITY_TTL_SECONDS,
    );
}

export async function deleteHeadToHeadPostIdentity(
    subredditName: string,
    username: string,
    raceId: string,
    bestTimeMs: number,
): Promise<void> {
    await redis.del(postKey(subredditName, username, raceId, bestTimeMs));
}

export async function writeHeadToHeadAccept(
    token: string,
    record: HeadToHeadAcceptRecord,
): Promise<void> {
    await setWithTtl(acceptKey(token), record, ACCEPT_TTL_SECONDS);
}

export async function readHeadToHeadAccept(
    token: string,
): Promise<HeadToHeadAcceptRecord | null> {
    return parseJson<HeadToHeadAcceptRecord>(await redis.get(acceptKey(token)));
}

export async function acquireHeadToHeadCreationLock(
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

export async function releaseHeadToHeadCreationLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
}

export async function reserveHeadToHeadPostSlot(
    subredditName: string,
    username: string,
    trackKey: string,
    now: Date,
): Promise<boolean> {
    const utcDate = now.toISOString().slice(0, 10);
    const key = createCountKey(subredditName, username, trackKey, utcDate);
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

export async function releaseHeadToHeadPostSlot(
    subredditName: string,
    username: string,
    trackKey: string,
    now: Date,
): Promise<void> {
    const utcDate = now.toISOString().slice(0, 10);
    const key = createCountKey(subredditName, username, trackKey, utcDate);
    const count = await redis.incrBy(key, -1);
    if (count < 0) await redis.set(key, '0');
}
