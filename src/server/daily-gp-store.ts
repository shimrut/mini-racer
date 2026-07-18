import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    DEFAULT_TRACK_KEY,
    getTrackName,
    hasTrack,
    TRACK_SCHEDULE_KEYS,
} from '../../game/track/catalog.js';
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
    DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS,
    DAILY_GP_DEFAULT_LIMIT,
    DAILY_GP_GUEST_PROFILE_TTL_SECONDS,
    DAILY_GP_NEARBY_RADIUS,
    DAILY_GP_PLAYLIST_DAYS,
    DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS,
    encodeDailyGpLeaderboardScore,
    formatRankLabel,
    formatUtcChallengeDate,
    getUtcDayIndex,
    getDailyGpCompetitionTtlSeconds,
    isDailyGpChallengePlayable,
    type DailyGpChallenge,
    type DailyGpLeaderboardEntry,
    type DailyGpPlayerPreferences,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { getBackfilledDailyGpChallenge } from './daily-gp-history-backfill.js';
import type { FinalDailyGpPodium } from './daily-podium-model.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';
import { mintGuestPlayerToken, verifyGuestPlayerToken } from './player-token.js';
import {
    getPlayerTrackPbRecord,
    seedPlayerTrackPersonalBest,
    upsertPlayerTrackPersonalBest,
} from './pb-ghost-store.js';

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
    pageOffset: number;
    pageLimit: number;
    hasMore: boolean;
    nextOffset: number | null;
};

type PlayerBootstrapPayload = {
    playerId: string | null;
    guestToken: string | null;
    redditUsername: string | null;
    leaderboardIdentity: 'constructed' | 'reddit';
    playerPreferences: DailyGpPlayerPreferences | null;
    hasAnyData: boolean;
    isReturningPlayer: boolean;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
};

const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;
const DAILY_GP_CHALLENGE_HISTORY_HASH_KEY = 'dailygp:challenges';
const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_CURSOR_KEY = 'dailygp:maintenance:challenge-history:v1:cursor';
const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_BATCH_SIZE = 50;
const DAILY_GP_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60;
const DAILY_GP_SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 12;
const DAILY_GP_SUBMISSION_LOCK_TTL_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function createSubmissionRateLimitKey(challengeId: string, rateLimitIdentity: string): string {
    return `dailygp:submit-rate-limit:${challengeId}:${rateLimitIdentity}`;
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
        pageOffset: 0,
        pageLimit: DAILY_GP_DEFAULT_LIMIT,
        hasMore: false,
        nextOffset: null,
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
        if (!hasTrack(trackKey)) {
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

async function maintainChallengeHistory(now = new Date()): Promise<void> {
    try {
        const storedCursor = Number(await redis.get(DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_CURSOR_KEY));
        const cursor = Number.isFinite(storedCursor) && storedCursor >= 0 ? storedCursor : 0;
        const page = await redis.hScan(
            DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
            cursor,
            undefined,
            DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_BATCH_SIZE,
        );
        const cutoffMs = now.getTime() - (DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS * 1000);
        const parsedEntries = page.fieldValues.map(({ field, value }) => ({
            field,
            challenge: parseStoredChallenge(value),
        }));
        const expiredFields = parsedEntries.flatMap(({ field, challenge }) => {
            const startsAtMs = challenge ? Date.parse(challenge.startsAt) : Number.NaN;
            return Number.isFinite(startsAtMs) && startsAtMs <= cutoffMs ? [field] : [];
        });
        await Promise.all(parsedEntries.flatMap(({ challenge }) => {
            if (!challenge) return [];
            const ttlSeconds = getDailyGpCompetitionTtlSeconds(challenge, now);
            return [
                redis.expire(createRedisChallengeLeaderboardKey(challenge.id), ttlSeconds),
                redis.expire(createRedisChallengeEntryHashKey(challenge.id), ttlSeconds),
            ];
        }));
        if (expiredFields.length) {
            await redis.hDel(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, expiredFields);
        }
        await redis.set(
            DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_CURSOR_KEY,
            String(page.cursor),
        );
    } catch (error) {
        // Retention cleanup is best-effort and must not prevent challenge publication.
        console.error('Daily GP challenge history maintenance failed:', error);
    }
}

async function writeStoredDailyGpChallenge(challenge: DailyGpChallenge): Promise<DailyGpChallenge> {
    await redis.hSet(
        DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
        { [challenge.id]: JSON.stringify(challenge) },
    );
    await redis.expire(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS);
    await maintainChallengeHistory();
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
 * Catalog-order pointer selection: walk TRACK_SCHEDULE_KEYS one track per day,
 * wrapping at the end. The playhead is the most-recent ledger entry before today
 * (its trackKey). Tomorrow plays the next key after the playhead.
 *
 * Editing the explicit catalog schedule only affects days that have not been
 * written yet; past days are frozen in the ledger. If the playhead trackKey is
 * no longer scheduled or the ledger is empty, fall back to the catalog default.
 */
async function pickNextTrackKeyForToday(todayStartsAt: Date): Promise<string> {
    const pool = TRACK_SCHEDULE_KEYS;
    if (pool.length === 0) {
        return DEFAULT_TRACK_KEY;
    }

    const todayMs = todayStartsAt.getTime();
    const priorEntries = (await readStoredChallengeEntries())
        .filter((entry) => Number.isFinite(Date.parse(entry.startsAt)) && Date.parse(entry.startsAt) < todayMs)
        .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

    const playhead = priorEntries[0]?.trackKey;
    if (!playhead) {
        return pool[0] || DEFAULT_TRACK_KEY;
    }

    const playheadIndex = pool.indexOf(playhead);
    if (playheadIndex === -1) {
        return pool[0] || DEFAULT_TRACK_KEY;
    }

    const nextIndex = (playheadIndex + 1) % pool.length;
    return pool[nextIndex] || pool[0] || DEFAULT_TRACK_KEY;
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
        await redis.expire(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS);
        await maintainChallengeHistory();
        return challenge;
    }

    // Lost the race to another request/scheduler: return the winning entry.
    const reread = await readStoredDailyGpChallenge(challengeId);
    return reread ?? challenge;
}

/**
 * Seed a challenge into the append-only ledger (e.g. from post-bound data).
 * First-writer-wins via hSetNX: an existing day is never overwritten, even when
 * the incoming payload disagrees on track or timing.
 */
export async function persistServerDailyGpChallenge(
    challenge: DailyGpChallenge,
): Promise<DailyGpChallenge> {
    const stored = await readStoredDailyGpChallenge(challenge.id);
    if (stored) {
        return stored;
    }

    const didSet = await redis.hSetNX(
        DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
        challenge.id,
        JSON.stringify(challenge),
    );
    if (didSet) {
        await redis.expire(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS);
        await maintainChallengeHistory();
        return challenge;
    }

    // Lost the race to another writer: return the winning entry.
    const reread = await readStoredDailyGpChallenge(challenge.id);
    return reread ?? challenge;
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

function normalizeOffset(offset: unknown): number {
    if (!Number.isFinite(offset)) {
        return 0;
    }

    return Math.max(Math.trunc(Number(offset)), 0);
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

function normalizePlayerPreferences(value: unknown): DailyGpPlayerPreferences | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const preferences = value as Record<string, unknown>;
    const carSkin = typeof preferences.carSkin === 'string' ? preferences.carSkin.trim() : '';
    const trailId = typeof preferences.trailId === 'string' ? preferences.trailId.trim() : '';
    const crashRestartDelaySec = Number(preferences.crashRestartDelaySec);
    if (
        !carSkin
        || carSkin.length > 160
        || !trailId
        || trailId.length > 32
        || typeof preferences.musicEnabled !== 'boolean'
        || typeof preferences.carAudioEnabled !== 'boolean'
        || typeof preferences.crashAutoRestartEnabled !== 'boolean'
        || (
            preferences.pbGhostEnabled !== undefined
            && typeof preferences.pbGhostEnabled !== 'boolean'
        )
        || !Number.isFinite(crashRestartDelaySec)
        || crashRestartDelaySec < 0
        || crashRestartDelaySec > 1
    ) {
        return null;
    }

    return {
        carSkin,
        trailId,
        musicEnabled: preferences.musicEnabled,
        carAudioEnabled: preferences.carAudioEnabled,
        crashAutoRestartEnabled: preferences.crashAutoRestartEnabled,
        crashRestartDelaySec: Math.round(crashRestartDelaySec * 10) / 10,
        pbGhostEnabled: preferences.pbGhostEnabled !== false,
    };
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
            preferences: normalizePlayerPreferences(parsed.preferences),
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

function createRedisPlayerProfileKey(playerId: string): string {
    const playerKey = createHash('sha256')
        .update(playerId, 'utf8')
        .digest('base64url');
    return `dailygp:player-profile:${playerKey}`;
}

function createPlayerProfileExpirationDate(playerId: string): Date {
    const ttlSeconds = playerId.startsWith('guest:')
        ? DAILY_GP_GUEST_PROFILE_TTL_SECONDS
        : DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS;
    return new Date(Date.now() + ttlSeconds * 1000);
}

async function writePlayerProfile(profile: DailyGpPlayerProfile): Promise<void> {
    await redis.set(
        createRedisPlayerProfileKey(profile.playerId),
        JSON.stringify(profile),
        { expiration: createPlayerProfileExpirationDate(profile.playerId) },
    );
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

function normalizeGuestPlayerId(playerId: unknown): string | null {
    return typeof playerId === 'string' && playerId.trim()
        ? playerId.trim()
        : null;
}

async function resolveAuthorizedPlayerIdentity({
    playerId,
    redditUsername,
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
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

    return {
        canonicalPlayerId: null,
        guestPlayerId: null,
        guestToken: null,
    };
}

async function readPlayerProfile(playerId: string): Promise<DailyGpPlayerProfile | null> {
    const rawProfile = await redis.get(createRedisPlayerProfileKey(playerId));
    return parseStoredPlayerProfile(rawProfile);
}

function buildPlayerProfile({
    playerId,
    leaderboardIdentity,
    redditUsername,
    preferences,
    hasAnyData,
    previousProfile,
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    preferences?: unknown;
    hasAnyData?: boolean;
    previousProfile?: DailyGpPlayerProfile | null;
}): DailyGpPlayerProfile {
    const nowIso = new Date().toISOString();
    return {
        playerId,
        leaderboardIdentity: resolveStoredLeaderboardIdentity(leaderboardIdentity, previousProfile || null),
        redditUsername: sanitizeRedditUsername(redditUsername) || previousProfile?.redditUsername || null,
        preferences: preferences === undefined
            ? previousProfile?.preferences || null
            : normalizePlayerPreferences(preferences),
        hasSeenGame: true,
        hasAnyData: Boolean(hasAnyData || previousProfile?.hasAnyData),
        firstSeenAt: previousProfile?.firstSeenAt || nowIso,
        lastSeenAt: nowIso,
        updatedAt: nowIso,
    };
}

async function claimNewGuestPlayerProfile({
    playerId,
    leaderboardIdentity,
}: {
    playerId?: unknown;
    leaderboardIdentity?: unknown;
}): Promise<{
    canonicalPlayerId: string;
    guestPlayerId: string;
    guestToken: string;
    profile: DailyGpPlayerProfile;
} | null> {
    const guestPlayerId = normalizeGuestPlayerId(playerId);
    if (!guestPlayerId) {
        return null;
    }

    const guestToken = await mintGuestPlayerToken(guestPlayerId);
    if (!guestToken) {
        return null;
    }

    const canonicalPlayerId = `guest:${guestPlayerId}`;
    const profile = buildPlayerProfile({
        playerId: canonicalPlayerId,
        leaderboardIdentity,
        hasAnyData: false,
        previousProfile: null,
    });
    const claimed = await redis.set(
        createRedisPlayerProfileKey(canonicalPlayerId),
        JSON.stringify(profile),
        { nx: true, expiration: createPlayerProfileExpirationDate(canonicalPlayerId) },
    );
    if (!claimed) {
        return null;
    }

    return {
        canonicalPlayerId,
        guestPlayerId,
        guestToken,
        profile,
    };
}

async function upsertPlayerProfile({
    playerId,
    leaderboardIdentity,
    redditUsername,
    preferences,
    hasAnyData,
    previousProfile,
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    preferences?: unknown;
    hasAnyData?: boolean;
    previousProfile?: DailyGpPlayerProfile | null;
}): Promise<DailyGpPlayerProfile> {
    const resolvedPreviousProfile = previousProfile ?? await readPlayerProfile(playerId);
    const nextProfile = buildPlayerProfile({
        playerId,
        leaderboardIdentity,
        redditUsername,
        preferences,
        hasAnyData,
        previousProfile: resolvedPreviousProfile,
    });

    await writePlayerProfile(nextProfile);
    return nextProfile;
}

async function readPlayerProfileMap(playerIds: string[]): Promise<Map<string, DailyGpPlayerProfile>> {
    const uniquePlayerIds = [...new Set(playerIds.filter((playerId) => typeof playerId === 'string' && playerId))];
    if (!uniquePlayerIds.length) {
        return new Map();
    }

    const rawProfiles = await redis.mGet(uniquePlayerIds.map(createRedisPlayerProfileKey));
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

function formatPodiumTime(bestTimeMs: number): string {
    const totalCentiseconds = Math.max(0, Math.round(bestTimeMs / 10));
    const minutes = Math.floor(totalCentiseconds / 6_000);
    const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
    const centiseconds = totalCentiseconds % 100;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

async function readFinalPodiumPositions(
    challenge: DailyGpChallenge,
): Promise<FinalDailyGpPodium['positions']> {
    const rankedMembers = await redis.zRange(
        createRedisChallengeLeaderboardKey(challenge.id),
        0,
        2,
    );
    const rawEntries = rankedMembers.length
        ? await redis.hMGet(
            createRedisChallengeEntryHashKey(challenge.id),
            rankedMembers.map((member) => member.member),
        )
        : [];
    const profileMap = await readPlayerProfileMap(
        rankedMembers.map((member) => member.member),
    );

    const rankedPositions = rankedMembers.map((member, index) => {
        const entry = parseStoredEntry(rawEntries[index], challenge.trackKey);
        if (!entry || entry.playerId !== member.member) return null;
        const profile = profileMap.get(member.member);
        const redditUsername = sanitizeRedditUsername(profile?.redditUsername);
        const usesRedditIdentity = profile?.leaderboardIdentity === 'reddit' && Boolean(redditUsername);
        return {
            rank: (index + 1) as 1 | 2 | 3,
            displayName: resolveLeaderboardDisplayName({
                playerId: member.member,
                preference: profile?.leaderboardIdentity,
                redditUsername,
            }),
            identityType: usesRedditIdentity ? 'reddit' as const : 'private' as const,
            formattedTime: formatPodiumTime(entry.bestTimeMs),
        };
    });

    return ([1, 2, 3] as const).map((rank) => rankedPositions[rank - 1] ?? {
        rank,
        displayName: 'No verified finish',
        identityType: 'empty' as const,
        formattedTime: null,
    }) as FinalDailyGpPodium['positions'];
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

export async function getServerFinalDailyGpPodium(
    now = new Date(),
): Promise<FinalDailyGpPodium | null> {
    const expiredDayIndex = getUtcDayIndex(now) - DAILY_GP_PLAYLIST_DAYS;
    const challengeDate = formatUtcChallengeDate(getUtcDayStart(expiredDayIndex));
    const challengeId = createDailyChallengeId(challengeDate);
    const challenge = await readStoredOrBackfilledDailyGpChallenge(challengeId);
    const availableUntilMs = challenge ? Date.parse(challenge.availableUntil) : Number.NaN;

    if (!challenge || !Number.isFinite(availableUntilMs) || availableUntilMs > now.getTime()) {
        return null;
    }

    return {
        challengeId: challenge.id,
        challengeDate: challenge.challengeDate,
        trackKey: challenge.trackKey,
        trackName: getTrackName(challenge.trackKey, challenge.trackKey),
        positions: await readFinalPodiumPositions(challenge),
    };
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

export async function getServerDailyGpPlayerBest({
    challengeId,
    redditUsername,
}: {
    challengeId?: string | null;
    redditUsername?: string | null;
}): Promise<{ challenge: DailyGpChallenge; bestTimeMs: number } | null> {
    const username = sanitizeRedditUsername(redditUsername);
    const challenge = await getServerDailyGpPlayableChallenge(challengeId);
    if (!username || !challenge) {
        return null;
    }

    const entry = await readEntryByPlayerId(
        challenge.id,
        challenge.trackKey,
        `reddit:${username.toLowerCase()}`,
    );
    return entry ? { challenge, bestTimeMs: entry.bestTimeMs } : null;
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

async function readOrSeedTrackPersonalBest({
    playerId,
    challenge,
}: {
    playerId: string;
    challenge: DailyGpChallenge;
}) {
    const track = TRACKS[challenge.trackKey];
    if (!track) return null;

    const existing = await getPlayerTrackPbRecord({
        playerId,
        challenge,
        track,
    });
    if (existing) return existing;

    const retainedEntry = await readEntryByPlayerId(
        challenge.id,
        challenge.trackKey,
        playerId,
    );
    if (!retainedEntry || retainedEntry.validationMethod !== 'strict-replay') {
        return null;
    }

    const seeded = await seedPlayerTrackPersonalBest({
        playerId,
        challenge,
        track,
        bestTimeMs: retainedEntry.bestTimeMs,
        checkpointTimesSec: retainedEntry.checkpointTimesSec,
        updatedAt: retainedEntry.updatedAt,
    });
    return seeded.record;
}

export async function getServerPlayerTrackPbSummaries({
    challengeIds,
    playerId,
    redditUsername,
    guestToken,
}: {
    challengeIds?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
}): Promise<{
    playerId: string | null;
    trackPbs: Record<string, {
        trackKey: string;
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        ghostAvailable: boolean;
    } | null>;
}> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    if (!identity.canonicalPlayerId) {
        return { playerId: null, trackPbs: {} };
    }

    const requestedIds = Array.isArray(challengeIds)
        ? [...new Set(challengeIds.filter((value): value is string => (
            typeof value === 'string' && Boolean(value)
        )))].slice(0, DAILY_GP_PLAYLIST_DAYS)
        : [];
    const playlist = await getServerDailyGpPlaylist();
    const challengeById = new Map(playlist.map((challenge) => [challenge.id, challenge]));
    const trackPbs: Record<string, {
        trackKey: string;
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        ghostAvailable: boolean;
    } | null> = {};

    for (const challengeId of requestedIds) {
        const challenge = challengeById.get(challengeId);
        if (!challenge) {
            trackPbs[challengeId] = null;
            continue;
        }
        const record = await readOrSeedTrackPersonalBest({
            playerId: identity.canonicalPlayerId,
            challenge,
        });
        trackPbs[challengeId] = record
            ? {
                trackKey: record.trackKey,
                bestTimeMs: record.bestTimeMs,
                checkpointTimesSec: record.checkpointTimesSec,
                ghostAvailable: Boolean(record.ghost),
            }
            : null;
    }

    return {
        playerId: identity.canonicalPlayerId,
        trackPbs,
    };
}

export async function getServerPlayerPbGhost({
    challengeId,
    playerId,
    redditUsername,
    guestToken,
}: {
    challengeId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
}): Promise<{
    playerId: string | null;
    challengeId: string | null;
    trackKey: string | null;
    personalBest: {
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        updatedAt: string;
        ghost: import('./pb-ghost-trace.js').PbGhostTrace | null;
    } | null;
}> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    if (!identity.canonicalPlayerId) {
        return {
            playerId: null,
            challengeId: null,
            trackKey: null,
            personalBest: null,
        };
    }
    const challenge = await getServerDailyGpPlayableChallenge(
        typeof challengeId === 'string' ? challengeId : null,
    );
    if (!challenge) {
        return {
            playerId: identity.canonicalPlayerId,
            challengeId: null,
            trackKey: null,
            personalBest: null,
        };
    }

    const record = await readOrSeedTrackPersonalBest({
        playerId: identity.canonicalPlayerId,
        challenge,
    });
    return {
        playerId: identity.canonicalPlayerId,
        challengeId: challenge.id,
        trackKey: challenge.trackKey,
        personalBest: record
            ? {
                bestTimeMs: record.bestTimeMs,
                checkpointTimesSec: record.checkpointTimesSec,
                updatedAt: record.updatedAt,
                ghost: record.ghost,
            }
            : null,
    };
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
    const safeRequestRedditUsername = sanitizeRedditUsername(redditUsername);
    const suppliedGuestToken = typeof guestToken === 'string' && Boolean(guestToken.trim());
    let identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    let previousProfile: DailyGpPlayerProfile | null = null;
    let profile: DailyGpPlayerProfile | null = null;

    if (!identity.canonicalPlayerId && !safeRequestRedditUsername && !suppliedGuestToken) {
        const claimedGuest = await claimNewGuestPlayerProfile({
            playerId,
            leaderboardIdentity,
        });
        if (claimedGuest) {
            identity = {
                canonicalPlayerId: claimedGuest.canonicalPlayerId,
                guestPlayerId: claimedGuest.guestPlayerId,
                guestToken: claimedGuest.guestToken,
            };
            profile = claimedGuest.profile;
        }
    }

    if (!identity.canonicalPlayerId) {
        return {
            playerId: null,
            guestToken: null,
            redditUsername: safeRequestRedditUsername,
            leaderboardIdentity: 'constructed',
            playerPreferences: null,
            hasAnyData: false,
            isReturningPlayer: false,
            firstSeenAt: null,
            lastSeenAt: null,
        };
    }

    if (!profile) {
        previousProfile = await readPlayerProfile(identity.canonicalPlayerId);
        profile = await upsertPlayerProfile({
            playerId: identity.canonicalPlayerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: false,
            previousProfile,
        });
    }
    const firstSeenMs = Date.parse(profile.firstSeenAt);
    const isReturningPlayer = profile.hasSeenGame
        && Number.isFinite(firstSeenMs)
        && (Date.now() - firstSeenMs) > RETURNING_PLAYER_DELAY_MS;

    return {
        playerId: identity.canonicalPlayerId,
        guestToken: identity.guestToken,
        redditUsername: safeRequestRedditUsername,
        leaderboardIdentity: profile.leaderboardIdentity,
        playerPreferences: profile.preferences,
        hasAnyData: previousProfile ? (profile.hasSeenGame || profile.hasAnyData) : false,
        isReturningPlayer,
        firstSeenAt: profile.firstSeenAt,
        lastSeenAt: profile.lastSeenAt,
    };
}

export async function updateServerPlayerPreferences({
    playerId,
    redditUsername,
    guestToken,
    playerPreferences,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    playerPreferences?: unknown;
} = {}): Promise<{
    playerId: string | null;
    guestToken: string | null;
    playerPreferences: DailyGpPlayerPreferences | null;
}> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    if (!identity.canonicalPlayerId) {
        return { playerId: null, guestToken: null, playerPreferences: null };
    }

    const normalizedPreferences = normalizePlayerPreferences(playerPreferences);
    if (!normalizedPreferences) {
        return {
            playerId: identity.canonicalPlayerId,
            guestToken: identity.guestToken,
            playerPreferences: null,
        };
    }

    const profile = await upsertPlayerProfile({
        playerId: identity.canonicalPlayerId,
        redditUsername,
        preferences: normalizedPreferences,
        hasAnyData: false,
    });
    return {
        playerId: identity.canonicalPlayerId,
        guestToken: identity.guestToken,
        playerPreferences: profile.preferences,
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
    offset = 0,
    communityMemberTotal,
}: {
    challengeId?: string | null;
    playerId?: string | null;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    limit?: unknown;
    offset?: unknown;
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
    const safeOffset = normalizeOffset(offset);
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
    });
    const normalizedPlayerId = identity.canonicalPlayerId;
    if (normalizedPlayerId) {
        await upsertPlayerProfile({
            playerId: normalizedPlayerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: false,
        });
    }
    const topRows = leaderboardEntryCount
        ? await readRowsByRankRange(
            challenge.id,
            challenge.trackKey,
            safeOffset,
            safeOffset + safeLimit - 1,
            normalizedPlayerId,
        )
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
            pageOffset: safeOffset,
            pageLimit: safeLimit,
            hasMore: safeOffset + safeLimit < leaderboardEntryCount,
            nextOffset: safeOffset + safeLimit < leaderboardEntryCount
                ? safeOffset + safeLimit
                : null,
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
    const playerOutsidePage = Boolean(
        playerRank
        && (playerRank <= safeOffset || playerRank > safeOffset + safeLimit)
    );
    if (playerOutsidePage && leaderboardEntryCount) {
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
        topRows,
        nearbyRows,
        currentPlayerRow,
        totalCount,
        leaderboardEntryCount,
        objectiveType: challenge.objectiveType,
        playerRank,
        playerRankLabel: formatRankLabel(playerRank),
        pageOffset: safeOffset,
        pageLimit: safeLimit,
        hasMore: safeOffset + safeLimit < leaderboardEntryCount,
        nextOffset: safeOffset + safeLimit < leaderboardEntryCount
            ? safeOffset + safeLimit
            : null,
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
    requestRateLimitIdentity,
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
    requestRateLimitIdentity?: unknown;
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

    const safeRequestRateLimitIdentity = typeof requestRateLimitIdentity === 'string'
        && requestRateLimitIdentity.trim()
        ? requestRateLimitIdentity.trim()
        : null;
    const rateLimitIdentity = !sanitizeRedditUsername(redditUsername)
        && safeRequestRateLimitIdentity
        ? `request:${safeRequestRateLimitIdentity}`
        : identity.canonicalPlayerId;
    const rateLimitResult = await checkSubmissionRateLimit(challenge.id, rateLimitIdentity);
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
    const track = TRACKS[challenge.trackKey];
    if (!track) {
        return {
            status: 500,
            body: {
                accepted: false,
                error: 'Daily challenge track is unavailable.',
            },
        };
    }
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

    let previousEntry: DailyGpLeaderboardEntry | null = null;
    let dailyPersistence: PromiseSettledResult<{
        interrupted: boolean;
        improved: boolean;
        entry: DailyGpLeaderboardEntry;
    }>;
    let trackPbPersistence: PromiseSettledResult<Awaited<ReturnType<typeof upsertPlayerTrackPersonalBest>>>;
    try {
        previousEntry = await readEntryByPlayerId(challenge.id, challenge.trackKey, normalizedPlayerId);
        const dailyWrite = async () => {
            if (previousEntry && previousEntry.bestTimeMs <= nextBestTimeMs) {
                return { interrupted: false, improved: false, entry: previousEntry };
            }

            const leaderboardKey = createRedisChallengeLeaderboardKey(challenge.id);
            const entryHashKey = createRedisChallengeEntryHashKey(challenge.id);
            const tx = await redis.watch(submissionLock.key);
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
            const competitionTtlSeconds = getDailyGpCompetitionTtlSeconds(challenge);
            await tx.expire(leaderboardKey, competitionTtlSeconds);
            await tx.expire(entryHashKey, competitionTtlSeconds);
            const transactionResults = await tx.exec();
            return {
                interrupted: !Array.isArray(transactionResults) || transactionResults.length === 0,
                improved: true,
                entry: nextEntry,
            };
        };
        const retainedPersonalBest = previousEntry?.validationMethod === 'strict-replay'
            ? {
                bestTimeMs: previousEntry.bestTimeMs,
                checkpointTimesSec: previousEntry.checkpointTimesSec,
                updatedAt: previousEntry.updatedAt,
            }
            : null;
        [dailyPersistence, trackPbPersistence] = await Promise.allSettled([
            dailyWrite(),
            upsertPlayerTrackPersonalBest({
                playerId: normalizedPlayerId,
                challenge,
                track,
                bestTimeMs: nextBestTimeMs,
                checkpointTimesSec: normalizedCheckpointTimesSec,
                ghost: strictReplayOutcome.run.ghost ?? null,
                retainedPersonalBest,
            }),
        ]);
    } finally {
        try {
            await releaseSubmissionLock(submissionLock);
        } catch (error) {
            // Lock cleanup is best-effort; it must not replace a committed outcome.
            console.error('Daily GP submission lock cleanup failed:', error);
        }
    }

    if (dailyPersistence!.status === 'rejected') {
        throw dailyPersistence!.reason;
    }
    if (dailyPersistence!.value.interrupted) {
        return {
            status: 503,
            body: {
                accepted: false,
                error: 'Submission save was interrupted. Retrying automatically.',
            },
        };
    }

    const storedDailyEntry = dailyPersistence!.value.entry;
    const trackPbAvailable = trackPbPersistence!.status === 'fulfilled';
    if (!trackPbAvailable) {
        console.error('Challenge PB persistence failed after a valid Daily GP run:', trackPbPersistence!.reason);
    }
    const trackPbResult = trackPbAvailable ? trackPbPersistence!.value : null;
    return {
        status: 200,
        body: {
            accepted: true,
            improved: dailyPersistence!.value.improved,
            bestTimeMs: storedDailyEntry.bestTimeMs,
            trackPbPersistenceStatus: trackPbAvailable
                ? (trackPbResult!.improved ? 'stored' : 'unchanged')
                : 'unavailable',
            trackPersonalBest: trackPbResult?.record ?? null,
            trackBestTimeMs: trackPbResult?.record.bestTimeMs ?? null,
            trackPbImproved: trackPbResult?.improved ?? false,
            trackGhostAvailable: Boolean(trackPbResult?.record.ghost),
            completedLaps: dailyPersistence!.value.improved
                ? strictReplayOutcome.run.completedLaps
                : null,
            checkpointTimesSec: storedDailyEntry.checkpointTimesSec ?? null,
            validationMethod: storedDailyEntry.validationMethod ?? 'strict-replay',
            strictReplayFailureReason: storedDailyEntry.strictReplayFailureReason ?? null,
        },
    };
}
