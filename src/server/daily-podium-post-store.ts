import { redis } from '@devvit/redis';
import { createDailyGpRecordExpiration } from './daily-gp-model.js';
import type { DailyGpPodiumPostData } from './daily-podium-model.js';
import { acquireRedisLock, releaseRedisLock, type RedisLock } from './redis-lock.js';

export const DAILY_GP_PODIUM_POST_CREATE_CLAIM_TTL_MS = 15 * 60 * 1000;

export type DailyGpPodiumPostRecord = {
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
    createdAt: string;
};

type DailyGpPodiumPostCreationLock = RedisLock;

export type DailyGpPodiumPendingSnapshot = {
    subredditName: string;
    challengeId: string;
    expiresAt: string;
    podium: DailyGpPodiumPostData;
};

function normalizeSubredditName(subredditName: string): string {
    return subredditName.trim().toLowerCase();
}

export function createPodiumPostRecordKey(subredditName: string, challengeId: string): string {
    return `dailygp:podium-post:${normalizeSubredditName(subredditName)}:${challengeId}`;
}

function createPodiumPostCreationLockKey(subredditName: string, challengeId: string): string {
    return `dailygp:podium-post-create-lock:${normalizeSubredditName(subredditName)}:${challengeId}`;
}

function createPodiumPendingSnapshotKey(subredditName: string, challengeId: string): string {
    return `dailygp:podium-pending:${normalizeSubredditName(subredditName)}:${challengeId}`;
}

function parsePodiumPendingSnapshot(raw: string | null): DailyGpPodiumPendingSnapshot | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<DailyGpPodiumPendingSnapshot>;
        if (
            typeof parsed.subredditName !== 'string'
            || typeof parsed.challengeId !== 'string'
            || typeof parsed.expiresAt !== 'string'
            || !Number.isFinite(Date.parse(parsed.expiresAt))
            || !parsed.podium
            || parsed.podium.challengeId !== parsed.challengeId
            || !Array.isArray(parsed.podium.positions)
            || parsed.podium.positions.length !== 3
        ) {
            return null;
        }
        return parsed as DailyGpPodiumPendingSnapshot;
    } catch (_error) {
        return null;
    }
}

export async function readDailyGpPodiumPendingSnapshot(
    subredditName: string,
    challengeId: string,
): Promise<DailyGpPodiumPendingSnapshot | null> {
    return parsePodiumPendingSnapshot(
        await redis.get(createPodiumPendingSnapshotKey(subredditName, challengeId)),
    );
}

export async function writeDailyGpPodiumPendingSnapshot(
    snapshot: DailyGpPodiumPendingSnapshot,
): Promise<boolean> {
    const expiration = new Date(snapshot.expiresAt);
    if (expiration.getTime() <= Date.now()) return false;
    const result = await redis.set(
        createPodiumPendingSnapshotKey(snapshot.subredditName, snapshot.challengeId),
        JSON.stringify(snapshot),
        { nx: true, expiration },
    );
    return Boolean(result);
}

export async function deleteDailyGpPodiumPendingSnapshot(
    subredditName: string,
    challengeId: string,
): Promise<void> {
    await redis.del(createPodiumPendingSnapshotKey(subredditName, challengeId));
}

function parsePodiumPostRecord(raw: string | null): DailyGpPodiumPostRecord | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as Partial<DailyGpPodiumPostRecord>;
        if (
            typeof parsed.subredditName !== 'string'
            || typeof parsed.challengeId !== 'string'
            || typeof parsed.postId !== 'string'
            || !parsed.postId.startsWith('t3_')
            || typeof parsed.postUrl !== 'string'
            || !parsed.postUrl
        ) {
            return null;
        }

        return {
            subredditName: parsed.subredditName,
            challengeId: parsed.challengeId,
            postId: parsed.postId as `t3_${string}`,
            postUrl: parsed.postUrl,
            createdAt: typeof parsed.createdAt === 'string'
                ? parsed.createdAt
                : new Date(0).toISOString(),
        };
    } catch (_error) {
        return null;
    }
}

export async function readDailyGpPodiumPostRecord(
    subredditName: string,
    challengeId: string,
): Promise<DailyGpPodiumPostRecord | null> {
    return parsePodiumPostRecord(
        await redis.get(createPodiumPostRecordKey(subredditName, challengeId)),
    );
}

export async function writeDailyGpPodiumPostRecordIfAbsent(
    record: DailyGpPodiumPostRecord,
): Promise<boolean> {
    const key = createPodiumPostRecordKey(record.subredditName, record.challengeId);
    const result = await redis.set(key, JSON.stringify(record), {
        nx: true,
        expiration: createDailyGpRecordExpiration(),
    });
    return Boolean(result);
}

export async function acquireDailyGpPodiumPostCreationLock(
    subredditName: string,
    challengeId: string,
): Promise<DailyGpPodiumPostCreationLock | null> {
    const key = createPodiumPostCreationLockKey(subredditName, challengeId);
    return acquireRedisLock(key, DAILY_GP_PODIUM_POST_CREATE_CLAIM_TTL_MS, redis);
}

export async function releaseDailyGpPodiumPostCreationLock(
    lock: DailyGpPodiumPostCreationLock | null,
): Promise<void> {
    await releaseRedisLock(lock, redis);
}
