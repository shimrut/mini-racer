import { redis } from '@devvit/redis';
import { TRACKS } from '../../game/track/tracks.js';
import {
    normalizeLeaderboardIdentityPreference,
    resolveLeaderboardDisplayName,
    sanitizeRedditUsername,
} from '../../game/shared/leaderboard-identity.js';
import { normalizeCheckpointTimesSec } from '../shared/checkpoint-times.js';
import {
    buildDailyGpChallenge,
    buildDailyGpChallengeById,
    createDailyChallengeId,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    createRedisPlayerProfileHashKey,
    DAILY_GP_DEFAULT_LIMIT,
    DAILY_GP_NEARBY_RADIUS,
    DAILY_GP_PLAYLIST_DAYS,
    DAILY_GP_PLAYER_PROFILE_TTL_SECONDS,
    DAILY_GP_REDIS_TTL_SECONDS,
    DAILY_GP_TOP_ROWS_LIMIT,
    encodeDailyGpLeaderboardScore,
    formatRankLabel,
    getUtcDayIndex,
    isDailyGpChallengePlayable,
    isValidDailyGpTime,
    toBestTimeMs,
    type DailyGpChallenge,
    type DailyGpLeaderboardEntry,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { getBackfilledDailyGpChallenge } from './daily-gp-history-backfill.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';

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
    checkpointTimesSec: number[] | null;
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
    leaderboardIdentity: 'constructed' | 'reddit';
    hasAnyData: boolean;
    isReturningPlayer: boolean;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
};

const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;
const DAILY_GP_CHALLENGE_HISTORY_HASH_KEY = 'dailygp:challenges';
const DAY_MS = 24 * 60 * 60 * 1000;

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

function getUtcDayStart(dayIndex: number): Date {
    return new Date(dayIndex * DAY_MS);
}

function parseStoredChallenge(raw: string | null | undefined): DailyGpChallenge | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const id = typeof parsed.id === 'string' ? parsed.id : '';
        const challengeDate = typeof parsed.challengeDate === 'string' ? parsed.challengeDate : '';
        if (!/^daily-gp-\d{4}-\d{2}-\d{2}$/.test(id) || !challengeDate) {
            return null;
        }

        const trackKey = typeof parsed.trackKey === 'string' ? parsed.trackKey : '';
        if (!trackKey || !TRACKS[trackKey]) {
            return null;
        }

        const startsAt = typeof parsed.startsAt === 'string' ? parsed.startsAt : '';
        const endsAt = typeof parsed.endsAt === 'string' ? parsed.endsAt : '';
        const availableUntil = typeof parsed.availableUntil === 'string' ? parsed.availableUntil : '';
        if (
            !Number.isFinite(Date.parse(startsAt))
            || !Number.isFinite(Date.parse(endsAt))
            || !Number.isFinite(Date.parse(availableUntil))
        ) {
            return null;
        }

        return {
            id,
            challengeDate,
            trackKey,
            startsAt,
            endsAt,
            availableUntil,
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
    } catch (_error) {
        return null;
    }
}

async function readStoredDailyGpChallenge(challengeId: string): Promise<DailyGpChallenge | null> {
    const raw = await redis.hGet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, challengeId);
    return parseStoredChallenge(raw);
}

async function writeStoredDailyGpChallenge(challenge: DailyGpChallenge): Promise<DailyGpChallenge> {
    await redis.hSet(
        DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
        { [challenge.id]: JSON.stringify(challenge) },
    );
    await redis.expire(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, DAILY_GP_REDIS_TTL_SECONDS);
    return challenge;
}

async function readStoredOrBackfilledDailyGpChallenge(challengeId: string): Promise<DailyGpChallenge | null> {
    const stored = await readStoredDailyGpChallenge(challengeId);
    if (stored) {
        return stored;
    }

    const backfilled = getBackfilledDailyGpChallenge(challengeId);
    if (!backfilled) {
        return null;
    }

    return writeStoredDailyGpChallenge(backfilled);
}

export async function persistServerDailyGpChallenge(
    challenge: DailyGpChallenge,
): Promise<DailyGpChallenge> {
    return writeStoredDailyGpChallenge(challenge);
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

function parseStoredEntry(
    raw: string | null | undefined,
    expectedTrackKey?: string,
): DailyGpLeaderboardEntry | null {
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

        const parsedTrackKey = typeof parsed.trackKey === 'string' && parsed.trackKey
            ? parsed.trackKey
            : null;
        if (expectedTrackKey && parsedTrackKey && parsedTrackKey !== expectedTrackKey) {
            return null;
        }

        const bestTimeMs = Number(parsed.bestTimeMs);
        const checkpointTimesSec = normalizeCheckpointTimesSec(
            bestTimeMs / 1000,
            parsed.checkpointTimesSec,
        );

    return {
        playerId: parsed.playerId,
        trackKey: parsedTrackKey || expectedTrackKey || '',
        bestTimeMs,
        updatedAt: parsed.updatedAt,
        completedLaps: null,
        checkpointTimesSec,
        validationMethod: parsed.validationMethod === 'strict-replay' || parsed.validationMethod === 'basic-sanity'
            ? parsed.validationMethod
            : undefined,
        strictReplayFailureReason: typeof parsed.strictReplayFailureReason === 'string'
            ? parsed.strictReplayFailureReason
            : null,
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

function resolveStoredLeaderboardIdentity(
    leaderboardIdentity: unknown,
    previousProfile: DailyGpPlayerProfile | null,
): 'constructed' | 'reddit' {
    if (leaderboardIdentity === 'reddit' || leaderboardIdentity === 'constructed') {
        return leaderboardIdentity;
    }

    return previousProfile?.leaderboardIdentity || 'constructed';
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
    previousProfile,
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    hasAnyData?: boolean;
    previousProfile?: DailyGpPlayerProfile | null;
}): Promise<DailyGpPlayerProfile> {
    const resolvedPreviousProfile = previousProfile ?? await readPlayerProfile(playerId);
    const nowIso = new Date().toISOString();
    const nextProfile: DailyGpPlayerProfile = {
        playerId,
        leaderboardIdentity: resolveStoredLeaderboardIdentity(leaderboardIdentity, resolvedPreviousProfile),
        redditUsername: sanitizeRedditUsername(redditUsername) || resolvedPreviousProfile?.redditUsername || null,
        hasSeenGame: true,
        hasAnyData: Boolean(hasAnyData || resolvedPreviousProfile?.hasAnyData),
        firstSeenAt: resolvedPreviousProfile?.firstSeenAt || nowIso,
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
        checkpointTimesSec: entry.checkpointTimesSec ?? null,
    };
}

async function readRowsByRankRange(
    challengeId: string,
    trackKey: string,
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
            const storedEntry = parseStoredEntry(rawEntries[index], trackKey);
            if (!storedEntry) return null;
            return toSnapshotRow(storedEntry, start + index + 1, currentPlayerId, profileMap);
        })
        .filter((entry): entry is SnapshotRow => Boolean(entry));
}

async function readEntryByPlayerId(
    challengeId: string,
    trackKey: string,
    playerId: string,
): Promise<DailyGpLeaderboardEntry | null> {
    const rawEntry = await redis.hGet(createRedisChallengeEntryHashKey(challengeId), playerId);
    return parseStoredEntry(rawEntry, trackKey);
}

async function ensureLeaderboardTtl(challengeId: string): Promise<void> {
    await Promise.all([
        redis.expire(createRedisChallengeLeaderboardKey(challengeId), DAILY_GP_REDIS_TTL_SECONDS),
        redis.expire(createRedisChallengeEntryHashKey(challengeId), DAILY_GP_REDIS_TTL_SECONDS),
    ]);
}

function getReplayRaceClockFrameCount(replay: unknown): number | null {
    if (!replay || typeof replay !== 'object') return null;
    const inputs = (replay as { inputs?: unknown }).inputs;
    if (!Array.isArray(inputs) || inputs.length === 0) return null;

    let frameCount = 0;
    let raceClockFrameCount = 0;
    for (const rawSegment of inputs) {
        if (!rawSegment || typeof rawSegment !== 'object') return null;
        const segment = rawSegment as Record<string, unknown>;
        const frames = Number(segment.frames);
        if (!Number.isInteger(frames) || frames < 1) return null;
        if (typeof segment.left !== 'boolean') return null;
        if (typeof segment.right !== 'boolean') return null;
        if (typeof segment.relaunchDelay !== 'boolean') return null;
        frameCount += frames;
        if (frameCount > 20_000) return null;
        if (!segment.relaunchDelay) {
            raceClockFrameCount += frames;
        }
    }
    return raceClockFrameCount;
}

function validateBasicDailyGpSubmission({
    challenge,
    bestTime,
    replay,
    checkpointTimesSec,
}: {
    challenge: DailyGpChallenge;
    bestTime?: unknown;
    replay?: unknown;
    checkpointTimesSec?: unknown;
}): { ok: true; bestTimeSec: number; bestTimeMs: number; checkpointTimesSec: number[] | null } | { ok: false; reason: string } {
    if (!isValidDailyGpTime(bestTime)) {
        return { ok: false, reason: 'invalid_time' };
    }

    const bestTimeSec = Number(bestTime);
    const replayRaceClockFrameCount = getReplayRaceClockFrameCount(replay);
    if (!Number.isFinite(replayRaceClockFrameCount)) {
        return { ok: false, reason: 'invalid_replay' };
    }

    const replayRaceClockSec = replayRaceClockFrameCount / 60;
    if (Math.abs(replayRaceClockSec - bestTimeSec) > 0.25) {
        return { ok: false, reason: 'time_replay_mismatch' };
    }

    const track = TRACKS[challenge.trackKey];
    const requiredCheckpointCount = Array.isArray(track?.checkpoints)
        ? track.checkpoints.length
        : 0;
    const normalizedCheckpoints = normalizeCheckpointTimesSec(bestTimeSec, checkpointTimesSec);
    if (requiredCheckpointCount > 0) {
        if (!normalizedCheckpoints || normalizedCheckpoints.length !== requiredCheckpointCount) {
            return { ok: false, reason: 'checkpoint_mismatch' };
        }
    }

    return {
        ok: true,
        bestTimeSec,
        bestTimeMs: toBestTimeMs(bestTimeSec),
        checkpointTimesSec: normalizedCheckpoints ?? null,
    };
}

export async function getServerDailyGpChallenge(): Promise<DailyGpChallenge> {
    const challenge = buildDailyGpChallenge();
    const stored = await readStoredOrBackfilledDailyGpChallenge(challenge.id);
    if (stored) {
        return stored;
    }
    return writeStoredDailyGpChallenge(challenge);
}

export async function getServerDailyGpChallengeById(
    challengeId?: string | null,
    { persistFallback = true }: { persistFallback?: boolean } = {},
): Promise<DailyGpChallenge | null> {
    if (typeof challengeId !== 'string' || !challengeId) {
        return null;
    }

    const stored = await readStoredOrBackfilledDailyGpChallenge(challengeId);
    if (stored) {
        return stored;
    }

    const challenge = buildDailyGpChallengeById(challengeId);
    if (!challenge) {
        return null;
    }

    const activeChallenge = buildDailyGpChallenge();
    if (challenge.id !== activeChallenge.id) {
        return null;
    }

    if (persistFallback) {
        return writeStoredDailyGpChallenge(challenge);
    }
    return challenge;
}

export async function getServerDailyGpPlayableChallenge(challengeId?: string | null): Promise<DailyGpChallenge | null> {
    const challenge = await getServerDailyGpChallengeById(challengeId, { persistFallback: false });
    if (challenge && isDailyGpChallengePlayable(challenge)) {
        return challenge;
    }

    const activeChallenge = buildDailyGpChallenge();
    if (challengeId === activeChallenge.id && isDailyGpChallengePlayable(activeChallenge)) {
        return writeStoredDailyGpChallenge(activeChallenge);
    }

    return null;
}

export async function getServerDailyGpPlaylist(now = new Date()): Promise<DailyGpChallenge[]> {
    const todayIndex = getUtcDayIndex(now);
    const challenges: DailyGpChallenge[] = [];
    const activeChallenge = await getServerDailyGpChallenge();

    for (let offset = 0; offset < DAILY_GP_PLAYLIST_DAYS; offset += 1) {
        const challengeDate = getUtcDayStart(todayIndex - offset).toISOString().slice(0, 10);
        const challengeId = createDailyChallengeId(challengeDate);
        const challenge = challengeId === activeChallenge.id
            ? activeChallenge
            : await readStoredOrBackfilledDailyGpChallenge(challengeId);
        if (challenge && isDailyGpChallengePlayable(challenge, now)) {
            challenges.push(challenge);
        }
    }

    return challenges;
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
            leaderboardIdentity: 'constructed',
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
        previousProfile,
    });
    const firstSeenMs = Date.parse(profile.firstSeenAt);
    const isReturningPlayer = profile.hasSeenGame
        && Number.isFinite(firstSeenMs)
        && (Date.now() - firstSeenMs) > RETURNING_PLAYER_DELAY_MS;

    return {
        playerId: canonicalPlayerId,
        redditUsername: safeRequestRedditUsername,
        leaderboardIdentity: profile.leaderboardIdentity,
        hasAnyData: previousProfile ? (profile.hasSeenGame || profile.hasAnyData) : false,
        isReturningPlayer,
        firstSeenAt: profile.firstSeenAt,
        lastSeenAt: profile.lastSeenAt,
    };
}

export async function updateServerPlayerIdentity({
    playerId,
    redditUsername,
    leaderboardIdentity,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    leaderboardIdentity?: unknown;
} = {}): Promise<{ playerId: string | null; leaderboardIdentity: 'constructed' | 'reddit' }> {
    const canonicalPlayerId = resolveCanonicalPlayerId({ playerId, redditUsername });
    if (!canonicalPlayerId) {
        return {
            playerId: null,
            leaderboardIdentity: 'constructed',
        };
    }

    const profile = await upsertPlayerProfile({
        playerId: canonicalPlayerId,
        leaderboardIdentity,
        redditUsername,
        hasAnyData: false,
    });

    return {
        playerId: canonicalPlayerId,
        leaderboardIdentity: profile.leaderboardIdentity,
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
    const activeChallenge = await getServerDailyGpChallenge();
    const challenge = challengeId
        ? await getServerDailyGpPlayableChallenge(challengeId)
        : activeChallenge;
    if (!challenge) {
        return createEmptySnapshot(activeChallenge);
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
        ? await readRowsByRankRange(challenge.id, challenge.trackKey, 0, safeLimit - 1, normalizedPlayerId)
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
        const storedEntry = await readEntryByPlayerId(challenge.id, challenge.trackKey, normalizedPlayerId);
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
        nearbyRows = await readRowsByRankRange(
            challenge.id,
            challenge.trackKey,
            nearbyStart,
            nearbyStop,
            normalizedPlayerId,
        );
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
    replay,
    checkpointTimesSec,
    trackKey,
}: {
    playerId?: unknown;
    challengeId?: unknown;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    bestTime?: unknown;
    replay?: unknown;
    checkpointTimesSec?: unknown;
    trackKey?: unknown;
}) {
    const challenge = await getServerDailyGpPlayableChallenge(
        typeof challengeId === 'string' ? challengeId : null,
    );
    if (!challenge) {
        const activeChallenge = await getServerDailyGpChallenge();
        return {
            status: 409,
            body: {
                accepted: false,
                error: 'Daily challenge is no longer playable.',
                challengeId: activeChallenge.id,
            },
        };
    }

    if (trackKey !== challenge.trackKey) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission track does not match challenge.',
                reason: 'track_mismatch',
            },
        };
    }

    if (!resolveCanonicalPlayerId({ playerId, redditUsername })) {
        return {
            status: 400,
            body: {
                accepted: false,
                error: 'Invalid Mini Racer submission.',
            },
        };
    }

    const strictReplayOutcome = validateDailyGpReplayDetailed({ challenge, replay });
    const strictReplayPassed = strictReplayOutcome.ok;
    const basicValidation = strictReplayPassed
        ? null
        : validateBasicDailyGpSubmission({
            challenge,
            bestTime,
            replay,
            checkpointTimesSec,
        });
    if (!strictReplayPassed && !basicValidation?.ok) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission sanity checks failed.',
                reason: basicValidation?.reason || strictReplayOutcome.failure.reason,
                strictReplayFailureReason: strictReplayOutcome.failure.reason,
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
    const nextBestTimeSec = strictReplayPassed
        ? strictReplayOutcome.run.bestTimeSec
        : basicValidation.bestTimeSec;
    const nextBestTimeMs = strictReplayPassed
        ? strictReplayOutcome.run.bestTimeMs
        : basicValidation.bestTimeMs;
    const previousEntry = await readEntryByPlayerId(challenge.id, challenge.trackKey, normalizedPlayerId);
    if (previousEntry && previousEntry.bestTimeMs <= nextBestTimeMs) {
        return {
            status: 200,
            body: {
                accepted: true,
                bestTimeMs: previousEntry.bestTimeMs,
                completedLaps: null,
                checkpointTimesSec: previousEntry.checkpointTimesSec ?? null,
            },
        };
    }

    const normalizedCheckpointTimesSec = normalizeCheckpointTimesSec(
        nextBestTimeSec,
        strictReplayPassed ? strictReplayOutcome.run.checkpointTimesSec : basicValidation.checkpointTimesSec,
    ) ?? basicValidation.checkpointTimesSec ?? null;

    const nextEntry: DailyGpLeaderboardEntry = {
        playerId: normalizedPlayerId,
        trackKey: challenge.trackKey,
        bestTimeMs: nextBestTimeMs,
        updatedAt: new Date().toISOString(),
        completedLaps: null,
        checkpointTimesSec: normalizedCheckpointTimesSec,
        validationMethod: strictReplayPassed ? 'strict-replay' : 'basic-sanity',
        strictReplayFailureReason: strictReplayPassed ? null : strictReplayOutcome.failure.reason,
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
            completedLaps: strictReplayPassed ? strictReplayOutcome.run.completedLaps : null,
            checkpointTimesSec: nextEntry.checkpointTimesSec,
            validationMethod: nextEntry.validationMethod,
            strictReplayFailureReason: nextEntry.strictReplayFailureReason,
        },
    };
}
