import { redis, type RedisClient } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    buildCarUnlockSnapshot,
} from '../../game/car/car-unlock-policy.js';

type CampaignResultMap = Record<string, { medal?: unknown }>;
export type CarUnlockSnapshot = ReturnType<typeof buildCarUnlockSnapshot>;

const COMPLETED_RACE_FIELD = 'race:completed';
const POSTED_TRACK_PREFIX = 'post:track:';
const WON_CHALLENGE_PREFIX = 'win:challenge:';

function playerKey(playerId: string): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `miniracer:car-unlocks:v1:${playerHash}`;
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
    return client.hGetAll(playerKey(playerId));
}

export async function recordCompletedRace(
    playerId: string,
    client: RedisClient = redis,
): Promise<void> {
    await client.hSetNX(playerKey(playerId), COMPLETED_RACE_FIELD, '1');
}

export async function recordHeadToHeadPost(
    playerId: string,
    trackKey: string,
    client: RedisClient = redis,
): Promise<void> {
    if (!trackKey.trim()) return;
    const key = playerKey(playerId);
    await recordUniqueFieldUntil(
        key,
        `${POSTED_TRACK_PREFIX}${safeFieldPart(trackKey)}`,
        POSTED_TRACK_PREFIX,
        5,
        client,
    );
}

export async function recordHeadToHeadWin(
    playerId: string,
    challengeId: string,
    client: RedisClient = redis,
): Promise<void> {
    if (!challengeId.trim()) return;
    const key = playerKey(playerId);
    await recordUniqueFieldUntil(
        key,
        `${WON_CHALLENGE_PREFIX}${safeFieldPart(challengeId)}`,
        WON_CHALLENGE_PREFIX,
        10,
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
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    client?: RedisClient;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return false;
    }
    const guestKey = playerKey(guestPlayerId);
    const fields = await client.hGetAll(guestKey);
    if (!Object.keys(fields).length) return false;
    await client.hSet(playerKey(redditPlayerId), fields);
    await client.del(guestKey);
    return true;
}
