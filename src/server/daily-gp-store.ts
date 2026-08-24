import { redis } from '@devvit/redis';
import { redisCompressed } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    DEFAULT_TRACK_KEY,
    getTrackName,
    hasTrack,
    TRACK_SCHEDULE_KEYS,
} from '../../game/track/catalog.js';
import { TRACKS } from '../../game/track/tracks.js';
import { formatRaceTime } from './format-race-time.js';
import {
    resolveLeaderboardDisplayName,
    sanitizeRedditUsername,
} from '../../game/shared/leaderboard-identity.js';
import {
    buildDailyGpChallengeForDayIndexWithTrack,
    createDailyChallengeId,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    createRedisChallengeStandingsRevisionKey,
    DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
    DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS,
    DAILY_GP_DEFAULT_LIMIT,
    DAILY_GP_PLAYLIST_DAYS,
    formatRankLabel,
    formatUtcChallengeDate,
    getUtcDayIndex,
    getDailyGpCompetitionTtlSeconds,
    isDailyGpChallengePlayable,
    normalizeDailyGpRaceContract,
    type DailyGpChallenge,
    type DailyGpPlayerPreferences,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { getBackfilledDailyGpChallenge } from './daily-gp-history-backfill.js';
import type { FinalDailyGpPodium } from './daily-podium-model.js';
import { toDailyCompetition } from './competition.js';
import { prepareCompetitionOpponentRace } from './competition-opponent-race.js';
import {
    createEmptySnapshot,
    parseStoredEntry,
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
    writeEntry,
    type SnapshotPayload,
} from './competition-leaderboard.js';
import {
    adoptExistingGuestPlayerProfile,
    claimNewGuestPlayerProfile,
    normalizePlayerPreferences,
    readPlayerProfile,
    readPlayerProfileMap,
    resolveAuthorizedPlayerIdentity,
    upsertPlayerProfile,
} from './competition-identity.js';
import {
    challengeCollectionKey,
    getPlayerTrackPbRecord,
    seedPlayerTrackPersonalBest,
} from './pb-ghost-store.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from './redis-lock.js';
import {
    getCarUnlockSnapshot,
    discardGuestCarUnlockProgress,
    hasCarUnlockProgress,
    mergeGuestCarUnlockProgress,
    readGuestPromotionTarget,
    recordCompletedRace,
    retireEmptyGuestIdentity,
    type CarUnlockSnapshot,
} from './car-unlock-store.js';
import {
    discardGuestCampaignProgress,
    getCampaignResultsForCarUnlocks,
    getCampaignProgressForSelection,
    mergeGuestCampaignProgress,
} from './campaign-store.js';
import {
    STOCK_CAR_ASSET_NAME,
    isCarAssetUnlocked,
} from '../../game/car/car-unlock-policy.js';
import { verifyGuestPlayerToken } from './player-token.js';
import { isRetiredGuestPlayerId } from './guest-retirement.js';
import {
    competitionSubmissionLockKey,
    isMismatchedSubmissionOwner,
    submitCompetitionRun,
    SUBMISSION_IDENTITY_CHANGED_RESULT,
    SUBMISSION_LOCK_TTL_MS,
    type RankedSubmitReuseOptions,
} from './competition-submit.js';

// Re-exported here so the paths callers and tests already import from keep resolving.
export {
    normalizePlayerPreferences,
    parseStoredPlayerProfile,
    salvagePlayerPreferences,
} from './competition-identity.js';
import { recordAnalyticsRace, recordAnalyticsRaceBestEffort } from './analytics-store.js';
export { parseStoredEntry } from './competition-leaderboard.js';

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
    carUnlocks: CarUnlockSnapshot | null;
    retireGuestIdentity: boolean;
    progressSelection?: GuestProgressSelection | null;
};

export type GuestProgressSelection = {
    required: boolean;
    guestHasProgress: boolean;
    accountHasProgress: boolean;
    guestSummary: { hasDailyResults: boolean; campaignResults: number; unlocks: boolean };
    accountSummary: { hasDailyResults: boolean; campaignResults: number; unlocks: boolean };
    choice?: 'guest' | 'account';
};

type GuestProgressSelectionRecord = {
    guestPlayerId: string;
    redditPlayerId: string;
    choice: 'guest' | 'account';
    status: 'pending' | 'completed';
    updatedAt: string;
    completedDomains: string[];
};

function guestProgressSelectionKey(guestPlayerId: string, redditPlayerId: string): string {
    return `dailygp:guest-progress-selection:v1:${createHash('sha256')
        .update(`${guestPlayerId}:${redditPlayerId}`, 'utf8')
        .digest('base64url')}`;
}

function guestProgressSelectionLockKey(guestPlayerId: string, redditPlayerId: string): string {
    return `${guestProgressSelectionKey(guestPlayerId, redditPlayerId)}:lock`;
}

function guestProgressSelectionPendingKey(guestPlayerId: string): string {
    return `dailygp:guest-progress-selection-pending:v1:${createHash('sha256')
        .update(guestPlayerId, 'utf8')
        .digest('base64url')}`;
}

const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;
const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_CURSOR_KEY = 'dailygp:maintenance:challenge-history:v1:cursor';
const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

async function readPlayerCarUnlocks(
    playerId: string,
    completedRaceEvidence = false,
): Promise<CarUnlockSnapshot> {
    return getCarUnlockSnapshot(
        playerId,
        await getCampaignResultsForCarUnlocks(playerId),
        redis,
        completedRaceEvidence,
    );
}

async function readPlayerStandingSummary(
    competition: ReturnType<typeof toDailyCompetition>,
    playerId: string,
): Promise<{
    playerRank: number | null;
    playerRankLabel: string | null;
    leaderboardEntryCount: number;
}> {
    const [playerRank, leaderboardEntryCount] = await Promise.all([
        readPlayerRank(competition, playerId),
        redis.zCard(competition.leaderboardKey),
    ]);
    return {
        playerRank,
        playerRankLabel: formatRankLabel(playerRank),
        leaderboardEntryCount: Number.isFinite(leaderboardEntryCount)
            ? Number(leaderboardEntryCount)
            : 0,
    };
}

/** Stamps TTL on the Daily board keys and ghost hash. Challenge setup creates the standings-revision key; restamp does not. */
async function stampDailyCompetitionExpiry(
    challenge: DailyGpChallenge,
    now = new Date(),
    { createStandingsRevision = true } = {},
): Promise<void> {
    const ttlSeconds = getDailyGpCompetitionTtlSeconds(challenge, now);
    const standingsRevisionKey = createRedisChallengeStandingsRevisionKey(challenge.id);
    const keys = [
        createRedisChallengeLeaderboardKey(challenge.id),
        createRedisChallengeEntryHashKey(challenge.id),
        standingsRevisionKey,
        challengeCollectionKey(challenge.id),
    ];
    if (ttlSeconds <= 0) {
        await Promise.all(keys.map((key) => redis.expire(key, 0)));
        return;
    }
    if (createStandingsRevision) {
        await redis.incrBy(standingsRevisionKey, 0);
    }
    await Promise.all(keys.map((key) => redis.expire(key, ttlSeconds)));
}

function preferencesAllowedByCarUnlocks(
    preferences: DailyGpPlayerPreferences | null,
    carUnlocks: CarUnlockSnapshot,
): DailyGpPlayerPreferences | null {
    if (!preferences) return null;
    return {
        ...preferences,
        carSkin: isCarAssetUnlocked(preferences.carSkin, carUnlocks)
            ? preferences.carSkin
            : STOCK_CAR_ASSET_NAME,
    };
}



function createEmptyDailySnapshot(challenge: DailyGpChallenge): SnapshotPayload {
    return createEmptySnapshot(toDailyCompetition(challenge), DAILY_GP_DEFAULT_LIMIT);
}

function getUtcDayStart(dayIndex: number): Date {
    return new Date(dayIndex * DAY_MS);
}

export function parseStoredChallenge(raw: string | null | undefined): DailyGpChallenge | null {
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

        const raceContract = normalizeDailyGpRaceContract(parsed);
        if (!raceContract) return null;

        return {
            id,
            challengeDate,
            trackKey,
            startsAt,
            endsAt,
            availableUntil,
            status: 'active',
            ...raceContract,
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
        await Promise.all(parsedEntries.flatMap(({ challenge }) => (
            challenge ? [stampDailyCompetitionExpiry(challenge, now, { createStandingsRevision: false })] : []
        )));
        if (expiredFields.length) {
            await redis.hDel(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, expiredFields);
        }
        await redis.set(
            DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_CURSOR_KEY,
            String(page.cursor),
        );
    } catch (error) {
        console.error('Daily GP challenge history maintenance failed:', error);
    }
}

async function writeStoredDailyGpChallenge(challenge: DailyGpChallenge): Promise<DailyGpChallenge> {
    await redis.hSet(
        DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
        { [challenge.id]: JSON.stringify(challenge) },
    );
    await redis.expire(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS);
    await stampDailyCompetitionExpiry(challenge);
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
        await stampDailyCompetitionExpiry(challenge);
        await maintainChallengeHistory();
        return challenge;
    }

    const reread = await readStoredDailyGpChallenge(challengeId);
    return reread ?? challenge;
}

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
        await stampDailyCompetitionExpiry(challenge);
        await maintainChallengeHistory();
        return challenge;
    }

    const reread = await readStoredDailyGpChallenge(challenge.id);
    return reread ?? challenge;
}

export function normalizeLimit(limit: unknown): number {
    if (!Number.isFinite(limit)) {
        return DAILY_GP_DEFAULT_LIMIT;
    }

    return Math.min(Math.max(Math.trunc(Number(limit)), 1), 100);
}

export function normalizeOffset(offset: unknown): number {
    if (!Number.isFinite(offset)) {
        return 0;
    }

    return Math.max(Math.trunc(Number(offset)), 0);
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
            formattedTime: formatRaceTime(entry.bestTimeMs),
        };
    });

    return ([1, 2, 3] as const).map((rank) => rankedPositions[rank - 1] ?? {
        rank,
        displayName: 'No verified finish',
        identityType: 'empty' as const,
        formattedTime: null,
    }) as FinalDailyGpPodium['positions'];
}


async function releaseSubmissionLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
}

async function acquireDailyMergeLocks(
    competition: ReturnType<typeof toDailyCompetition>,
    guestPlayerId: string,
    redditPlayerId: string,
): Promise<RedisLock[]> {
    const keys = [
        competitionSubmissionLockKey(competition, guestPlayerId),
        competitionSubmissionLockKey(competition, redditPlayerId),
    ].sort();
    const locks: RedisLock[] = [];
    try {
        for (const key of keys) {
            const lock = await acquireRedisLock(key, SUBMISSION_LOCK_TTL_MS, redis);
            if (!lock) {
                throw new Error('Daily guest merge blocked by an in-flight submission.');
            }
            locks.push(lock);
        }
        return locks;
    } catch (error) {
        await Promise.all(locks.map((lock) => releaseSubmissionLock(lock)));
        throw error;
    }
}

function dailyMergeLockForPlayer(
    locks: RedisLock[],
    competition: ReturnType<typeof toDailyCompetition>,
    playerId: string,
): RedisLock | null {
    const key = competitionSubmissionLockKey(competition, playerId);
    return locks.find((lock) => lock.key === key) ?? null;
}

async function readDailyMergeState(
    competition: ReturnType<typeof toDailyCompetition>,
    track: Record<string, any>,
    guestPlayerId: string,
    redditPlayerId: string,
) {
    const [guestEntry, redditEntry, guestPb, redditPb, redditRankedScore] = await Promise.all([
        readEntryByPlayerId(competition, guestPlayerId),
        readEntryByPlayerId(competition, redditPlayerId),
        getPlayerTrackPbRecord({
            playerId: guestPlayerId,
            competition,
            track,
        }),
        getPlayerTrackPbRecord({
            playerId: redditPlayerId,
            competition,
            track,
        }),
        typeof redis.zScore === 'function'
            ? redis.zScore(competition.leaderboardKey, redditPlayerId)
            : Promise.resolve(null),
    ]);
    return { guestEntry, redditEntry, guestPb, redditPb, redditRankedScore };
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
        lapCount: challenge.objectiveParams.lapCount,
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
        toDailyCompetition(challenge),
        `reddit:${username.toLowerCase()}`,
    );
    return entry ? { challenge, bestTimeMs: entry.bestTimeMs } : null;
}

export async function getServerDailyGpPlaylist(now = new Date()): Promise<DailyGpChallenge[]> {
    const todayIndex = getUtcDayIndex(now);
    const challenges: DailyGpChallenge[] = [];
    const activeChallenge = await getServerDailyGpChallenge();

    const challengeIds = Array.from({ length: DAILY_GP_PLAYLIST_DAYS }, (_unused, offset) => (
        createDailyChallengeId(getUtcDayStart(todayIndex - offset).toISOString().slice(0, 10))
    ));
    // Every challenge lives in one history hash, so the whole window is one read instead of one per day.
    const storedIds = challengeIds.filter((challengeId) => challengeId !== activeChallenge.id);
    const storedRaw = storedIds.length > 0
        ? await redis.hMGet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, storedIds)
        : [];
    const storedById = new Map(storedIds.map((challengeId, index) => [
        challengeId,
        parseStoredChallenge(typeof storedRaw[index] === 'string' ? storedRaw[index] : null),
    ]));

    for (const challengeId of challengeIds) {
        const challenge = challengeId === activeChallenge.id
            ? activeChallenge
            // A day missing from history is backfilled and persisted, exactly as the per-day read did.
            : storedById.get(challengeId) ?? await readStoredOrBackfilledDailyGpChallenge(challengeId);
        if (challenge && isDailyGpChallengePlayable(challenge, now)) {
            challenges.push(challenge);
        }
    }

    return challenges;
}

function dailyPlayerField(playerId: string): string {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

export async function mergeGuestDailyProgress({
    guestPlayerId,
    redditPlayerId,
    replace = false,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    replace?: boolean;
}): Promise<{ merged: boolean; mergedChallengeIds: string[] }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return { merged: false, mergedChallengeIds: [] };
    }

    const playlist = await getServerDailyGpPlaylist();
    const mergedChallengeIds: string[] = [];
    let hasGuestEvidence = false;

    for (const challenge of playlist) {
        const competition = toDailyCompetition(challenge);
        const track = TRACKS[challenge.trackKey];
        if (!track) continue;

        const peeked = await readDailyMergeState(
            competition,
            track,
            guestPlayerId,
            redditPlayerId,
        );
        if (
            !peeked.guestEntry
            && !peeked.guestPb
            && !peeked.redditEntry
            && !peeked.redditPb
        ) continue;
        hasGuestEvidence ||= Boolean(peeked.guestEntry || peeked.guestPb);

        const locks = await acquireDailyMergeLocks(
            competition,
            guestPlayerId,
            redditPlayerId,
        );
        try {
            const {
                guestEntry,
                redditEntry,
                guestPb,
                redditPb,
                redditRankedScore,
            } = await readDailyMergeState(
                competition,
                track,
                guestPlayerId,
                redditPlayerId,
            );
            if (!guestEntry && !guestPb && !replace) continue;

            const guestWinsLeaderboard = replace
                ? Boolean(guestEntry)
                : Boolean(
                    guestEntry
                    && (!redditEntry || guestEntry.bestTimeMs < redditEntry.bestTimeMs),
                );
            const guestCanSupplyWinningPb = replace
                ? Boolean(guestPb)
                : Boolean(guestPb && (!redditPb || guestPb.bestTimeMs < redditPb.bestTimeMs));
            const entryToWrite = replace && !guestEntry && guestPb
                ? {
                    playerId: redditPlayerId,
                    trackKey: challenge.trackKey,
                    bestTimeMs: guestPb.bestTimeMs,
                    updatedAt: guestPb.updatedAt,
                    completedLaps: challenge.objectiveParams.lapCount,
                    checkpointTimesSec: guestPb.checkpointTimesSec,
                    validationMethod: 'strict-replay' as const,
                }
                : guestWinsLeaderboard
                    ? { ...guestEntry!, playerId: redditPlayerId }
                    : (!replace && redditEntry && Number(redditRankedScore) !== redditEntry.bestTimeMs
                        ? redditEntry
                        : null);

            if (entryToWrite || replace) {
                const accountLock = dailyMergeLockForPlayer(
                    locks,
                    competition,
                    redditPlayerId,
                );
                if (!accountLock) {
                    throw new Error('Daily guest merge lost the Reddit submission lock.');
                }
                const transaction = await beginOwnedRedisLockTransaction(accountLock, redis);
                if (!transaction) {
                    throw new Error('Daily guest merge lost the Reddit submission lock.');
                }
                if (entryToWrite) {
                    await writeEntry(competition, redditPlayerId, entryToWrite, transaction);
                } else {
                    await transaction.hDel(competition.entryHashKey, [redditPlayerId]);
                    await transaction.zRem(competition.leaderboardKey, [redditPlayerId]);
                    await transaction.incrBy(competition.standingsRevisionKey, 1);
                }
                if (replace && !guestPb) {
                    await transaction.hDel(competition.pbHashKey, [dailyPlayerField(redditPlayerId)]);
                }
                const results = await transaction.exec();
                if (!Array.isArray(results) || results.length === 0) {
                    throw new Error('Daily leaderboard copy was interrupted.');
                }
                if (guestWinsLeaderboard) {
                    mergedChallengeIds.push(challenge.id);
                }
            }

            if (guestCanSupplyWinningPb) {
                const rawGuestPb = await redisCompressed.hGet(
                    competition.pbHashKey,
                    dailyPlayerField(guestPlayerId),
                );
                if (!rawGuestPb) {
                    throw new Error(`Daily guest PB disappeared during promotion: ${challenge.id}`);
                }
                await redisCompressed.hSet(competition.pbHashKey, {
                    [dailyPlayerField(redditPlayerId)]: rawGuestPb,
                });
            }

            if (guestEntry || guestPb) {
                const guestLock = dailyMergeLockForPlayer(
                    locks,
                    competition,
                    guestPlayerId,
                );
                if (!guestLock) {
                    throw new Error('Daily guest merge lost the guest submission lock.');
                }
                const cleanup = await beginOwnedRedisLockTransaction(guestLock, redis);
                if (!cleanup) {
                    throw new Error('Daily guest merge lost the guest submission lock.');
                }
                await cleanup.hDel(competition.entryHashKey, [guestPlayerId]);
                await cleanup.zRem(competition.leaderboardKey, [guestPlayerId]);
                await cleanup.hDel(competition.pbHashKey, [dailyPlayerField(guestPlayerId)]);
                await cleanup.incrBy(competition.standingsRevisionKey, 1);
                const cleanupResults = await cleanup.exec();
                if (!Array.isArray(cleanupResults) || cleanupResults.length === 0) {
                    throw new Error('Daily guest cleanup was interrupted.');
                }
            }
        } finally {
            await Promise.all(locks.map((lock) => releaseSubmissionLock(lock)));
        }
    }

    if (!hasGuestEvidence) {
        return { merged: false, mergedChallengeIds: [] };
    }
    return {
        merged: mergedChallengeIds.length > 0,
        mergedChallengeIds,
    };
}

export async function discardGuestDailyProgress({
    guestPlayerId,
}: {
    guestPlayerId: string;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const playlist = await getServerDailyGpPlaylist();
    let discarded = false;
    for (const challenge of playlist) {
        const competition = toDailyCompetition(challenge);
        const track = TRACKS[challenge.trackKey];
        if (!track) continue;
        const state = await readDailyMergeState(competition, track, guestPlayerId, guestPlayerId);
        if (!state.guestEntry && !state.guestPb) continue;
        discarded = true;
        const lock = await acquireRedisLock(
            competitionSubmissionLockKey(competition, guestPlayerId),
            SUBMISSION_LOCK_TTL_MS,
            redis,
        );
        if (!lock) throw new Error('Daily guest discard is already in progress.');
        try {
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) throw new Error('Daily guest discard lock was lost.');
            await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
            await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
            await transaction.hDel(competition.pbHashKey, [dailyPlayerField(guestPlayerId)]);
            await transaction.incrBy(competition.standingsRevisionKey, 1);
            const results = await transaction.exec();
            if (!Array.isArray(results) || results.length === 0) {
                throw new Error('Daily guest discard was interrupted.');
            }
        } finally {
            await releaseSubmissionLock(lock);
        }
    }
    return discarded;
}

/** Days this identity has a standing or a PB on. Every day is an independent key space, so they are read as one batch. */
async function countDailyProgressResults(
    playerId: string,
    playlist: DailyGpChallenge[],
): Promise<number> {
    const perChallenge = await Promise.all(playlist.map(async (challenge) => {
        const track = TRACKS[challenge.trackKey];
        if (!track) return false;
        const competition = toDailyCompetition(challenge);
        const [entry, pb] = await Promise.all([
            readEntryByPlayerId(competition, playerId),
            getPlayerTrackPbRecord({ playerId, competition, track }),
        ]);
        return Boolean(entry || pb);
    }));
    return perChallenge.filter(Boolean).length;
}

/**
 * Progress evidence that costs three reads instead of a per-day walk of the Daily playlist.
 * Every accepted Daily, Campaign and Head to Head run writes a race-completed unlock event that
 * never expires, so an empty unlock record is proof no run was ever stored under this identity.
 * The profile flag is Daily-only and outlives the 7-day playlist, so it says whether that progress
 * includes Daily runs without pricing in one read per day.
 */
async function readProgressEvidence(playerId: string) {
    const [campaign, unlocks, profile] = await Promise.all([
        getCampaignProgressForSelection(playerId),
        hasCarUnlockProgress(playerId),
        readPlayerProfile(playerId),
    ]);
    const campaignResults = Object.keys(campaign.resultsByRaceId).length;
    return {
        campaignResults,
        hasDailyResults: Boolean(profile?.hasAnyData),
        unlocks,
        hasProgress: Boolean(
            campaignResults
            || campaign.startedAt
            || unlocks
            || profile?.hasAnyData,
        ),
    };
}

function toProgressSummary(evidence: Awaited<ReturnType<typeof readProgressEvidence>>) {
    return {
        hasDailyResults: evidence.hasDailyResults,
        campaignResults: evidence.campaignResults,
        unlocks: evidence.unlocks,
    };
}

export async function getGuestProgressSelection({
    guestPlayerId,
    redditPlayerId,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
}): Promise<GuestProgressSelection> {
    const key = guestProgressSelectionKey(guestPlayerId, redditPlayerId);
    const existing = await redis.get(key);
    if (existing) {
        try {
            const record = JSON.parse(existing) as GuestProgressSelectionRecord;
            if (record.status === 'completed') {
                return {
                    required: false,
                    guestHasProgress: false,
                    accountHasProgress: true,
                    guestSummary: { hasDailyResults: false, campaignResults: 0, unlocks: false },
                    accountSummary: { hasDailyResults: false, campaignResults: 0, unlocks: false },
                    choice: record.choice,
                };
            }
        } catch {
            // A malformed record is treated as unresolved and is safely replaced by a new choice.
        }
    }
    const [guestEvidence, accountEvidence] = await Promise.all([
        readProgressEvidence(guestPlayerId),
        readProgressEvidence(redditPlayerId),
    ]);
    // Cheap evidence can only understate the guest, and understating it retires an identity that still
    // owns runs, so a guest that looks empty is confirmed against the playlist before that can happen.
    // The account is never scanned: it is not the identity at risk, and its Daily state is display only.
    const guestHasProgress = guestEvidence.hasProgress
        || await countDailyProgressResults(
            guestPlayerId,
            await getServerDailyGpPlaylist(),
        ) > 0;
    const guestSummary = {
        ...toProgressSummary(guestEvidence),
        hasDailyResults: guestEvidence.hasDailyResults || (guestHasProgress && !guestEvidence.hasProgress),
    };
    const accountSummary = toProgressSummary(accountEvidence);
    if (guestHasProgress) {
        await redis.set(guestProgressSelectionPendingKey(guestPlayerId), '1', {
            expiration: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
    }
    return {
        required: guestHasProgress,
        guestHasProgress,
        accountHasProgress: accountEvidence.hasProgress,
        guestSummary,
        accountSummary,
    };
}

export async function selectGuestProgress({
    guestPlayerId,
    redditPlayerId,
    choice,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    choice: unknown;
}): Promise<{ status: 'completed'; choice: 'guest' | 'account' }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        throw new Error('Guest progress selection requires a guest and Reddit identity.');
    }
    if (choice !== 'guest' && choice !== 'account') {
        throw new Error('Guest progress selection is invalid.');
    }
    const key = guestProgressSelectionKey(guestPlayerId, redditPlayerId);
    const currentRaw = await redis.get(key);
    let currentRecord: GuestProgressSelectionRecord | null = null;
    if (currentRaw) {
        try {
            currentRecord = JSON.parse(currentRaw) as GuestProgressSelectionRecord;
            if (currentRecord.choice !== choice) {
                const conflict = new Error('A different guest progress choice was already made.');
                (conflict as Error & { statusCode?: number }).statusCode = 409;
                throw conflict;
            }
            if (currentRecord.status === 'completed') return { status: 'completed', choice };
        } catch (error) {
            if ((error as Error & { statusCode?: number }).statusCode === 409) throw error;
        }
    }
    const lock = await acquireRedisLock(
        guestProgressSelectionLockKey(guestPlayerId, redditPlayerId),
        60_000,
        redis,
    );
    if (!lock) {
        const busy = new Error('Guest progress selection is already in progress.');
        (busy as Error & { statusCode?: number }).statusCode = 503;
        throw busy;
    }
    try {
        const record: GuestProgressSelectionRecord = {
            guestPlayerId,
            redditPlayerId,
            choice,
            status: 'pending',
            updatedAt: new Date().toISOString(),
            completedDomains: Array.isArray(currentRecord?.completedDomains)
                ? currentRecord.completedDomains
                : [],
        };
        const saveRecord = async (next: GuestProgressSelectionRecord) => {
            await redis.set(key, JSON.stringify(next), {
                expiration: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
        };
        await saveRecord(record);
        await redis.set(guestProgressSelectionPendingKey(guestPlayerId), '1', {
            expiration: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        if (choice === 'guest') {
            if (!record.completedDomains?.includes('campaign')) {
                await mergeGuestCampaignProgress({ guestPlayerId, redditPlayerId, replace: true });
                record.completedDomains = [...record.completedDomains, 'campaign'];
                await saveRecord(record);
            }
            if (!record.completedDomains?.includes('daily')) {
                await mergeGuestDailyProgress({ guestPlayerId, redditPlayerId, replace: true });
                record.completedDomains = [...record.completedDomains, 'daily'];
                await saveRecord(record);
            }
            if (!record.completedDomains?.includes('unlocks')) {
                await mergeGuestCarUnlockProgress({ guestPlayerId, redditPlayerId, replace: true });
                record.completedDomains = [...record.completedDomains, 'unlocks'];
                await saveRecord(record);
            }
        } else {
            if (!record.completedDomains?.includes('campaign')) {
                await discardGuestCampaignProgress({ guestPlayerId });
                record.completedDomains = [...record.completedDomains, 'campaign'];
                await saveRecord(record);
            }
            if (!record.completedDomains?.includes('daily')) {
                await discardGuestDailyProgress({ guestPlayerId });
                record.completedDomains = [...record.completedDomains, 'daily'];
                await saveRecord(record);
            }
            if (!record.completedDomains?.includes('unlocks')) {
                await discardGuestCarUnlockProgress({ guestPlayerId, redditPlayerId });
                record.completedDomains = [...record.completedDomains, 'unlocks'];
                await saveRecord(record);
            }
        }
        await saveRecord({ ...record, status: 'completed', updatedAt: new Date().toISOString() });
        await redis.del(guestProgressSelectionPendingKey(guestPlayerId));
        return { status: 'completed', choice };
    } catch (error) {
        console.error('Guest progress selection failed:', error);
        throw error;
    } finally {
        await releaseRedisLock(lock, redis);
    }
}

export async function selectServerGuestProgress({
    playerId,
    redditUsername,
    guestToken,
    choice,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    choice?: unknown;
}): Promise<PlayerBootstrapPayload> {
    const safeUsername = sanitizeRedditUsername(redditUsername);
    const verifiedGuestPlayerId = await verifyGuestPlayerToken(guestToken);
    if (!safeUsername || !verifiedGuestPlayerId) {
        const error = new Error('Guest progress selection requires a signed-in Reddit account and valid guest token.');
        (error as Error & { statusCode?: number }).statusCode = 401;
        throw error;
    }
    const normalizedPlayerId = typeof playerId === 'string' ? playerId.trim() : '';
    if (normalizedPlayerId && normalizedPlayerId !== verifiedGuestPlayerId) {
        const error = new Error('Guest progress selection identity changed.');
        (error as Error & { statusCode?: number }).statusCode = 401;
        throw error;
    }
    await selectGuestProgress({
        guestPlayerId: `guest:${verifiedGuestPlayerId}`,
        redditPlayerId: `reddit:${safeUsername.toLowerCase()}`,
        choice,
    });
    return getServerPlayerBootstrap({
        playerId: normalizedPlayerId || verifiedGuestPlayerId,
        redditUsername: safeUsername,
        guestToken,
    });
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

    const competition = toDailyCompetition(challenge);
    const existing = await getPlayerTrackPbRecord({
        playerId,
        competition,
        track,
    });
    if (existing) return existing;

    const retainedEntry = await readEntryByPlayerId(competition, playerId);
    if (!retainedEntry || retainedEntry.validationMethod !== 'strict-replay') {
        return null;
    }

    try {
        const seeded = await seedPlayerTrackPersonalBest({
            playerId,
            competition,
            track,
            bestTimeMs: retainedEntry.bestTimeMs,
            checkpointTimesSec: retainedEntry.checkpointTimesSec,
            updatedAt: retainedEntry.updatedAt,
        });
        return seeded.record;
    } catch (error) {
        // Opportunistic backfill takes the same lock a live submission needs; losing that race must not fail the request.
        console.error('Challenge PB seed from a retained leaderboard entry failed:', error);
        return null;
    }
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
        lapCompletionTimesSec: number[] | null;
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
        lapCompletionTimesSec: number[] | null;
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
                lapCompletionTimesSec: record.lapCompletionTimesSec,
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
        lapCompletionTimesSec: number[] | null;
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
                lapCompletionTimesSec: record.lapCompletionTimesSec,
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
    let retireGuestIdentity = identity.guestStatus === 'guest_identity_retired';
    let progressSelection: GuestProgressSelection | null = null;

    // Claiming or adopting a retired guest id would resurrect a credential whose progress already moved to an account.
    const retiredGuestId = !identity.canonicalPlayerId
        && !safeRequestRedditUsername
        && typeof playerId === 'string'
        && playerId.trim()
        ? await isRetiredGuestPlayerId(`guest:${playerId.trim()}`)
        : false;
    retireGuestIdentity ||= retiredGuestId;

    // A player id with no token is either a first visit or a guest whose token was lost: claiming covers the first, adopting the second.
    if (!identity.canonicalPlayerId && !safeRequestRedditUsername && !suppliedGuestToken && !retiredGuestId) {
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
        } else {
            const adoptedGuest = await adoptExistingGuestPlayerProfile({ playerId });
            if (adoptedGuest) {
                identity = {
                    canonicalPlayerId: adoptedGuest.canonicalPlayerId,
                    guestPlayerId: adoptedGuest.guestPlayerId,
                    guestToken: adoptedGuest.guestToken,
                };
                previousProfile = adoptedGuest.profile;
            }
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
            carUnlocks: null,
            retireGuestIdentity,
        };
    }

    if (identity.canonicalPlayerId.startsWith('reddit:')) {
        const guestPlayerId = await verifyGuestPlayerToken(guestToken);
        if (guestPlayerId) {
            const promotedTo = await readGuestPromotionTarget(`guest:${guestPlayerId}`);
            if (promotedTo) {
                retireGuestIdentity = true;
            } else {
                progressSelection = await getGuestProgressSelection({
                    guestPlayerId: `guest:${guestPlayerId}`,
                    redditPlayerId: identity.canonicalPlayerId,
                });
                if (!progressSelection.required) {
                    if (progressSelection.guestHasProgress === false && !progressSelection.choice) {
                        await retireEmptyGuestIdentity({
                            guestPlayerId: `guest:${guestPlayerId}`,
                            redditPlayerId: identity.canonicalPlayerId,
                        });
                    }
                    retireGuestIdentity = true;
                } else {
                    return {
                        playerId: identity.canonicalPlayerId,
                        guestToken: typeof guestToken === 'string' ? guestToken.trim() : null,
                        redditUsername: safeRequestRedditUsername,
                        leaderboardIdentity: 'reddit',
                        playerPreferences: null,
                        hasAnyData: false,
                        isReturningPlayer: false,
                        firstSeenAt: null,
                        lastSeenAt: null,
                        carUnlocks: null,
                        retireGuestIdentity: false,
                        progressSelection,
                    };
                }
            }
        }
    }

    if (!profile) {
        previousProfile ??= await readPlayerProfile(identity.canonicalPlayerId);
        profile = await upsertPlayerProfile({
            playerId: identity.canonicalPlayerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: false,
        });
    }
    const firstSeenMs = Date.parse(profile.firstSeenAt);
    const isReturningPlayer = profile.hasSeenGame
        && Number.isFinite(firstSeenMs)
        && (Date.now() - firstSeenMs) > RETURNING_PLAYER_DELAY_MS;
    if (profile.hasAnyData) {
        try {
            await recordCompletedRace(identity.canonicalPlayerId);
        } catch (error) {
            console.error('Completed-race unlock backfill failed:', error);
        }
    }
    const carUnlocks = await readPlayerCarUnlocks(
        identity.canonicalPlayerId,
        profile.hasAnyData,
    );
    const playerPreferences = preferencesAllowedByCarUnlocks(profile.preferences, carUnlocks);
    if (
        playerPreferences
        && profile.preferences
        && playerPreferences.carSkin !== profile.preferences.carSkin
    ) {
        profile = await upsertPlayerProfile({
            playerId: identity.canonicalPlayerId,
            redditUsername,
            preferences: playerPreferences,
            hasAnyData: false,
        });
    }

    return {
        playerId: identity.canonicalPlayerId,
        guestToken: identity.guestToken,
        redditUsername: safeRequestRedditUsername,
        leaderboardIdentity: profile.leaderboardIdentity,
        playerPreferences,
        hasAnyData: previousProfile ? (profile.hasSeenGame || profile.hasAnyData) : false,
        isReturningPlayer,
        firstSeenAt: profile.firstSeenAt,
        lastSeenAt: profile.lastSeenAt,
        carUnlocks,
        retireGuestIdentity,
        ...(progressSelection?.required ? { progressSelection } : {}),
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
    const carUnlocks = await readPlayerCarUnlocks(identity.canonicalPlayerId);
    const allowedPreferences = preferencesAllowedByCarUnlocks(normalizedPreferences, carUnlocks);

    const profile = await upsertPlayerProfile({
        playerId: identity.canonicalPlayerId,
        redditUsername,
        preferences: allowedPreferences,
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
}: {
    challengeId?: string | null;
    playerId?: string | null;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    limit?: unknown;
    offset?: unknown;
} = {}): Promise<SnapshotPayload> {
    const activeChallenge = await getServerDailyGpChallenge();
    const challenge = challengeId
        ? await getServerDailyGpPlayableChallenge(challengeId)
        : activeChallenge;
    if (!challenge) {
        return createEmptyDailySnapshot(activeChallenge);
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

    return readSnapshot({
        competition: toDailyCompetition(challenge),
        playerId: normalizedPlayerId,
        limit: normalizeLimit(limit),
        offset: normalizeOffset(offset),
    });
}

export async function prepareServerDailyLeaderboardRace({
    challengeId,
    playerId,
    redditUsername,
    guestToken,
    selection,
}: {
    challengeId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    selection?: unknown;
}) {
    const challenge = await getServerDailyGpPlayableChallenge(
        typeof challengeId === 'string' ? challengeId : null,
    );
    if (!challenge) {
        return { status: 410, body: { error: 'Daily race is no longer available.', reason: 'competition_unavailable' } };
    }
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    return prepareCompetitionOpponentRace({
        competition: toDailyCompetition(challenge),
        playerId: identity.canonicalPlayerId,
        race: challenge,
        selection,
    });
}


export async function submitServerDailyGpRun({
    playerId,
    challengeId,
    leaderboardIdentity,
    redditUsername,
    guestToken,
    replay,
    trackKey,
    requestRateLimitIdentity,
    submissionOwnerId,
}: {
    playerId?: unknown;
    challengeId?: unknown;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    replay?: unknown;
    trackKey?: unknown;
    requestRateLimitIdentity?: unknown;
    submissionOwnerId?: unknown;
}, reuse?: RankedSubmitReuseOptions) {
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
    if (identity.guestStatus === 'guest_promotion_pending') {
        return {
            status: 409,
            body: {
                accepted: false,
                error: 'Choose which progress to keep before submitting a ranked Daily result.',
                reason: 'progress_selection_required',
            },
        };
    }

    // Checked before rate limiting and replay work: a run raced under another account is not this player's to spend.
    if (isMismatchedSubmissionOwner(identity.canonicalPlayerId, submissionOwnerId)) {
        return SUBMISSION_IDENTITY_CHANGED_RESULT;
    }

    const competition = toDailyCompetition(challenge);
    const outcome = await submitCompetitionRun({
        competition,
        playerId: identity.canonicalPlayerId,
        redditUsername,
        trackKey,
        replay,
        requestRateLimitIdentity,
        submissionOwnerId,
    }, reuse);
    if (outcome.status !== 200 || !(outcome.body as { accepted?: boolean }).accepted) {
        return { status: outcome.status, body: outcome.body };
    }

    const normalizedPlayerId = identity.canonicalPlayerId;
    const [standing, carUnlocks] = await Promise.all([
        readPlayerStandingSummary(competition, normalizedPlayerId),
        readPlayerCarUnlocks(normalizedPlayerId, true),
        recordCompletedRace(normalizedPlayerId),
        outcome.releaseLock,
        upsertPlayerProfile({
            playerId: normalizedPlayerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: true,
        }),
    ]);
    recordAnalyticsRaceBestEffort('daily', 'finish', normalizedPlayerId);
    return {
        status: 200,
        body: {
            ...(outcome.body as Record<string, unknown>),
            playerRank: standing.playerRank,
            playerRankLabel: standing.playerRankLabel,
            leaderboardEntryCount: standing.leaderboardEntryCount,
            carUnlocks,
        },
    };
}

export async function recordServerRaceEvent({
    mode,
    action,
    playerId,
    redditUsername,
    guestToken,
}: {
    mode?: unknown;
    action?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}): Promise<void> {
    const identity = await resolveAuthorizedPlayerIdentity({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) return;
    await recordAnalyticsRace({ mode, action, playerId: identity.canonicalPlayerId });
}

export async function recordServerRaceStart(
    input: {
        mode?: unknown;
        playerId?: unknown;
        redditUsername?: unknown;
        guestToken?: unknown;
    } = {},
): Promise<void> {
    await recordServerRaceEvent({ ...input, action: 'start' });
}
