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
import { normalizeCheckpointTimesSec } from '../../game/shared/checkpoint-times.js';
import {
    buildDailyGpChallengeForDayIndexWithTrack,
    createDailyChallengeId,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS,
    DAILY_GP_DEFAULT_LIMIT,
    DAILY_GP_PLAYLIST_DAYS,
    formatUtcChallengeDate,
    getUtcDayIndex,
    getDailyGpCompetitionTtlSeconds,
    isDailyGpChallengePlayable,
    normalizeDailyGpRaceContract,
    type DailyGpChallenge,
    type DailyGpLeaderboardEntry,
    type DailyGpPlayerPreferences,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { getBackfilledDailyGpChallenge } from './daily-gp-history-backfill.js';
import type { FinalDailyGpPodium } from './daily-podium-model.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';
import { toDailyCompetition } from './competition.js';
import { prepareCompetitionOpponentRace } from './competition-opponent-race.js';
import {
    createEmptySnapshot,
    parseStoredEntry,
    readEntryByPlayerId,
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
    getPlayerTrackPbRecord,
    seedPlayerTrackPersonalBest,
    upsertPlayerTrackPersonalBest,
} from './pb-ghost-store.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from './redis-lock.js';
import {
    getCarUnlockSnapshot,
    mergeGuestCarUnlockProgress,
    recordCompletedRace,
    type CarUnlockSnapshot,
} from './car-unlock-store.js';
import {
    getCampaignResultsForCarUnlocks,
    mergeGuestCampaignProgress,
} from './campaign-store.js';
import {
    STOCK_CAR_ASSET_NAME,
    isCarAssetUnlocked,
} from '../../game/car/car-unlock-policy.js';
import { verifyGuestPlayerToken } from './player-token.js';
import { isRetiredGuestPlayerId } from './guest-retirement.js';
import {
    isMismatchedSubmissionOwner,
    SUBMISSION_IDENTITY_CHANGED_RESULT,
} from './competition-submit.js';

// Re-exported here so the paths callers and tests already import from keep resolving.
export {
    normalizePlayerPreferences,
    parseStoredPlayerProfile,
    salvagePlayerPreferences,
} from './competition-identity.js';
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
};

const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;
const DAILY_GP_CHALLENGE_HISTORY_HASH_KEY = 'dailygp:challenges';
const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_CURSOR_KEY = 'dailygp:maintenance:challenge-history:v1:cursor';
const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_BATCH_SIZE = 50;
const DAILY_GP_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60;
const DAILY_GP_SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 12;
const DAILY_GP_SUBMISSION_LOCK_TTL_MS = 30_000;
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

function createSubmissionRateLimitKey(challengeId: string, rateLimitIdentity: string): string {
    return `dailygp:submit-rate-limit:${challengeId}:${rateLimitIdentity}`;
}

function createSubmissionLockKey(challengeId: string, playerId: string): string {
    return `dailygp:submit-lock:${challengeId}:${playerId}`;
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
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, expiresAt - Math.floor(Date.now() / 1000)),
        };
    }
    // A counter left without a TTL only ever climbs, so repair the window rather than report a retry time that never arrives.
    await redis.expire(rateLimitKey, DAILY_GP_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS);
    return {
        allowed: false,
        retryAfterSeconds: DAILY_GP_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
    };
}

async function acquireSubmissionLock(
    challengeId: string,
    playerId: string,
): Promise<RedisLock | null> {
    const key = createSubmissionLockKey(challengeId, playerId);
    return acquireRedisLock(key, DAILY_GP_SUBMISSION_LOCK_TTL_MS, redis);
}

async function releaseSubmissionLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
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

function dailyPlayerField(playerId: string): string {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

export async function mergeGuestDailyProgress({
    guestPlayerId,
    redditPlayerId,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
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
            redis.zScore(competition.leaderboardKey, redditPlayerId),
        ]);

        if (!guestEntry && !guestPb) continue;
        hasGuestEvidence = true;

        const guestWinsLeaderboard = Boolean(
            guestEntry
            && (!redditEntry || guestEntry.bestTimeMs < redditEntry.bestTimeMs),
        );
        const guestCanSupplyWinningPb = Boolean(
            guestPb && (!redditPb || guestPb.bestTimeMs < redditPb.bestTimeMs),
        );
        const entryToWrite = guestWinsLeaderboard
            ? { ...guestEntry!, playerId: redditPlayerId }
            : (redditEntry && Number(redditRankedScore) !== redditEntry.bestTimeMs
                ? redditEntry
                : null);

        if (entryToWrite) {
            const accountLock = await acquireSubmissionLock(challenge.id, redditPlayerId);
            if (!accountLock) {
                throw new Error('Daily guest merge blocked by an in-flight Reddit submission.');
            }
            try {
                const transaction = await beginOwnedRedisLockTransaction(accountLock, redis);
                if (!transaction) {
                    throw new Error('Daily guest merge lost the Reddit submission lock.');
                }
                await writeEntry(competition, redditPlayerId, entryToWrite, transaction);
                const results = await transaction.exec();
                if (!Array.isArray(results) || results.length === 0) {
                    throw new Error('Daily leaderboard copy was interrupted.');
                }
                if (guestWinsLeaderboard) {
                    mergedChallengeIds.push(challenge.id);
                }
            } finally {
                await releaseSubmissionLock(accountLock);
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

        if (guestEntry) {
            const guestLock = await acquireSubmissionLock(challenge.id, guestPlayerId);
            if (!guestLock) {
                throw new Error('Daily guest merge blocked by an in-flight guest submission.');
            }
            try {
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
            } finally {
                await releaseSubmissionLock(guestLock);
            }
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
        let guestPromotionComplete = true;
        if (guestPlayerId) {
            try {
                await Promise.all([
                    mergeGuestCampaignProgress({
                        guestPlayerId: `guest:${guestPlayerId}`,
                        redditPlayerId: identity.canonicalPlayerId,
                    }),
                    mergeGuestCarUnlockProgress({
                        guestPlayerId: `guest:${guestPlayerId}`,
                        redditPlayerId: identity.canonicalPlayerId,
                    }),
                    mergeGuestDailyProgress({
                        guestPlayerId: `guest:${guestPlayerId}`,
                        redditPlayerId: identity.canonicalPlayerId,
                    }),
                ]);
            } catch (error) {
                // Campaign's bootstrap claims the same guest progress and the merge refuses to run twice; losing that race must not cost this bootstrap.
                guestPromotionComplete = false;
                console.error('Player guest progress claim failed:', error);
            }
        }
        retireGuestIdentity ||= Boolean(guestPlayerId && guestPromotionComplete);
        if (guestPlayerId && !guestPromotionComplete) {
            identity.guestToken = typeof guestToken === 'string' ? guestToken.trim() : null;
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
    bestTime,
    replay,
    checkpointTimesSec,
    trackKey,
    requestRateLimitIdentity,
    submissionOwnerId,
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
    submissionOwnerId?: unknown;
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

    // Checked before rate limiting and replay work: a run raced under another account is not this player's to spend.
    if (isMismatchedSubmissionOwner(identity.canonicalPlayerId, submissionOwnerId)) {
        return SUBMISSION_IDENTITY_CHANGED_RESULT;
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
        completedLaps: strictReplayOutcome.run.completedLaps === 2
            || strictReplayOutcome.run.completedLaps === 3
            ? strictReplayOutcome.run.completedLaps
            : 1,
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
    const competition = toDailyCompetition(challenge);
    try {
        previousEntry = await readEntryByPlayerId(competition, normalizedPlayerId);
        const dailyWrite = async () => {
            if (previousEntry && previousEntry.bestTimeMs <= nextBestTimeMs) {
                return { interrupted: false, improved: false, entry: previousEntry };
            }

            const tx = await beginOwnedRedisLockTransaction(submissionLock, redis);
            if (!tx) {
                return { interrupted: true, improved: false, entry: previousEntry ?? nextEntry };
            }
            await writeEntry(competition, normalizedPlayerId, nextEntry, tx);
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
                competition,
                track,
                bestTimeMs: nextBestTimeMs,
                checkpointTimesSec: normalizedCheckpointTimesSec,
                lapCompletionTimesSec: strictReplayOutcome.run.lapCompletionTimesSec,
                ghost: strictReplayOutcome.run.ghost ?? null,
                updatedAt: nextEntry.updatedAt,
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
    await recordCompletedRace(normalizedPlayerId);
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
            completedLaps: storedDailyEntry.completedLaps,
            checkpointTimesSec: storedDailyEntry.checkpointTimesSec ?? null,
            validationMethod: storedDailyEntry.validationMethod ?? 'strict-replay',
            strictReplayFailureReason: storedDailyEntry.strictReplayFailureReason ?? null,
            carUnlocks: await readPlayerCarUnlocks(normalizedPlayerId),
        },
    };
}
