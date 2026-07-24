import { redis } from '@devvit/redis';
import { acquireRedisLock, releaseRedisLock, type RedisLock } from './redis-lock.js';

/** Permanent hub posts — refresh TTL on every write. */
export const LANDING_POST_TTL_SECONDS = 730 * 24 * 60 * 60;
export const LANDING_POST_CREATE_CLAIM_TTL_MS = 15 * 60 * 1000;

export const LANDING_POST_TYPE = 'landing';
export const CAMPAIGN_HUB_POST_TYPE = 'campaign';

export type HubPostRecord = {
    subredditName: string;
    postId: `t3_${string}`;
    postUrl: string;
    createdAt: string;
};

function normalizeSubredditName(subredditName: string): string {
    return subredditName.trim().toLowerCase();
}

function landingRecordKey(subredditName: string): string {
    return `miniracer:landing-post:${normalizeSubredditName(subredditName)}`;
}

function landingCreateLockKey(subredditName: string): string {
    return `miniracer:landing-post-create-lock:${normalizeSubredditName(subredditName)}`;
}

function campaignHubRecordKey(subredditName: string): string {
    return `miniracer:campaign-hub-post:${normalizeSubredditName(subredditName)}`;
}

function campaignHubCreateLockKey(subredditName: string): string {
    return `miniracer:campaign-hub-post-create-lock:${normalizeSubredditName(subredditName)}`;
}

function parseHubPostRecord(raw: string | null): HubPostRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<HubPostRecord>;
        if (
            typeof parsed.subredditName !== 'string'
            || typeof parsed.postId !== 'string'
            || !parsed.postId.startsWith('t3_')
            || typeof parsed.postUrl !== 'string'
            || !parsed.postUrl
        ) {
            return null;
        }
        return {
            subredditName: parsed.subredditName,
            postId: parsed.postId as `t3_${string}`,
            postUrl: parsed.postUrl,
            createdAt: typeof parsed.createdAt === 'string'
                ? parsed.createdAt
                : new Date(0).toISOString(),
        };
    } catch {
        return null;
    }
}

async function readHubPostRecord(key: string): Promise<HubPostRecord | null> {
    return parseHubPostRecord(await redis.get(key));
}

async function writeHubPostRecord(key: string, record: HubPostRecord): Promise<void> {
    await redis.set(key, JSON.stringify(record));
    await redis.expire(key, LANDING_POST_TTL_SECONDS);
}

export async function readLandingPostRecord(
    subredditName: string,
): Promise<HubPostRecord | null> {
    return readHubPostRecord(landingRecordKey(subredditName));
}

export async function writeLandingPostRecord(record: HubPostRecord): Promise<void> {
    await writeHubPostRecord(landingRecordKey(record.subredditName), record);
}

export async function acquireLandingPostCreationLock(
    subredditName: string,
): Promise<RedisLock | null> {
    return acquireRedisLock(
        landingCreateLockKey(subredditName),
        LANDING_POST_CREATE_CLAIM_TTL_MS,
        redis,
    );
}

export async function releaseLandingPostCreationLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
}

export async function readCampaignHubPostRecord(
    subredditName: string,
): Promise<HubPostRecord | null> {
    return readHubPostRecord(campaignHubRecordKey(subredditName));
}

export async function writeCampaignHubPostRecord(record: HubPostRecord): Promise<void> {
    await writeHubPostRecord(campaignHubRecordKey(record.subredditName), record);
}

export async function acquireCampaignHubPostCreationLock(
    subredditName: string,
): Promise<RedisLock | null> {
    return acquireRedisLock(
        campaignHubCreateLockKey(subredditName),
        LANDING_POST_CREATE_CLAIM_TTL_MS,
        redis,
    );
}

export async function releaseCampaignHubPostCreationLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
}
