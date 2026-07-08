import { redis } from '@devvit/redis';
import { TRACKS } from '../../game/track/tracks.js';
import {
    normalizeLeaderboardIdentityPreference,
    resolveLeaderboardDisplayName,
    sanitizeRedditUsername,
} from '../../game/shared/leaderboard-identity.js';
import { normalizeCheckpointTimesSec } from '../../game/shared/checkpoint-times.js';
import {
    buildDailyGpChallengeForDayIndexWithTrack,
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
    formatUtcChallengeDate,
    getUtcDayIndex,
    isDailyGpChallengePlayable,
    type DailyGpChallenge,
    type DailyGpLeaderboardEntry,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { getBackfilledDailyGpChallenge } from './daily-gp-history-backfill.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';
import { mintGuestPlayerToken, verifyGuestPlayerToken } from './player-token.js';

type SnapshotRow = {
    rank: number;
    rankLabel: string;
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
    guestToken: string | null;
    redditUsername: string | null;
    leaderboardIdentity: 'constructed' | 'reddit';
    hasAnyData: boolean;
    isReturningPlayer: boolean;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
};

const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;
const DAILY_GP_CHALLENGE_HISTORY_HASH_KEY = 'dailygp:challenges';
const DAILY_GP_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60;
const DAILY_GP_SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 12;
const DAILY_GP_SUBMISSION_LOCK_TTL_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function createSubmissionRateLimitKey(challengeId: string, playerId: string): string {
    return `dailygp:submit-rate-limit:${challengeId}:${playerId}`;
}

function createSubmissionLockKey(challengeId: string, playerId: string): string {
    return `dailygp:submit-lock:${challengeId}:${playerId}`;
}

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

async function readStoredChallengeEntries(): Promise<DailyGpChallenge[]> {
    const rawMap = await redis.hGetAll(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY);
    if (!rawMap) {
        return [];
    }
    const entries: DailyGpChallenge[] = [];
    for (const raw of Object.values(rawMap)) {
        const parsed = parseStoredChallenge(typeof raw === 'string' ? raw : null);
        if (parsed) {
            entries.push(parsed);
        }
    }
    return entries;
}

/**
 * File-order pointer selection. tracks.js is the schedule: walk its key order
 * one track per day, wrapping at the end. The playhead is the most-recent ledger
 * entry before today (its trackKey). Tomorrow plays the next key after the
 * playhead in the current Object.keys(TRACKS) order, wrapping to index 0.
 *
 * Editing tracks.js (append, insert, reorder, remove) only affects days that have
 * not been written yet; past days are frozen in the ledger. If the playhead
 * trackKey is no longer in the file (removed) or the ledger is empty, fall back
 * to the first key.
 */
async function pickNextTrackKeyForToday(todayStartsAt: Date): Promise<string> {
    const pool = Object.keys(TRACKS);
    if (pool.length === 0) {
        return 'circuit';
    }

    const todayMs = todayStartsAt.getTime();
    const priorEntries = (await readStoredChallengeEntries())
        .filter((entry) => Number.isFinite(Date.parse(entry.startsAt)) && Date.parse(entry.startsAt) < todayMs)
        .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

    const playhead = priorEntries[0]?.trackKey;
    if (!playhead) {
        return pool[0];
    }

    const playheadIndex = pool.indexOf(playhead);
    if (playheadIndex === -1) {
        return pool[0];
    }

    const nextIndex = (playheadIndex + 1) % pool.length;
    return pool[nextIndex] || pool[0];
}

function getTodayChallengeId(): string {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = getUtcDayStart(dayIndex);
    return createDailyChallengeId(formatUtcChallengeDate(startsAt));
}

/**
 * Resolve today's challenge without writing it. Used by callers that only need
 * to inspect/playability-check today's track without committing it to the ledger.
 */
async function pickTodayDailyGpChallenge(): Promise<DailyGpChallenge> {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = getUtcDayStart(dayIndex);
    const challengeId = createDailyChallengeId(formatUtcChallengeDate(startsAt));

    const stored = await readStoredOrBackfilledDailyGpChallenge(challengeId);
    if (stored) {
        return stored;
    }

    const trackKey = await pickNextTrackKeyForToday(startsAt);
    return buildDailyGpChallengeForDayIndexWithTrack(dayIndex, trackKey);
}

/**
 * Resolve today's challenge, creating it via the append-only ledger if it does
 * not exist yet. First-writer-wins via hSetNX so concurrent requests and the
 * 00:05 UTC scheduler cannot create duplicate entries for the same day.
 */
async function resolveTodayDailyGpChallenge(): Promise<DailyGpChallenge> {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = getUtcDayStart(dayIndex);
    const challengeId = createDailyChallengeId(formatUtcChallengeDate(startsAt));

    const stored = await readStoredOrBackfilledDailyGpChallenge(challengeId);
    if (stored) {
        return stored;
    }

    const trackKey = await pickNextTrackKeyForToday(startsAt);
    const challenge = buildDailyGpChallengeForDayIndexWithTrack(dayIndex, trackKey);

    const didSet = await redis.hSetNX(
        DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
        challengeId,
        JSON.stringify(challenge),
    );
    if (didSet) {
        await redis.expire(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, DAILY_GP_REDIS_TTL_SECONDS);
        return challenge;
    }

    // Lost the race to another request/scheduler: return the winning entry.
    const reread = await readStoredDailyGpChallenge(challengeId);
    return reread ?? challenge;
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
        validationMethod: parsed.validationMethod === 'strict-replay'
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

function normalizeGuestPlayerId(playerId: unknown): string | null {
    return typeof playerId === 'string' && playerId.trim()
        ? playerId.trim()
        : null;
}

async function resolveAuthorizedPlayerIdentity({
    playerId,
    redditUsername,
    guestToken,
    allowUnsignedGuest = false,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    allowUnsignedGuest?: boolean;
}): Promise<{
    canonicalPlayerId: string | null;
    guestPlayerId: string | null;
    guestToken: string | null;
}> {
    const safeUsername = sanitizeRedditUsername(redditUsername);
    if (safeUsername) {
        return {
            canonicalPlayerId: `reddit:${safeUsername.toLowerCase()}`,
            guestPlayerId: null,
            guestToken: null,
        };
    }

    const normalizedGuestToken = typeof guestToken === 'string' && guestToken.trim()
        ? guestToken.trim()
        : null;
    if (normalizedGuestToken) {
        const verifiedGuestPlayerId = await verifyGuestPlayerToken(normalizedGuestToken);
        if (!verifiedGuestPlayerId) {
            return {
                canonicalPlayerId: null,
                guestPlayerId: null,
                guestToken: null,
            };
        }

        const normalizedGuestPlayerId = normalizeGuestPlayerId(playerId);
        if (normalizedGuestPlayerId && normalizedGuestPlayerId !== verifiedGuestPlayerId) {
            return {
                canonicalPlayerId: null,
                guestPlayerId: null,
                guestToken: null,
            };
        }

        return {
            canonicalPlayerId: `guest:${verifiedGuestPlayerId}`,
            guestPlayerId: verifiedGuestPlayerId,
            guestToken: normalizedGuestToken,
        };
    }

    if (!allowUnsignedGuest) {
        return {
            canonicalPlayerId: null,
            guestPlayerId: null,
            guestToken: null,
        };
    }

    const normalizedGuestPlayerId = normalizeGuestPlayerId(playerId);
    if (!normalizedGuestPlayerId) {
        return {
            canonicalPlayerId: null,
            guestPlayerId: null,
            guestToken: null,
        };
    }

    return {
        canonicalPlayerId: `guest:${normalizedGuestPlayerId}`,
        guestPlayerId: normalizedGuestPlayerId,
        guestToken: await mintGuestPlayerToken(normalizedGuestPlayerId),
    };
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

async function checkSubmissionRateLimit(
    challengeId: string,
    playerId: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    const rateLimitKey = createSubmissionRateLimitKey(challengeId, playerId);
    const attemptCount = await redis.incrBy(rateLimitKey, 1);
    if (attemptCount === 1) {
        await redis.expire(rateLimitKey, DAILY_GP_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS);
    }
    if (attemptCount <= DAILY_GP_SUBMISSION_RATE_LIMIT_MAX_REQUESTS) {
        return { allowed: true };
    }

    const expiresAt = await redis.expireTime(rateLimitKey);
    const retryAfterSeconds = Number.isFinite(expiresAt) && expiresAt > 0
        ? Math.max(1, expiresAt - Math.floor(Date.now() / 1000))
        : DAILY_GP_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS;
    return {
        allowed: false,
        retryAfterSeconds,
    };
}

async function acquireSubmissionLock(
    challengeId: string,
    playerId: string,
): Promise<{ key: string; value: string } | null> {
    const key = createSubmissionLockKey(challengeId, playerId);
    const value = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const response = await redis.set(
        key,
        value,
        { nx: true, expiration: new Date(Date.now() + DAILY_GP_SUBMISSION_LOCK_TTL_MS) },
    );
    return response ? { key, value } : null;
}

async function releaseSubmissionLock(lock: { key: string; value: string } | null): Promise<void> {
    if (!lock) {
        return;
    }

    const currentValue = await redis.get(lock.key);
    if (currentValue === lock.value) {
        await redis.del(lock.key);
    }
}

export async function getServerDailyGpChallenge(): Promise<DailyGpChallenge> {
    return resolveTodayDailyGpChallenge();
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

    if (challengeId !== getTodayChallengeId()) {
        return null;
    }

    if (persistFallback) {
        return resolveTodayDailyGpChallenge();
    }
    return pickTodayDailyGpChallenge();
}

export async function getServerDailyGpPlayableChallenge(challengeId?: string | null): Promise<DailyGpChallenge | null> {
    const challenge = await getServerDailyGpChallengeById(challengeId, { persistFallback: false });
    if (challenge && isDailyGpChallengePlayable(challenge)) {
        return challenge;
    }

    if (challengeId === getTodayChallengeId()) {
        const activeChallenge = await resolveTodayDailyGpChallenge();
        if (isDailyGpChallengePlayable(activeChallenge)) {
            return activeChallenge;
        }
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
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    leaderboardIdentity?: unknown;
    guestToken?: unknown;
} = {}): Promise<PlayerBootstrapPayload> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
        allowUnsignedGuest: true,
    });
    const canonicalPlayerId = identity.canonicalPlayerId;
    const safeRequestRedditUsername = sanitizeRedditUsername(redditUsername);

    if (!canonicalPlayerId) {
        return {
            playerId: null,
            guestToken: null,
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
        guestToken: identity.guestToken,
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
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    leaderboardIdentity?: unknown;
    guestToken?: unknown;
} = {}): Promise<{ playerId: string | null; guestToken: string | null; leaderboardIdentity: 'constructed' | 'reddit' }> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
        allowUnsignedGuest: true,
    });
    const canonicalPlayerId = identity.canonicalPlayerId;
    if (!canonicalPlayerId) {
        return {
            playerId: null,
            guestToken: null,
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
        guestToken: identity.guestToken,
        leaderboardIdentity: profile.leaderboardIdentity,
    };
}

export async function getServerDailyGpSnapshot({
    challengeId,
    playerId,
    leaderboardIdentity,
    redditUsername,
    guestToken,
    limit = DAILY_GP_DEFAULT_LIMIT,
    communityMemberTotal,
}: {
    challengeId?: string | null;
    playerId?: string | null;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
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

    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
        allowUnsignedGuest: true,
    });
    const normalizedPlayerId = identity.canonicalPlayerId
        || resolveCanonicalPlayerId({ playerId, redditUsername });
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
        ? topRows.find((row) => row.isCurrentPlayer) || null
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
    guestToken,
    bestTime,
    replay,
    checkpointTimesSec,
    trackKey,
}: {
    playerId?: unknown;
    challengeId?: unknown;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
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

    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
        allowUnsignedGuest: false,
    });
    if (!identity.canonicalPlayerId) {
        return {
            status: 400,
            body: {
                accepted: false,
                error: 'Invalid Mini Racer submission.',
            },
        };
    }

    const rateLimitResult = await checkSubmissionRateLimit(challenge.id, identity.canonicalPlayerId);
    if (!rateLimitResult.allowed) {
        return {
            status: 429,
            body: {
                accepted: false,
                error: 'Too many submission attempts. Try again soon.',
                retryAfterSeconds: rateLimitResult.retryAfterSeconds,
            },
        };
    }

    const strictReplayOutcome = validateDailyGpReplayDetailed({ challenge, replay });
    if (!strictReplayOutcome.ok) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: strictReplayOutcome.failure.reason,
                strictReplayFailureReason: strictReplayOutcome.failure.reason,
            },
        };
    }

    const normalizedPlayerId = identity.canonicalPlayerId;
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
    const nextBestTimeSec = strictReplayOutcome.run.bestTimeSec;
    const nextBestTimeMs = strictReplayOutcome.run.bestTimeMs;
    const normalizedCheckpointTimesSec = normalizeCheckpointTimesSec(
        nextBestTimeSec,
        strictReplayOutcome.run.checkpointTimesSec,
    ) ?? strictReplayOutcome.run.checkpointTimesSec ?? null;

    const nextEntry: DailyGpLeaderboardEntry = {
        playerId: normalizedPlayerId,
        trackKey: challenge.trackKey,
        bestTimeMs: nextBestTimeMs,
        updatedAt: new Date().toISOString(),
        completedLaps: null,
        checkpointTimesSec: normalizedCheckpointTimesSec,
        validationMethod: 'strict-replay',
        strictReplayFailureReason: null,
    };

    const submissionLock = await acquireSubmissionLock(challenge.id, normalizedPlayerId);
    if (!submissionLock) {
        return {
            status: 429,
            body: {
                accepted: false,
                error: 'Submission already in progress. Try again in a moment.',
                retryAfterSeconds: 1,
            },
        };
    }

    try {
        const previousEntry = await readEntryByPlayerId(challenge.id, challenge.trackKey, normalizedPlayerId);
        if (previousEntry && previousEntry.bestTimeMs <= nextBestTimeMs) {
            return {
                status: 200,
                body: {
                    accepted: true,
                    bestTimeMs: previousEntry.bestTimeMs,
                    completedLaps: null,
                    checkpointTimesSec: previousEntry.checkpointTimesSec ?? null,
                    validationMethod: previousEntry.validationMethod ?? 'strict-replay',
                    strictReplayFailureReason: previousEntry.strictReplayFailureReason ?? null,
                },
            };
        }

        const leaderboardKey = createRedisChallengeLeaderboardKey(challenge.id);
        const entryHashKey = createRedisChallengeEntryHashKey(challenge.id);
        const tx = await redis.watch(entryHashKey, leaderboardKey);
        await tx.multi();
        await tx.hSet(
            entryHashKey,
            { [normalizedPlayerId]: JSON.stringify(nextEntry) },
        );
        await tx.zAdd(
            leaderboardKey,
            {
                member: normalizedPlayerId,
                score: encodeDailyGpLeaderboardScore(nextBestTimeMs),
            },
        );
        await tx.expire(leaderboardKey, DAILY_GP_REDIS_TTL_SECONDS);
        await tx.expire(entryHashKey, DAILY_GP_REDIS_TTL_SECONDS);
        await tx.exec();
    } finally {
        await releaseSubmissionLock(submissionLock);
    }

    return {
        status: 200,
        body: {
            accepted: true,
            bestTimeMs: nextBestTimeMs,
            completedLaps: strictReplayOutcome.run.completedLaps,
            checkpointTimesSec: nextEntry.checkpointTimesSec,
            validationMethod: nextEntry.validationMethod,
            strictReplayFailureReason: nextEntry.strictReplayFailureReason,
        },
    };
}
