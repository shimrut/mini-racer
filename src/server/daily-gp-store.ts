import { redis } from '@devvit/redis';
import {
    normalizeLeaderboardIdentityPreference,
    resolveLeaderboardDisplayName,
    sanitizeRedditUsername,
} from '../shared/leaderboard-identity.js';
import {
    buildDailyGpChallenge,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    createRedisPlayerProfileHashKey,
    DAILY_GP_DEFAULT_LIMIT,
    DAILY_GP_NEARBY_RADIUS,
    DAILY_GP_PLAYER_PROFILE_TTL_SECONDS,
    DAILY_GP_REDIS_TTL_SECONDS,
    DAILY_GP_TOP_ROWS_LIMIT,
    encodeDailyGpLeaderboardScore,
    formatRankLabel,
    isValidDailyGpTime,
    toBestTimeMs,
    type DailyGpChallenge,
    type DailyGpLeaderboardEntry,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';

type SnapshotRow = {
    rank: number;
    rankLabel: string;
    playerId: string;
    displayName: string;
    bestTime: number;
    bestTimeMs: number;
    updatedAt: string;
    isCurrentPlayer: boolean;
    completedLaps: null;
};

type SnapshotPayload = {
    topRows: SnapshotRow[];
    nearbyRows: SnapshotRow[];
    currentPlayerRow: SnapshotRow | null;
    /** Subreddit size when provided, else count of players with a posted time (at least this many). */
    totalCount: number;
    /** Players on the timed leaderboard (Redis z-card). */
    leaderboardEntryCount: number;
    objectiveType: string;
    playerRank: number | null;
    playerRankLabel: string | null;
};

type PlayerBootstrapPayload = {
    playerId: string | null;
    redditUsername: string | null;
    hasAnyData: boolean;
    isReturningPlayer: boolean;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
};

const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;

function createEmptySnapshot(challenge: DailyGpChallenge): SnapshotPayload {
    return {
        topRows: [],
        nearbyRows: [],
        currentPlayerRow: null,
        totalCount: 0,
        leaderboardEntryCount: 0,
        objectiveType: challenge.objectiveType,
        playerRank: null,
        playerRankLabel: null,
    };
}

function normalizeCommunityMemberTotal(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 1) {
        return null;
    }
    return Math.min(Math.trunc(n), 1_000_000);
}

function normalizeLimit(limit: unknown): number {
    if (!Number.isFinite(limit)) {
        return DAILY_GP_DEFAULT_LIMIT;
    }

    return Math.min(Math.max(Math.trunc(Number(limit)), 1), 100);
}

function parseStoredEntry(raw: string | null | undefined): DailyGpLeaderboardEntry | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (
            !parsed
            || typeof parsed !== 'object'
            || typeof parsed.playerId !== 'string'
            || !parsed.playerId
            || !Number.isFinite(parsed.bestTimeMs)
            || typeof parsed.updatedAt !== 'string'
            || !parsed.updatedAt
        ) {
            return null;
        }

        return {
            playerId: parsed.playerId,
            bestTimeMs: Number(parsed.bestTimeMs),
            updatedAt: parsed.updatedAt,
            completedLaps: null,
        };
    } catch (_error) {
        return null;
    }
}

function parseStoredPlayerProfile(raw: string | null | undefined): DailyGpPlayerProfile | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.playerId !== 'string' || !parsed.playerId) {
            return null;
        }

        return {
            playerId: parsed.playerId,
            leaderboardIdentity: normalizeLeaderboardIdentityPreference(parsed.leaderboardIdentity),
            redditUsername: sanitizeRedditUsername(parsed.redditUsername),
            hasSeenGame: parsed.hasSeenGame !== false,
            hasAnyData: Boolean(parsed.hasAnyData),
            firstSeenAt: typeof parsed.firstSeenAt === 'string' && parsed.firstSeenAt
                ? parsed.firstSeenAt
                : new Date(0).toISOString(),
            lastSeenAt: typeof parsed.lastSeenAt === 'string' && parsed.lastSeenAt
                ? parsed.lastSeenAt
                : new Date(0).toISOString(),
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
        };
    } catch (_error) {
        return null;
    }
}

async function ensurePlayerProfileTtl(): Promise<void> {
    await redis.expire(createRedisPlayerProfileHashKey(), DAILY_GP_PLAYER_PROFILE_TTL_SECONDS);
}

function resolveCanonicalPlayerId({
    playerId,
    redditUsername,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
}): string | null {
    const safeUsername = sanitizeRedditUsername(redditUsername);
    if (safeUsername) {
        return `reddit:${safeUsername.toLowerCase()}`;
    }

    if (typeof playerId === 'string' && playerId.trim()) {
        return `guest:${playerId.trim()}`;
    }

    return null;
}

async function readPlayerProfile(playerId: string): Promise<DailyGpPlayerProfile | null> {
    const rawProfile = await redis.hGet(createRedisPlayerProfileHashKey(), playerId);
    return parseStoredPlayerProfile(rawProfile);
}

async function upsertPlayerProfile({
    playerId,
    leaderboardIdentity,
    redditUsername,
    hasAnyData,
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    hasAnyData?: boolean;
}): Promise<DailyGpPlayerProfile> {
    const previousProfile = await readPlayerProfile(playerId);
    const nowIso = new Date().toISOString();
    const nextProfile: DailyGpPlayerProfile = {
        playerId,
        leaderboardIdentity: normalizeLeaderboardIdentityPreference(leaderboardIdentity),
        redditUsername: sanitizeRedditUsername(redditUsername) || previousProfile?.redditUsername || null,
        hasSeenGame: true,
        hasAnyData: Boolean(hasAnyData || previousProfile?.hasAnyData),
        firstSeenAt: previousProfile?.firstSeenAt || nowIso,
        lastSeenAt: nowIso,
        updatedAt: nowIso,
    };

    await redis.hSet(
        createRedisPlayerProfileHashKey(),
        { [playerId]: JSON.stringify(nextProfile) },
    );
    await ensurePlayerProfileTtl();
    return nextProfile;
}

async function readPlayerProfileMap(playerIds: string[]): Promise<Map<string, DailyGpPlayerProfile>> {
    const uniquePlayerIds = [...new Set(playerIds.filter((playerId) => typeof playerId === 'string' && playerId))];
    if (!uniquePlayerIds.length) {
        return new Map();
    }

    const rawProfiles = await redis.hMGet(createRedisPlayerProfileHashKey(), uniquePlayerIds);
    const profileMap = new Map<string, DailyGpPlayerProfile>();

    uniquePlayerIds.forEach((playerId, index) => {
        const parsed = parseStoredPlayerProfile(rawProfiles[index]);
        if (parsed) {
            profileMap.set(playerId, parsed);
        }
    });

    return profileMap;
}

function toSnapshotRow(
    entry: DailyGpLeaderboardEntry,
    rank: number,
    currentPlayerId: string | null,
    profileMap: Map<string, DailyGpPlayerProfile>,
): SnapshotRow {
    const profile = profileMap.get(entry.playerId);
    return {
        rank,
        rankLabel: formatRankLabel(rank) || '--',
        playerId: entry.playerId,
        displayName: resolveLeaderboardDisplayName({
            playerId: entry.playerId,
            preference: profile?.leaderboardIdentity,
            redditUsername: profile?.redditUsername,
        }),
        bestTime: entry.bestTimeMs / 1000,
        bestTimeMs: entry.bestTimeMs,
        updatedAt: entry.updatedAt,
        isCurrentPlayer: entry.playerId === currentPlayerId,
        completedLaps: null,
    };
}

async function readRowsByRankRange(
    challengeId: string,
    start: number,
    stop: number,
    currentPlayerId: string | null,
): Promise<SnapshotRow[]> {
    if (stop < start || start < 0) {
        return [];
    }

    const leaderboardKey = createRedisChallengeLeaderboardKey(challengeId);
    const entryHashKey = createRedisChallengeEntryHashKey(challengeId);
    const rankedMembers = await redis.zRange(leaderboardKey, start, stop);
    if (!rankedMembers.length) {
        return [];
    }

    const rawEntries = await redis.hMGet(
        entryHashKey,
        rankedMembers.map((member) => member.member),
    );
    const profileMap = await readPlayerProfileMap(
        rankedMembers.map((member) => member.member),
    );

    return rankedMembers
        .map((member, index) => {
            const storedEntry = parseStoredEntry(rawEntries[index]);
            if (!storedEntry) return null;
            return toSnapshotRow(storedEntry, start + index + 1, currentPlayerId, profileMap);
        })
        .filter((entry): entry is SnapshotRow => Boolean(entry));
}

async function readEntryByPlayerId(
    challengeId: string,
    playerId: string,
): Promise<DailyGpLeaderboardEntry | null> {
    const rawEntry = await redis.hGet(createRedisChallengeEntryHashKey(challengeId), playerId);
    return parseStoredEntry(rawEntry);
}

async function ensureLeaderboardTtl(challengeId: string): Promise<void> {
    await Promise.all([
        redis.expire(createRedisChallengeLeaderboardKey(challengeId), DAILY_GP_REDIS_TTL_SECONDS),
        redis.expire(createRedisChallengeEntryHashKey(challengeId), DAILY_GP_REDIS_TTL_SECONDS),
    ]);
}

export async function getServerDailyGpChallenge(): Promise<DailyGpChallenge> {
    return buildDailyGpChallenge();
}

export async function getServerPlayerBootstrap({
    playerId,
    redditUsername,
    leaderboardIdentity,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    leaderboardIdentity?: unknown;
} = {}): Promise<PlayerBootstrapPayload> {
    const canonicalPlayerId = resolveCanonicalPlayerId({ playerId, redditUsername });
    const safeRequestRedditUsername = sanitizeRedditUsername(redditUsername);

    if (!canonicalPlayerId) {
        return {
            playerId: null,
            redditUsername: safeRequestRedditUsername,
            hasAnyData: false,
            isReturningPlayer: false,
            firstSeenAt: null,
            lastSeenAt: null,
        };
    }

    const previousProfile = await readPlayerProfile(canonicalPlayerId);
    const profile = await upsertPlayerProfile({
        playerId: canonicalPlayerId,
        leaderboardIdentity,
        redditUsername,
        hasAnyData: false,
    });
    const firstSeenMs = Date.parse(profile.firstSeenAt);
    const isReturningPlayer = profile.hasSeenGame
        && Number.isFinite(firstSeenMs)
        && (Date.now() - firstSeenMs) > RETURNING_PLAYER_DELAY_MS;

    return {
        playerId: canonicalPlayerId,
        redditUsername: safeRequestRedditUsername,
        hasAnyData: previousProfile ? (profile.hasSeenGame || profile.hasAnyData) : false,
        isReturningPlayer,
        firstSeenAt: profile.firstSeenAt,
        lastSeenAt: profile.lastSeenAt,
    };
}

export async function getServerDailyGpSnapshot({
    challengeId,
    playerId,
    leaderboardIdentity,
    redditUsername,
    limit = DAILY_GP_DEFAULT_LIMIT,
    communityMemberTotal,
}: {
    challengeId?: string | null;
    playerId?: string | null;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    limit?: unknown;
    /** Subreddit subscriber count (or similar) for rank denominator and unfilled leaderboard slots. */
    communityMemberTotal?: unknown;
} = {}): Promise<SnapshotPayload> {
    const challenge = await getServerDailyGpChallenge();
    if (challengeId && challengeId !== challenge.id) {
        return createEmptySnapshot(challenge);
    }

    const safeLimit = normalizeLimit(limit);
    const leaderboardKey = createRedisChallengeLeaderboardKey(challenge.id);
    const leaderboardEntryCount = await redis.zCard(leaderboardKey);
    const communityFloor = normalizeCommunityMemberTotal(communityMemberTotal);
    const totalCount = communityFloor != null
        ? Math.max(leaderboardEntryCount, communityFloor)
        : leaderboardEntryCount;

    if (leaderboardEntryCount === 0 && totalCount === 0) {
        return createEmptySnapshot(challenge);
    }

    const normalizedPlayerId = resolveCanonicalPlayerId({ playerId, redditUsername });
    if (normalizedPlayerId) {
        await upsertPlayerProfile({
            playerId: normalizedPlayerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: false,
        });
    }
    const topRows = leaderboardEntryCount
        ? await readRowsByRankRange(challenge.id, 0, safeLimit - 1, normalizedPlayerId)
        : [];
    const playerRankZeroBased = normalizedPlayerId && leaderboardEntryCount
        ? await redis.zRank(leaderboardKey, normalizedPlayerId)
        : undefined;
    const playerRank = Number.isFinite(playerRankZeroBased)
        ? Number(playerRankZeroBased) + 1
        : null;

    const playerInTop = normalizedPlayerId
        ? topRows.find((row) => row.playerId === normalizedPlayerId) || null
        : null;

    if (playerInTop) {
        return {
            topRows,
            nearbyRows: [],
            currentPlayerRow: {
                ...playerInTop,
                isCurrentPlayer: true,
            },
            totalCount,
            leaderboardEntryCount,
            objectiveType: challenge.objectiveType,
            playerRank,
            playerRankLabel: formatRankLabel(playerRank),
        };
    }

    let currentPlayerRow: SnapshotRow | null = null;
    if (normalizedPlayerId && playerRank) {
        const storedEntry = await readEntryByPlayerId(challenge.id, normalizedPlayerId);
        if (storedEntry) {
            const profileMap = await readPlayerProfileMap([normalizedPlayerId]);
            currentPlayerRow = toSnapshotRow(storedEntry, playerRank, normalizedPlayerId, profileMap);
            currentPlayerRow.isCurrentPlayer = true;
        }
    }

    let nearbyRows: SnapshotRow[] = [];
    if (playerRank && playerRank > safeLimit && leaderboardEntryCount) {
        const nearbyStart = Math.max(0, playerRank - DAILY_GP_NEARBY_RADIUS - 1);
        const nearbyStop = nearbyStart + (DAILY_GP_NEARBY_RADIUS * 2);
        nearbyRows = await readRowsByRankRange(challenge.id, nearbyStart, nearbyStop, normalizedPlayerId);
    }

    return {
        topRows: playerRank && playerRank > safeLimit
            ? topRows.slice(0, DAILY_GP_TOP_ROWS_LIMIT)
            : topRows,
        nearbyRows,
        currentPlayerRow,
        totalCount,
        leaderboardEntryCount,
        objectiveType: challenge.objectiveType,
        playerRank,
        playerRankLabel: formatRankLabel(playerRank),
    };
}

export async function submitServerDailyGpRun({
    playerId,
    challengeId,
    leaderboardIdentity,
    redditUsername,
    bestTime,
}: {
    playerId?: unknown;
    challengeId?: unknown;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    bestTime?: unknown;
}) {
    const challenge = await getServerDailyGpChallenge();
    if (challengeId !== challenge.id) {
        return {
            status: 409,
            body: {
                accepted: false,
                error: 'Daily challenge has rotated.',
                challengeId: challenge.id,
            },
        };
    }

    if (!resolveCanonicalPlayerId({ playerId, redditUsername }) || !isValidDailyGpTime(bestTime)) {
        return {
            status: 400,
            body: {
                accepted: false,
                error: 'Invalid Mini Racer submission.',
            },
        };
    }

    const normalizedPlayerId = resolveCanonicalPlayerId({ playerId, redditUsername });
    if (!normalizedPlayerId) {
        return {
            status: 400,
            body: {
                accepted: false,
                error: 'Player identity is unavailable.',
            },
        };
    }
    await upsertPlayerProfile({
        playerId: normalizedPlayerId,
        leaderboardIdentity,
        redditUsername,
        hasAnyData: true,
    });
    const nextBestTimeMs = toBestTimeMs(Number(bestTime));
    const previousEntry = await readEntryByPlayerId(challenge.id, normalizedPlayerId);
    if (previousEntry && previousEntry.bestTimeMs <= nextBestTimeMs) {
        return {
            status: 200,
            body: {
                accepted: true,
                bestTimeMs: previousEntry.bestTimeMs,
                completedLaps: null,
            },
        };
    }

    const nextEntry: DailyGpLeaderboardEntry = {
        playerId: normalizedPlayerId,
        bestTimeMs: nextBestTimeMs,
        updatedAt: new Date().toISOString(),
        completedLaps: null,
    };

    await redis.hSet(
        createRedisChallengeEntryHashKey(challenge.id),
        { [normalizedPlayerId]: JSON.stringify(nextEntry) },
    );
    await redis.zAdd(
        createRedisChallengeLeaderboardKey(challenge.id),
        {
            member: normalizedPlayerId,
            score: encodeDailyGpLeaderboardScore(nextBestTimeMs),
        },
    );
    await ensureLeaderboardTtl(challenge.id);

    return {
        status: 200,
        body: {
            accepted: true,
            bestTimeMs: nextBestTimeMs,
            completedLaps: null,
        },
    };
}
