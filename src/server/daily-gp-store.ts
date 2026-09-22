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
import type { DailyPodiumReplayGhostSlot } from './daily-podium-replay.js';
import { createTrackFingerprint } from './pb-ghost-trace.js';
import { toCampaignCompetition, toDailyCompetition } from './competition.js';
import { prepareCompetitionOpponentRace } from './competition-opponent-race.js';
import {
    createEmptySnapshot,
    parseStoredEntry,
    competitionHoldsPlayerRows,
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
    writeEntry,
    withOpponentRaceReady,
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
    ensurePlayerProfileExists,
} from './competition-identity.js';
import {
    challengeCollectionKey,
    classifyStoredPbRecordFor,
    getPlayerTrackPbRecord,
    seedPlayerTrackPersonalBest,
} from './pb-ghost-store.js';
import { classifyStoredLeaderboardEntry } from './guest-transfer-source-classification.js';
import { encodeRedisCompressedValue } from './redis-compressed-value.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockGroupTransaction,
    beginOwnedRedisLockTransaction,
    commitOwnedRedisLockTransaction,
    releaseRedisLockGroup,
    renewRedisLockGroup,
    startRedisLockGroupLeaseRenewal,
    type RedisLock,
    type RedisLockLease,
    type RedisLockMutation,
    type RedisLockTransactionRunner,
} from './redis-lock.js';
import {
    GuestProgressRecoveryRequiredError,
    GuestProgressSelectionRetryableError,
} from './guest-progress-selection-error.js';
import {
    getCarUnlockSnapshot,
    discardGuestCarUnlockProgress,
    captureGuestTransferGarageBaseline,
    readGuestTransferGarageBaseline,
    readGuestTransferGarageJournalFields,
    isValidCarUnlockEventField,
    cleanupGuestCarUnlockProgress,
    hasCarUnlockProgress,
    mergeGuestCarUnlockProgress,
    readGuestPromotionTarget,
    carUnlockHashKey,
    hasRecordedCompletedRace,
    recordCompletedRace,
    retireEmptyGuestIdentity,
    settleOwedRewards,
    clearOwedRewards,
    type CarUnlockSnapshot,
} from './car-unlock-store.js';
import {
    cleanupGuestCampaignProgress,
    discardGuestCampaignProgress,
    getCampaignResultsForCarUnlocks,
    getCampaignProgressForSelection,
    mergeGuestCampaignProgress,
} from './campaign-store.js';
import { campaignProgressKey } from './campaign-progress-key.js';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    getCampaignUnlockedRaceIds,
} from '../../game/campaign/manifest.js';
import {
    STOCK_CAR_ASSET_NAME,
    isCarAssetUnlocked,
} from '../../game/car/car-unlock-policy.js';
import { GENERATED_PLAYER_SELECTABLE_CAR_ASSETS } from '../../game/car/generated-player-selectable-car-assets.js';
import { verifyGuestPlayerToken } from './player-token.js';
import {
    guestProgressSelectionAccountPendingKey,
    guestProgressTransferReceiptKey,
    guestProgressTransferIndexKey,
    guestProgressSelectionPendingKey,
    isGuestProgressSelectionPending,
    resolveGuestIdentityStatus,
    isPlayerProgressSelectionPending,
} from './guest-retirement.js';
import {
    competitionSubmissionLockKey,
    isMismatchedSubmissionOwner,
    submitCompetitionRun,
    SUBMISSION_IDENTITY_CHANGED_RESULT,
    SUBMISSION_LOCK_TTL_MS,
    type RankedSubmitReuseOptions,
} from './competition-submit.js';

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
    carUnlocks: CarUnlockSnapshot | null;
    retireGuestIdentity: boolean;
    guestJoinedAccount?: boolean;
    progressSelection?: GuestProgressSelection | null;
};

export type GuestProgressSelection = {
    required: boolean;
    guestHasProgress: boolean;
    accountHasProgress: boolean;
    guestSummary: {
        hasDailyResults: boolean;
        campaignResults: number;
        campaignUnlockedTracks: number | null;
        campaignTotalStages: number;
        dailySavedResults: number | null;
        dailyPlaylistSize: number | null;
        carsUnlocked: number | null;
        carsTotal: number;
        unlocks: boolean;
    };
    accountSummary: {
        hasDailyResults: boolean;
        campaignResults: number;
        campaignUnlockedTracks: number | null;
        campaignTotalStages: number;
        dailySavedResults: number | null;
        dailyPlaylistSize: number | null;
        carsUnlocked: number | null;
        carsTotal: number;
        unlocks: boolean;
    };
    choice?: 'guest' | 'account';
    state?: 'choice_required' | 'resume_required' | 'recovery_required' | 'completed';
    transferId?: string;
    sourceGuestPlayerId?: string;
    completedAt?: string;
};

function unavailableProgressSummary({
    hasDailyResults = false,
    campaignResults = 0,
    unlocks = false,
}: {
    hasDailyResults?: boolean;
    campaignResults?: number;
    unlocks?: boolean;
} = {}): GuestProgressSelection['guestSummary'] {
    return {
        hasDailyResults,
        campaignResults,
        campaignUnlockedTracks: null,
        campaignTotalStages: CAMPAIGN_STAGES.length,
        dailySavedResults: null,
        dailyPlaylistSize: null,
        carsUnlocked: null,
        carsTotal: GENERATED_PLAYER_SELECTABLE_CAR_ASSETS.length,
        unlocks,
    };
}

type GuestTransferPhase = 'preparing' | 'copying' | 'cleaning' | 'completed' | 'recovery_required';

type GuestProgressSelectionRecord = {
    version?: 2 | 3 | 4;
    transferId?: string;
    guestPlayerId: string;
    redditPlayerId: string;
    choice: 'guest' | 'account';
    status: 'pending' | 'completed' | 'recovery_required';
    phase?: GuestTransferPhase;
    updatedAt: string;
    completedDomains: string[];
    cleanedDomains?: string[];
    dailyChallengeIds?: string[];
    dailyChallengeSpecs?: GuestTransferDailyChallengeSpec[];
    sourceInventory?: GuestTransferSourceInventory;
    completedAt?: string;
};

type GuestTransferReceipt = {
    version: 4;
    transferId: string;
    guestPlayerId: string;
    redditPlayerId: string;
    choice: 'guest' | 'account';
    completedAt: string;
};

type GuestTransferDailyChallengeSpec = {
    id: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    rulesRevision: number;
    objectiveType: 'single_lap_fastest' | 'multi_lap_total';
};

type GuestTransferSourceInventory = {
    campaignProgress: string;
    campaignStages: Record<string, string>;
    daily: Record<string, string>;
    unlocks: string;
    unlockFields?: Record<string, string>;
};

function stableFingerprint(value: unknown): string {
    const serialize = (input: unknown): string => {
        if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? '';
        if (Array.isArray(input)) return `[${input.map(serialize).join(',')}]`;
        return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${serialize((input as Record<string, unknown>)[key])}`).join(',')}}`;
    };
    return createHash('sha256').update(serialize(value), 'utf8').digest('base64url');
}

function transferChallengeSpec(challenge: DailyGpChallenge): GuestTransferDailyChallengeSpec {
    return {
        id: challenge.id,
        trackKey: challenge.trackKey,
        lapCount: challenge.objectiveParams.lapCount,
        rulesRevision: challenge.rulesRevision,
        objectiveType: challenge.objectiveType,
    };
}

function transferChallengeFromSpec(spec: GuestTransferDailyChallengeSpec): DailyGpChallenge {
    return {
        id: spec.id,
        challengeDate: spec.id.replace(/^daily-gp-/, ''),
        trackKey: spec.trackKey,
        rulesRevision: spec.rulesRevision,
        objectiveType: spec.objectiveType,
        objectiveParams: { lapCount: spec.lapCount },
        availableFrom: '',
        availableUntil: '',
    } as unknown as DailyGpChallenge;
}

async function captureCampaignStageEvidence(
    guestPlayerId: string,
): Promise<Record<string, string>> {
    const playerField = createHash('sha256').update(guestPlayerId, 'utf8').digest('base64url');
    const rows = await Promise.all(CAMPAIGN_STAGES.map(async (stage) => {
        const competition = toCampaignCompetition(CAMPAIGN_ID, stage);
        const [entry, pb, rank] = await Promise.all([
            redis.hGet(competition.entryHashKey, guestPlayerId),
            redisCompressed.hGet(competition.pbHashKey, playerField),
            typeof redis.zScore === 'function'
                ? redis.zScore(competition.leaderboardKey, guestPlayerId)
                : Promise.resolve(null),
        ]);
        return [
            stage.raceId,
            stableFingerprint({ entry: entry ?? null, pb: pb ?? null, rank: rank ?? null }),
        ] as const;
    }));
    return Object.fromEntries(rows);
}

async function captureDailyEvidence(
    guestPlayerId: string,
    challengeSpecs: readonly GuestTransferDailyChallengeSpec[],
): Promise<Record<string, string>> {
    const field = dailyPlayerField(guestPlayerId);
    const rows = await Promise.all(challengeSpecs.map(async (spec) => {
        const competition = toDailyCompetition(transferChallengeFromSpec(spec));
        const [entry, pb, rank] = await Promise.all([
            redis.hGet(competition.entryHashKey, guestPlayerId),
            redisCompressed.hGet(competition.pbHashKey, field),
            typeof redis.zScore === 'function'
                ? redis.zScore(competition.leaderboardKey, guestPlayerId)
                : Promise.resolve(null),
        ]);
        return [
            spec.id,
            stableFingerprint({ entry: entry ?? null, pb: pb ?? null, rank: rank ?? null }),
        ] as const;
    }));
    return Object.fromEntries(rows);
}

async function captureGuestTransferSourceInventory(
    guestPlayerId: string,
    challengeSpecs: readonly GuestTransferDailyChallengeSpec[],
): Promise<GuestTransferSourceInventory> {
    const [campaignProgress, campaignStages, daily, unlocks] = await Promise.all([
        redis.get(campaignProgressKey(guestPlayerId)),
        captureCampaignStageEvidence(guestPlayerId),
        captureDailyEvidence(guestPlayerId, challengeSpecs),
        redis.hGetAll(carUnlockHashKey(guestPlayerId)),
    ]);
    return {
        campaignProgress: stableFingerprint(campaignProgress ?? null),
        campaignStages,
        daily,
        unlocks: stableFingerprint(unlocks ?? null),
        unlockFields: { ...(unlocks ?? {}) },
    };
}

function changedInventoryDomains(
    expected: GuestTransferSourceInventory,
    observed: Partial<GuestTransferSourceInventory>,
): string[] {
    const rowsChanged = (
        expectedRows: Record<string, string>,
        observedRows: Record<string, string> | undefined,
    ): boolean => (
        observedRows !== undefined
        && Object.entries(expectedRows).some(([key, value]) => observedRows[key] !== value)
    );
    const changed: string[] = [];
    if (rowsChanged(expected.campaignStages, observed.campaignStages)
        || (observed.campaignProgress !== undefined
            && observed.campaignProgress !== expected.campaignProgress)) {
        changed.push('campaign');
    }
    if (rowsChanged(expected.daily, observed.daily)) changed.push('daily');
    if (unlocksChanged(expected, observed)) changed.push('unlocks');
    return changed;
}

function isValidSourceInventory(value: unknown): value is GuestTransferSourceInventory {
    return isRecordObject(value)
        && typeof value.campaignProgress === 'string'
        && isRecordObject(value.campaignStages)
        && isRecordObject(value.daily)
        && typeof value.unlocks === 'string'
        && (value.unlockFields === undefined || isRecordObject(value.unlockFields));
}

function unlocksChanged(
    expected: GuestTransferSourceInventory,
    observed: Partial<GuestTransferSourceInventory>,
): boolean {
    if (observed.unlockFields !== undefined && expected.unlockFields !== undefined) {
        const now = observed.unlockFields;
        for (const [field, value] of Object.entries(expected.unlockFields)) {
            if (now[field] !== value) return true;
        }
        for (const [field, value] of Object.entries(now)) {
            if (field in expected.unlockFields) continue;
            if (!isValidCarUnlockEventField(field, value)) return true;
        }
        return false;
    }
    return observed.unlocks !== undefined && observed.unlocks !== expected.unlocks;
}

const EMPTY_DAILY_ROW_FINGERPRINT = stableFingerprint({ entry: null, pb: null, rank: null });

function recordedDailyDays(
    inventory: GuestTransferSourceInventory | undefined,
): ReadonlySet<string> {
    return new Set(
        Object.entries(inventory?.daily ?? {})
            .filter(([, fingerprint]) => fingerprint !== EMPTY_DAILY_ROW_FINGERPRINT)
            .map(([challengeId]) => challengeId),
    );
}

const TRANSFER_COMPLETION_DOMAINS = ['campaign', 'daily', 'unlocks'] as const;
const TRANSFER_CLEANUP_DOMAINS = ['campaign', 'daily'] as const;
const ACCOUNT_TRANSFER_INDEX_LIMIT = 20;
const TRANSFER_COMPLETION_NEWS_MS = 7 * 24 * 60 * 60 * 1000;

function isRecordObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrderedDomainPrefix(
    value: unknown,
    domains: readonly string[],
): value is string[] {
    return Array.isArray(value)
        && value.every((domain, index) => domain === domains[index]);
}

function isValidRecoverySelectionRecord(
    value: unknown,
    guestPlayerId: string,
    redditPlayerId: string,
): value is GuestProgressSelectionRecord {
    if (!isRecordObject(value)) return false;
    return value.status === 'recovery_required'
        && (value.choice === 'guest' || value.choice === 'account')
        && (value.guestPlayerId === undefined || value.guestPlayerId === guestPlayerId)
        && (value.redditPlayerId === undefined || value.redditPlayerId === redditPlayerId);
}

function isValidPendingSelectionRecord(
    value: unknown,
    guestPlayerId: string,
    redditPlayerId: string,
): value is GuestProgressSelectionRecord {
    if (!isRecordObject(value)) return false;
    const completedDomains = value.completedDomains;
    if (
        (value.version !== 2 && value.version !== 3 && value.version !== 4)
        || value.status !== 'pending'
        || value.guestPlayerId !== guestPlayerId
        || value.redditPlayerId !== redditPlayerId
        || (value.choice !== 'guest' && value.choice !== 'account')
        || typeof value.updatedAt !== 'string'
        || !value.updatedAt
        || !Array.isArray(value.dailyChallengeIds)
        || value.dailyChallengeIds.length === 0
        || value.dailyChallengeIds.some((challengeId) => typeof challengeId !== 'string' || !challengeId)
        || !isOrderedDomainPrefix(completedDomains, TRANSFER_COMPLETION_DOMAINS)
    ) {
        return false;
    }
    const cleanedDomains = value.cleanedDomains ?? [];
    if (!isOrderedDomainPrefix(cleanedDomains, TRANSFER_CLEANUP_DOMAINS)) return false;
    if (value.choice === 'account' && cleanedDomains.length > 0) return false;
    if (
        value.choice === 'guest'
        && cleanedDomains.length > 0
        && completedDomains.length !== TRANSFER_COMPLETION_DOMAINS.length
    ) {
        return false;
    }
    if (value.version === 4) {
        if (value.transferId !== guestProgressSelectionTransferId(guestPlayerId, redditPlayerId)) {
            return false;
        }
        if (!isValidTransferPhase(value.phase)) return false;
        if (value.phase !== 'preparing'
            && hasReplacementRemaining(value as GuestProgressSelectionRecord)
            && !isValidSourceInventory(value.sourceInventory)) {
            return false;
        }
        if (value.sourceInventory !== undefined && !isValidSourceInventory(value.sourceInventory)) {
            return false;
        }
        if (value.phase === 'preparing' && completedDomains.length > 0) return false;
    }
    if (value.version === 3 || value.version === 4) {
        if (!isValidDailyChallengeSpecs(value.dailyChallengeSpecs, value.dailyChallengeIds)) {
            return false;
        }
    }
    return true;
}

function isValidTransferPhase(value: unknown): value is GuestTransferPhase {
    return value === 'preparing'
        || value === 'copying'
        || value === 'cleaning'
        || value === 'completed'
        || value === 'recovery_required';
}

function isValidDailyChallengeSpecs(
    value: unknown,
    challengeIds: readonly unknown[],
): value is GuestTransferDailyChallengeSpec[] {
    return Array.isArray(value)
        && value.length === challengeIds.length
        && value.every((spec, index) => (
            isRecordObject(spec)
            && typeof spec.id === 'string'
            && spec.id === challengeIds[index]
            && typeof spec.trackKey === 'string'
            && [1, 2, 3].includes(spec.lapCount as number)
            && typeof spec.rulesRevision === 'number'
            && (spec.objectiveType === 'single_lap_fastest' || spec.objectiveType === 'multi_lap_total')
        ));
}

function isValidCompletedSelectionRecord(
    value: unknown,
    guestPlayerId: string,
    redditPlayerId: string,
): value is GuestProgressSelectionRecord {
    if (!isRecordObject(value) || value.status !== 'completed') return false;
    if (value.version !== undefined
        && value.version !== 2
        && value.version !== 3
        && value.version !== 4) {
        return false;
    }
    if (value.choice !== 'guest' && value.choice !== 'account') return false;
    if (value.guestPlayerId !== guestPlayerId || value.redditPlayerId !== redditPlayerId) return false;
    if (value.version === 4
        && value.transferId !== guestProgressSelectionTransferId(guestPlayerId, redditPlayerId)) {
        return false;
    }
    return true;
}

function guestProgressSelectionKey(guestPlayerId: string, redditPlayerId: string): string {
    return `dailygp:guest-progress-selection:v1:${createHash('sha256')
        .update(`${guestPlayerId}:${redditPlayerId}`, 'utf8')
        .digest('base64url')}`;
}

function guestProgressSelectionLockKey(guestPlayerId: string, redditPlayerId: string): string {
    return `${guestProgressSelectionKey(guestPlayerId, redditPlayerId)}:lock`;
}

function guestProgressSelectionAccountLockKey(redditPlayerId: string): string {
    return `${guestProgressSelectionAccountPendingKey(redditPlayerId)}:lock`;
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

    const positionAt = (rank: 1 | 2 | 3) => rankedPositions[rank - 1] ?? {
        rank,
        displayName: 'No verified finish',
        identityType: 'empty' as const,
        formattedTime: null,
    };
    return [positionAt(1), positionAt(2), positionAt(3)];
}


async function releaseSubmissionLocksSafely(
    locks: readonly RedisLock[],
    context: string,
): Promise<void> {
    await releaseRedisLockGroup(locks, context, redis);
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
                throw new GuestProgressSelectionRetryableError(
                    'Daily guest merge is temporarily busy. Try again.',
                );
            }
            locks.push(lock);
        }
        return locks;
    } catch (error) {
        await releaseSubmissionLocksSafely(locks, 'Daily guest merge');
        throw error;
    }
}

function guestProgressRecoveryRequiredError(): GuestProgressRecoveryRequiredError {
    return new GuestProgressRecoveryRequiredError();
}

const GUEST_PROGRESS_TRANSFER_NOT_NEEDED_REASON = 'guest_progress_transfer_not_needed';

function guestProgressTransferNotNeededError(): Error {
    return Object.assign(
        new Error('This guest has no progress to transfer. Reload to continue with your account.'),
        { statusCode: 409, reason: GUEST_PROGRESS_TRANSFER_NOT_NEEDED_REASON },
    );
}

async function resolveGuestTransferDailyChallenges(challengeIds?: string[]): Promise<DailyGpChallenge[]> {
    if (!Array.isArray(challengeIds)) {
        return getServerDailyGpPlaylist();
    }
    if (challengeIds.length === 0) return [];
    const challenges = await Promise.all(challengeIds.map((challengeId) => (
        getServerDailyGpChallengeById(challengeId, { persistFallback: false })
    )));
    if (challenges.some((challenge) => !challenge || !TRACKS[challenge.trackKey])) {
        throw guestProgressRecoveryRequiredError();
    }
    return challenges as DailyGpChallenge[];
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
    guestSource?: ClassifiedGuestDailySource | null,
) {
    const [guestEntry, redditEntry, guestPb, redditPb, redditRankedScore] = await Promise.all([
        guestSource
            ? Promise.resolve(guestSource.entry)
            : readEntryByPlayerId(competition, guestPlayerId),
        readEntryByPlayerId(competition, redditPlayerId),
        guestSource
            ? Promise.resolve(guestSource.pb)
            : getPlayerTrackPbRecord({
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

async function guestOwnsDailyDay(
    competition: ReturnType<typeof toDailyCompetition>,
    guestPlayerId: string,
): Promise<boolean> {
    return await competitionHoldsPlayerRows(competition, guestPlayerId);
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

export type FinalDailyGpPodiumGhostPack = {
    trackKey: string;
    trackFingerprint: string;
    ghosts: readonly [
        DailyPodiumReplayGhostSlot,
        DailyPodiumReplayGhostSlot,
        DailyPodiumReplayGhostSlot,
    ];
};

export async function getServerFinalDailyGpPodiumGhosts(
    podium: Pick<FinalDailyGpPodium, 'challengeId' | 'trackKey' | 'lapCount'>,
): Promise<FinalDailyGpPodiumGhostPack | null> {
    const challenge = await readStoredOrBackfilledDailyGpChallenge(podium.challengeId);
    const track = challenge ? TRACKS[challenge.trackKey] : null;
    if (!challenge || !track || challenge.trackKey !== podium.trackKey) return null;

    const fingerprint = createTrackFingerprint(track);

    const rankedMembers = await redis.zRange(
        createRedisChallengeLeaderboardKey(challenge.id),
        0,
        2,
    );
    const competition = toDailyCompetition(challenge);
    const slots = await Promise.all((rankedMembers ?? []).map(async (member, index) => {
        const rank = (index + 1) as 1 | 2 | 3;
        if (rank > 3 || typeof member?.member !== 'string') {
            return { rank, ghost: null } satisfies DailyPodiumReplayGhostSlot;
        }
        const record = await getPlayerTrackPbRecord({
            playerId: member.member,
            competition,
            track,
        });
        return {
            rank,
            ghost: record?.ghost ?? null,
        } satisfies DailyPodiumReplayGhostSlot;
    }));

    const ghostAt = (rank: 1 | 2 | 3) => slots.find((slot) => slot.rank === rank) ?? { rank, ghost: null };
    const ghosts: FinalDailyGpPodiumGhostPack['ghosts'] = [ghostAt(1), ghostAt(2), ghostAt(3)];

    return {
        trackKey: challenge.trackKey,
        trackFingerprint: fingerprint,
        ghosts,
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

type ClassifiedGuestDailySource = {
    entry: ReturnType<typeof parseStoredEntry>;
    pb: Awaited<ReturnType<typeof getPlayerTrackPbRecord>>;
    decodedPb: string | null;
    observed: { entry: string | null; pb: string | null; rank: number | null };
    malformed: string[];
};

async function captureClassifiedGuestDailySource(
    competition: ReturnType<typeof toDailyCompetition>,
    track: Record<string, any>,
    challenge: DailyGpChallenge,
    guestPlayerId: string,
): Promise<ClassifiedGuestDailySource> {
    const [rawEntry, decodedPb, rank] = await Promise.all([
        redis.hGet(competition.entryHashKey, guestPlayerId),
        redisCompressed.hGet(competition.pbHashKey, dailyPlayerField(guestPlayerId)),
        typeof redis.zScore === 'function'
            ? redis.zScore(competition.leaderboardKey, guestPlayerId)
            : Promise.resolve(null),
    ]);
    const entryClass = classifyStoredLeaderboardEntry(rawEntry, guestPlayerId, {
        trackKey: challenge.trackKey,
        lapCount: challenge.objectiveParams.lapCount,
    });
    const pbClass = classifyStoredPbRecordFor(decodedPb, competition, track);

    const malformed: string[] = [];
    if (entryClass.state === 'malformed') {
        malformed.push(`daily:entry:${challenge.id}:${entryClass.reason}`);
    }
    if (pbClass.state === 'malformed') {
        malformed.push(`daily:pb:${challenge.id}:${pbClass.reason}`);
    }

    return {
        entry: entryClass.state === 'valid' ? parseStoredEntry(rawEntry, challenge.trackKey) : null,
        pb: pbClass.state === 'valid' ? pbClass.record : null,
        decodedPb: pbClass.state === 'valid' && typeof decodedPb === 'string' ? decodedPb : null,
        observed: {
            entry: rawEntry ?? null,
            pb: decodedPb ?? null,
            rank: rank ?? null,
        },
        malformed,
    };
}

export async function mergeGuestDailyProgress({
    guestPlayerId,
    redditPlayerId,
    replace = false,
    challengeIds,
    challengeSpecs,
    verifyGuestSource,
    recordedDailyChallengeIds,
    transactionRunner,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    replace?: boolean;
    challengeIds?: string[];
    challengeSpecs?: GuestTransferDailyChallengeSpec[];
    verifyGuestSource?: (observed?: {
        dailyDay: { challengeId: string; entry: string | null; pb: string | null; rank: number | null };
    }) => void | Promise<void>;
    recordedDailyChallengeIds?: ReadonlySet<string>;
    transactionRunner?: RedisLockTransactionRunner;
}): Promise<{ merged: boolean; mergedChallengeIds: string[] }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return { merged: false, mergedChallengeIds: [] };
    }

    const playlist = await resolveGuestTransferDailyChallenges(challengeIds);
    const mergedChallengeIds: string[] = [];
    let hasGuestEvidence = false;

    await verifyGuestSource?.();

    for (const challenge of playlist) {
        const competition = toDailyCompetition(challenge);
        const track = TRACKS[challenge.trackKey];
        if (!track) {
            if (challengeSpecs?.some((spec) => spec.id === challenge.id)) {
                throw guestProgressRecoveryRequiredError();
            }
            continue;
        }

        const [guestHoldsRows, accountHoldsRows] = await Promise.all([
            competitionHoldsPlayerRows(competition, guestPlayerId),
            competitionHoldsPlayerRows(competition, redditPlayerId),
        ]);
        const wasRecorded = recordedDailyChallengeIds?.has(challenge.id) ?? false;
        if (!guestHoldsRows && !accountHoldsRows && !wasRecorded) continue;
        hasGuestEvidence ||= guestHoldsRows;

        const locks = await acquireDailyMergeLocks(
            competition,
            guestPlayerId,
            redditPlayerId,
        );
        try {
            const guestSource = replace
                ? await captureClassifiedGuestDailySource(
                    competition,
                    track,
                    challenge,
                    guestPlayerId,
                )
                : null;
            if (guestSource?.malformed.length) {
                throw guestProgressRecoveryRequiredError();
            }
            if (guestSource) {
                await verifyGuestSource?.({
                    dailyDay: { challengeId: challenge.id, ...guestSource.observed },
                });
            }
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
                guestSource,
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
                ? withOpponentRaceReady(
                    {
                        playerId: redditPlayerId,
                        trackKey: challenge.trackKey,
                        bestTimeMs: guestPb.bestTimeMs,
                        updatedAt: guestPb.updatedAt,
                        completedLaps: challenge.objectiveParams.lapCount,
                        checkpointTimesSec: guestPb.checkpointTimesSec,
                        validationMethod: 'strict-replay' as const,
                    },
                    guestPb,
                    competition,
                )
                : guestWinsLeaderboard
                    ? { ...guestEntry!, playerId: redditPlayerId }
                    : (!replace && redditEntry && Number(redditRankedScore) !== redditEntry.bestTimeMs
                        ? redditEntry
                        : null);

            const accountLock = dailyMergeLockForPlayer(
                locks,
                competition,
                redditPlayerId,
            );
            if (transactionRunner) {
                if (!accountLock) {
                    throw new GuestProgressSelectionRetryableError(
                        'Daily guest merge lost its ownership lock. Try again.',
                    );
                }
                let rawGuestPb: string | undefined;
                if (guestCanSupplyWinningPb) {
                    if (guestSource) {
                        rawGuestPb = guestSource.decodedPb === null
                            ? undefined
                            : encodeRedisCompressedValue(guestSource.decodedPb);
                    } else {
                        rawGuestPb = await redis.hGet(
                            competition.pbHashKey,
                            dailyPlayerField(guestPlayerId),
                        );
                    }
                    if (!rawGuestPb) {
                        throw new Error(`Daily guest PB disappeared during promotion: ${challenge.id}`);
                    }
                }
                if (entryToWrite || replace || rawGuestPb) {
                    await transactionRunner([accountLock], async (transaction) => {
                        if (entryToWrite) {
                            await writeEntry(competition, redditPlayerId, entryToWrite, transaction);
                        } else if (replace) {
                            await transaction.hDel(competition.entryHashKey, [redditPlayerId]);
                            await transaction.zRem(competition.leaderboardKey, [redditPlayerId]);
                            await transaction.incrBy(competition.standingsRevisionKey, 1);
                        }
                        if (rawGuestPb) {
                            await transaction.hSet(competition.pbHashKey, {
                                [dailyPlayerField(redditPlayerId)]: rawGuestPb,
                            });
                        } else if (replace) {
                            await transaction.hDel(competition.pbHashKey, [dailyPlayerField(redditPlayerId)]);
                        }
                    });
                }
            } else {
                if (entryToWrite || replace) {
                    if (!accountLock) {
                        throw new GuestProgressSelectionRetryableError(
                            'Daily guest merge lost its ownership lock. Try again.',
                        );
                    }
                    const transaction = await beginOwnedRedisLockTransaction(accountLock, redis);
                    if (!transaction) {
                        throw new GuestProgressSelectionRetryableError(
                            'Daily guest merge lost its ownership lock. Try again.',
                        );
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
                    if (!await commitOwnedRedisLockTransaction(transaction)) {
                        throw new GuestProgressSelectionRetryableError(
                            'Daily leaderboard copy was interrupted. Try again.',
                        );
                    }
                }
                if (guestCanSupplyWinningPb) {
                    const rawGuestPb = guestSource
                        ? guestSource.decodedPb
                        : await redisCompressed.hGet(
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
            }
            if (guestWinsLeaderboard) {
                mergedChallengeIds.push(challenge.id);
            }
        } finally {
            await releaseSubmissionLocksSafely(locks, 'Daily guest merge');
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

export async function cleanupGuestDailyProgress({
    guestPlayerId,
    challengeIds,
    challengeSpecs,
}: {
    guestPlayerId: string;
    challengeIds?: string[];
    challengeSpecs?: GuestTransferDailyChallengeSpec[];
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const playlist = Array.isArray(challengeSpecs)
        ? challengeSpecs.map(transferChallengeFromSpec)
        : await resolveGuestTransferDailyChallenges(challengeIds);
    let cleaned = false;
    for (const challenge of playlist) {
        const competition = toDailyCompetition(challenge);
        if (!await guestOwnsDailyDay(competition, guestPlayerId)) continue;
        cleaned = true;
        const lock = await acquireRedisLock(
            competitionSubmissionLockKey(competition, guestPlayerId),
            SUBMISSION_LOCK_TTL_MS,
            redis,
        );
        if (!lock) {
            throw new GuestProgressSelectionRetryableError(
                'Daily guest cleanup is temporarily busy. Try again.',
            );
        }
        try {
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) {
                throw new GuestProgressSelectionRetryableError(
                    'Daily guest cleanup lost its ownership lock. Try again.',
                );
            }
            await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
            await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
            await transaction.hDel(competition.pbHashKey, [dailyPlayerField(guestPlayerId)]);
            await transaction.incrBy(competition.standingsRevisionKey, 1);
            if (!await commitOwnedRedisLockTransaction(transaction)) {
                throw new GuestProgressSelectionRetryableError(
                    'Daily guest cleanup was interrupted. Try again.',
                );
            }
        } finally {
            await releaseSubmissionLocksSafely([lock], 'Daily guest cleanup');
        }
    }
    return cleaned;
}

export async function discardGuestDailyProgress({
    guestPlayerId,
    challengeIds,
    challengeSpecs,
}: {
    guestPlayerId: string;
    challengeIds?: string[];
    challengeSpecs?: GuestTransferDailyChallengeSpec[];
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const playlist = Array.isArray(challengeSpecs)
        ? challengeSpecs.map(transferChallengeFromSpec)
        : await resolveGuestTransferDailyChallenges(challengeIds);
    let discarded = false;
    for (const challenge of playlist) {
        const competition = toDailyCompetition(challenge);
        if (!await guestOwnsDailyDay(competition, guestPlayerId)) continue;
        discarded = true;
        const lock = await acquireRedisLock(
            competitionSubmissionLockKey(competition, guestPlayerId),
            SUBMISSION_LOCK_TTL_MS,
            redis,
        );
        if (!lock) {
            throw new GuestProgressSelectionRetryableError(
                'Daily guest discard is temporarily busy. Try again.',
            );
        }
        try {
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) {
                throw new GuestProgressSelectionRetryableError(
                    'Daily guest discard lost its ownership lock. Try again.',
                );
            }
            await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
            await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
            await transaction.hDel(competition.pbHashKey, [dailyPlayerField(guestPlayerId)]);
            await transaction.incrBy(competition.standingsRevisionKey, 1);
            if (!await commitOwnedRedisLockTransaction(transaction)) {
                throw new GuestProgressSelectionRetryableError(
                    'Daily guest discard was interrupted. Try again.',
                );
            }
        } finally {
            await releaseSubmissionLocksSafely([lock], 'Daily guest discard');
        }
    }
    return discarded;
}

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

async function readProgressEvidence(playerId: string, dailyPlaylist: DailyGpChallenge[]) {
    const [initialCampaign, unlocks, profile] = await Promise.all([
        getCampaignProgressForSelection(playerId, { repairEmpty: false }),
        hasCarUnlockProgress(playerId),
        readPlayerProfile(playerId),
    ]);
    const campaign = !playerId.startsWith('guest:')
        && !initialCampaign.startedAt
        && !Object.keys(initialCampaign.resultsByRaceId).length
        && (unlocks || profile?.hasAnyData)
        ? await getCampaignProgressForSelection(playerId)
        : initialCampaign;
    const campaignResults = Object.keys(campaign.resultsByRaceId).length;
    const campaignUnlockedTracks = getCampaignUnlockedRaceIds(campaign.resultsByRaceId).length;
    const [dailySavedResults, carUnlocks] = await Promise.all([
        countDailyProgressResults(playerId, dailyPlaylist),
        getCarUnlockSnapshot(playerId, campaign.resultsByRaceId),
    ]);
    return {
        campaignResults,
        campaignUnlockedTracks,
        campaignTotalStages: CAMPAIGN_STAGES.length,
        dailySavedResults,
        dailyPlaylistSize: dailyPlaylist.length,
        carsUnlocked: carUnlocks.unlockedAssets.length,
        carsTotal: GENERATED_PLAYER_SELECTABLE_CAR_ASSETS.length,
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

async function guestHoldsTransferableProgress(
    guestPlayerId: string,
    dailyPlaylist: readonly DailyGpChallenge[],
): Promise<boolean> {
    const rawProgress = await redis.get(campaignProgressKey(guestPlayerId));
    if (rawProgress) {
        try {
            const progress = JSON.parse(rawProgress) as { startedAt?: unknown; resultsByRaceId?: unknown };
            const results = progress?.resultsByRaceId;
            if (progress?.startedAt
                || !results
                || typeof results !== 'object'
                || Object.keys(results).length > 0) {
                return true;
            }
        } catch {
            return true;
        }
    }
    if (await hasCarUnlockProgress(guestPlayerId)) return true;
    if ((await readPlayerProfile(guestPlayerId))?.hasAnyData) return true;
    const competitions = [
        ...CAMPAIGN_STAGES.map((stage) => toCampaignCompetition(CAMPAIGN_ID, stage)),
        ...dailyPlaylist.map((challenge) => toDailyCompetition(challenge)),
    ];
    const holds = await Promise.all(competitions.map((competition) => (
        competitionHoldsPlayerRows(competition, guestPlayerId)
    )));
    return holds.some(Boolean);
}

function toProgressSummary(evidence: Awaited<ReturnType<typeof readProgressEvidence>>) {
    return {
        hasDailyResults: evidence.hasDailyResults,
        campaignResults: evidence.campaignResults,
        campaignUnlockedTracks: evidence.campaignUnlockedTracks,
        campaignTotalStages: evidence.campaignTotalStages,
        dailySavedResults: evidence.dailySavedResults,
        dailyPlaylistSize: evidence.dailyPlaylistSize,
        carsUnlocked: evidence.carsUnlocked,
        carsTotal: evidence.carsTotal,
        unlocks: evidence.unlocks,
    };
}

function guestProgressSelectionTransferId(guestPlayerId: string, redditPlayerId: string): string {
    return `guest-transfer:${createHash('sha256')
        .update(`${guestPlayerId}:${redditPlayerId}`, 'utf8')
        .digest('base64url')}`;
}

function pendingSelectionPayload({
    guestPlayerId,
    redditPlayerId,
    choice,
    state,
    required = true,
    completedAt,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    choice?: 'guest' | 'account';
    state: 'choice_required' | 'resume_required' | 'recovery_required' | 'completed';
    required?: boolean;
    completedAt?: string;
}): GuestProgressSelection {
    return {
        required,
        state,
        transferId: guestProgressSelectionTransferId(guestPlayerId, redditPlayerId),
        sourceGuestPlayerId: guestPlayerId,
        guestHasProgress: true,
        accountHasProgress: false,
        guestSummary: unavailableProgressSummary({ hasDailyResults: true, unlocks: true }),
        accountSummary: unavailableProgressSummary(),
        ...(choice ? { choice } : {}),
        ...(completedAt ? { completedAt } : {}),
    } as GuestProgressSelection;
}

async function readGuestTransferReceipt(
    transferId: string,
    redditPlayerId: string,
): Promise<GuestTransferReceipt | null> {
    const raw = await redis.get(guestProgressTransferReceiptKey(transferId));
    if (!raw) return null;
    try {
        const receipt = JSON.parse(raw) as unknown;
        if (!isRecordObject(receipt)) return null;
        if (receipt.redditPlayerId !== redditPlayerId) return null;
        if (receipt.transferId !== transferId) return null;
        if (typeof receipt.guestPlayerId !== 'string' || !receipt.guestPlayerId.startsWith('guest:')) {
            return null;
        }
        if (receipt.choice !== 'guest' && receipt.choice !== 'account') return null;
        if (typeof receipt.completedAt !== 'string' || !receipt.completedAt) return null;
        return receipt as GuestTransferReceipt;
    } catch {
        return null;
    }
}

function parseAccountTransferIndex(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry));
    } catch {
        return [];
    }
}

async function readAccountTransferIndex(redditPlayerId: string): Promise<string[]> {
    return parseAccountTransferIndex(
        await redis.get(guestProgressTransferIndexKey(redditPlayerId)),
    );
}

function hasReplacementRemaining(record: GuestProgressSelectionRecord): boolean {
    return record.choice === 'guest'
        && !TRANSFER_COMPLETION_DOMAINS.every(
            (domain) => record.completedDomains?.includes(domain),
        );
}

function resumableRecordState(
    record: GuestProgressSelectionRecord,
): 'resume_required' | 'recovery_required' {
    if (record.phase === 'recovery_required') return 'recovery_required';
    if (!hasReplacementRemaining(record)) return 'resume_required';
    if (record.version !== 4 || !isValidSourceInventory(record.sourceInventory)) {
        return 'recovery_required';
    }
    return 'resume_required';
}

export async function resolveAccountTransferState(
    redditPlayerId: string,
    { transferId }: { transferId?: string } = {},
): Promise<GuestProgressSelection | null> {
    if (!redditPlayerId.startsWith('reddit:')) return null;
    if (transferId) {
        const receipt = await readGuestTransferReceipt(transferId, redditPlayerId);
        if (receipt) {
            return pendingSelectionPayload({
                guestPlayerId: receipt.guestPlayerId,
                redditPlayerId,
                choice: receipt.choice,
                state: 'completed',
                completedAt: receipt.completedAt,
            });
        }
    }
    const [pendingGuest, rawIndex] = await redis.mGet([
        guestProgressSelectionAccountPendingKey(redditPlayerId),
        guestProgressTransferIndexKey(redditPlayerId),
    ]);
    if (typeof pendingGuest === 'string' && pendingGuest.startsWith('guest:')) {
        const raw = await redis.get(guestProgressSelectionKey(pendingGuest, redditPlayerId));
        if (!raw) {
            return pendingSelectionPayload({
                guestPlayerId: pendingGuest,
                redditPlayerId,
                state: 'choice_required',
            });
        }
        try {
            const record = JSON.parse(raw) as unknown;
            if (isValidCompletedSelectionRecord(record, pendingGuest, redditPlayerId)) {
                return pendingSelectionPayload({
                    guestPlayerId: pendingGuest,
                    redditPlayerId,
                    choice: record.choice,
                    state: 'completed',
                    completedAt: record.completedAt || record.updatedAt,
                });
            }
            if (isValidPendingSelectionRecord(record, pendingGuest, redditPlayerId)) {
                return pendingSelectionPayload({
                    guestPlayerId: pendingGuest,
                    redditPlayerId,
                    choice: record.choice,
                    state: resumableRecordState(record),
                });
            }
            if (isValidRecoverySelectionRecord(record, pendingGuest, redditPlayerId)) {
                return pendingSelectionPayload({
                    guestPlayerId: pendingGuest,
                    redditPlayerId,
                    choice: record.choice,
                    state: 'recovery_required',
                });
            }
        } catch {
        }
        return pendingSelectionPayload({
            guestPlayerId: pendingGuest,
            redditPlayerId,
            state: 'recovery_required',
        });
    }
    const index = parseAccountTransferIndex(rawIndex);
    const oldestNewsAt = Date.now() - TRANSFER_COMPLETION_NEWS_MS;
    for (let position = index.length - 1; position >= 0; position -= 1) {
        const receipt = await readGuestTransferReceipt(index[position], redditPlayerId);
        if (!receipt) continue;
        const completedAtMs = Date.parse(receipt.completedAt);
        if (Number.isFinite(completedAtMs) && completedAtMs < oldestNewsAt) return null;
        return pendingSelectionPayload({
            guestPlayerId: receipt.guestPlayerId,
            redditPlayerId,
            choice: receipt.choice,
            state: 'completed',
            completedAt: receipt.completedAt,
        });
    }
    return null;
}

export type GuestTransferDiagnostic = {
    found: boolean;
    reason: string;
    accountId: string | null;
    guestId: string | null;
    transferId: string | null;
    pendingGuestMarker: string | null;
    guestPendingMarker: boolean;
    promotedTo: string | null;
    recordParseable: boolean;
    record: GuestProgressSelectionRecord | null;
    receipt: GuestTransferReceipt | null;
    accountTransferIds: string[];
    completedDomains: string[];
    cleanedDomains: string[];
    survivingSource: GuestTransferSourceInventory | null;
    changedDomains: string[] | null;
    destinationEvidence: Record<string, unknown> | null;
    expiredDailyChallengeIds: string[];
    garageBaseline: Record<string, string> | null;
    garageJournalFields: string[];
    evidenceFingerprint: string | null;
};

export async function getGuestProgressTransferDiagnostic({
    redditPlayerId,
    transferId,
}: {
    redditPlayerId?: unknown;
    transferId?: unknown;
}): Promise<GuestTransferDiagnostic> {
    const empty: GuestTransferDiagnostic = {
        found: false,
        reason: 'invalid_account',
        accountId: null,
        guestId: null,
        transferId: null,
        pendingGuestMarker: null,
        guestPendingMarker: false,
        promotedTo: null,
        recordParseable: true,
        record: null,
        receipt: null,
        accountTransferIds: [],
        completedDomains: [],
        cleanedDomains: [],
        survivingSource: null,
        changedDomains: null,
        destinationEvidence: null,
        expiredDailyChallengeIds: [],
        garageBaseline: null,
        garageJournalFields: [],
        evidenceFingerprint: null,
    };
    const accountId = typeof redditPlayerId === 'string' && redditPlayerId.startsWith('reddit:')
        ? redditPlayerId
        : null;
    if (!accountId) return empty;

    const requestedTransferId = typeof transferId === 'string' && transferId ? transferId : null;
    const [pendingMarker, accountTransferIds] = await Promise.all([
        redis.get(guestProgressSelectionAccountPendingKey(accountId)),
        readAccountTransferIndex(accountId),
    ]);
    const pendingGuestMarker = typeof pendingMarker === 'string' && pendingMarker.startsWith('guest:')
        ? pendingMarker
        : null;
    const receipt = requestedTransferId
        ? await readGuestTransferReceipt(requestedTransferId, accountId)
        : null;
    const guestId = pendingGuestMarker ?? receipt?.guestPlayerId ?? null;
    if (!guestId) {
        return {
            ...empty,
            accountId,
            reason: accountTransferIds.length > 0 ? 'no_open_transfer' : 'no_transfer',
            accountTransferIds,
            transferId: requestedTransferId,
            receipt,
        };
    }

    const derivedTransferId = guestProgressSelectionTransferId(guestId, accountId);
    if (requestedTransferId && requestedTransferId !== derivedTransferId && !receipt) {
        return { ...empty, accountId, guestId, reason: 'transfer_id_mismatch', accountTransferIds };
    }

    const [raw, guestPendingMarker, promotedTo] = await Promise.all([
        redis.get(guestProgressSelectionKey(guestId, accountId)),
        redis.get(guestProgressSelectionPendingKey(guestId)),
        readGuestPromotionTarget(guestId),
    ]);
    let record: GuestProgressSelectionRecord | null = null;
    let recordParseable = true;
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as unknown;
            record = isRecordObject(parsed) ? parsed as GuestProgressSelectionRecord : null;
            recordParseable = record !== null;
        } catch {
            recordParseable = false;
        }
    }

    const specs = Array.isArray(record?.dailyChallengeSpecs)
        ? record.dailyChallengeSpecs
        : Array.isArray(record?.dailyChallengeIds)
            ? (await resolveGuestTransferDailyChallenges(record.dailyChallengeIds)
                .catch(() => [] as DailyGpChallenge[])).map(transferChallengeSpec)
            : [];
    let survivingSource: GuestTransferSourceInventory | null = null;
    let destinationEvidence: Record<string, unknown> | null = null;
    const expiredDailyChallengeIds: string[] = [];
    const [garageBaseline, garageJournalFields] = await Promise.all([
        readGuestTransferGarageBaseline(accountId),
        readGuestTransferGarageJournalFields(accountId),
    ]);
    try {
        survivingSource = await captureGuestTransferSourceInventory(guestId, specs);
        destinationEvidence = {
            campaignProgress: stableFingerprint(await redis.get(campaignProgressKey(accountId)) ?? null),
            campaignStages: await captureCampaignStageEvidence(accountId),
            daily: await captureDailyEvidence(accountId, specs),
            unlocks: stableFingerprint(await redis.hGetAll(carUnlockHashKey(accountId)) ?? null),
        };
        for (const spec of specs) {
            const competition = toDailyCompetition(transferChallengeFromSpec(spec));
            const exists = await redis.hGet(competition.entryHashKey, guestId);
            if (exists === undefined || exists === null) expiredDailyChallengeIds.push(spec.id);
        }
    } catch (error) {
        console.error('Guest transfer diagnostic evidence read failed:', error);
    }

    const changedDomains = record && isValidSourceInventory(record.sourceInventory) && survivingSource
        ? changedInventoryDomains(record.sourceInventory, survivingSource)
        : null;
    const reason = !recordParseable
        ? 'record_unreadable'
        : !record
            ? 'record_missing'
            : record.status === 'completed'
                ? 'completed'
                : changedDomains && changedDomains.length > 0
                    ? `source_changed:${changedDomains.join(',')}`
                    : record.version !== 4 && record.choice === 'guest'
                        ? 'legacy_guest_choice_without_inventory'
                        : 'resumable';

    return {
        found: true,
        reason,
        accountId,
        guestId,
        transferId: derivedTransferId,
        pendingGuestMarker,
        guestPendingMarker: Boolean(guestPendingMarker),
        promotedTo: promotedTo ?? null,
        recordParseable,
        record,
        receipt: receipt ?? await readGuestTransferReceipt(derivedTransferId, accountId),
        accountTransferIds,
        completedDomains: Array.isArray(record?.completedDomains) ? record.completedDomains : [],
        cleanedDomains: Array.isArray(record?.cleanedDomains) ? record.cleanedDomains : [],
        survivingSource,
        changedDomains,
        destinationEvidence,
        expiredDailyChallengeIds,
        garageBaseline,
        garageJournalFields,
        evidenceFingerprint: stableFingerprint({
            record,
            survivingSource,
            destinationEvidence,
            promotedTo: promotedTo ?? null,
            pendingGuestMarker,
        }),
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
        const leaveSelectionPending = async (
            choice?: 'guest' | 'account',
            state: 'resume_required' | 'recovery_required' = 'resume_required',
        ): Promise<GuestProgressSelection> => {
            await redis.set(guestProgressSelectionPendingKey(guestPlayerId), '1');
            await redis.set(
                guestProgressSelectionAccountPendingKey(redditPlayerId),
                guestPlayerId,
                { nx: true },
            );
            return pendingSelectionPayload({ guestPlayerId, redditPlayerId, choice, state });
        };
        try {
            const record = JSON.parse(existing) as unknown;
            if (!isRecordObject(record)) throw new Error('Guest progress selection record is invalid.');
            if (record.status === 'completed') {
                if (!isValidCompletedSelectionRecord(record, guestPlayerId, redditPlayerId)) {
                    throw new Error('Guest progress selection record is invalid.');
                }
                await redis.del(guestProgressSelectionPendingKey(guestPlayerId));
                return {
                    required: false,
                    state: 'completed',
                    transferId: guestProgressSelectionTransferId(guestPlayerId, redditPlayerId),
                    sourceGuestPlayerId: guestPlayerId,
                    guestHasProgress: false,
                    accountHasProgress: true,
                    guestSummary: unavailableProgressSummary(),
                    accountSummary: unavailableProgressSummary(),
                    choice: record.choice,
                };
            }
            if (record.status === 'pending') {
                if (!isValidPendingSelectionRecord(record, guestPlayerId, redditPlayerId)) {
                    throw new Error('Guest progress selection record is invalid.');
                }
                return leaveSelectionPending(record.choice, resumableRecordState(record));
            }
            if (isValidRecoverySelectionRecord(record, guestPlayerId, redditPlayerId)) {
                return leaveSelectionPending(record.choice, 'recovery_required');
            }
            throw new Error('Guest progress selection record is invalid.');
        } catch {
            return leaveSelectionPending(undefined, 'recovery_required');
        }
    }
    const dailyPlaylist = await getServerDailyGpPlaylist();
    const [guestEvidence, accountEvidence] = await Promise.all([
        readProgressEvidence(guestPlayerId, dailyPlaylist),
        readProgressEvidence(redditPlayerId, dailyPlaylist),
    ]);
    const guestHasProgress = guestEvidence.hasProgress || guestEvidence.dailySavedResults > 0;
    const guestSummary = {
        ...toProgressSummary(guestEvidence),
        hasDailyResults: guestEvidence.hasDailyResults || (guestHasProgress && !guestEvidence.hasProgress),
    };
    const accountHasProgress = accountEvidence.hasProgress || accountEvidence.dailySavedResults > 0;
    const accountSummary = {
        ...toProgressSummary(accountEvidence),
        hasDailyResults: accountEvidence.hasDailyResults || (accountHasProgress && !accountEvidence.hasProgress),
    };
    if (guestHasProgress) {
        await redis.set(guestProgressSelectionPendingKey(guestPlayerId), '1');
    }
    return {
        required: guestHasProgress,
        state: guestHasProgress ? 'choice_required' : undefined,
        transferId: guestHasProgress
            ? guestProgressSelectionTransferId(guestPlayerId, redditPlayerId)
            : undefined,
        sourceGuestPlayerId: guestHasProgress ? guestPlayerId : undefined,
        guestHasProgress,
        accountHasProgress,
        guestSummary,
        accountSummary,
    };
}

export async function selectGuestProgress({
    guestPlayerId,
    redditPlayerId,
    choice,
    resume = false,
    transferId,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    choice: unknown;
    resume?: boolean;
    transferId?: unknown;
}): Promise<{
    status: 'completed';
    choice: 'guest' | 'account';
    transferId: string;
    sourceGuestPlayerId: string;
    completedAt: string;
}> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        throw new Error('Guest progress selection requires a guest and Reddit identity.');
    }
    if (choice !== 'guest' && choice !== 'account') {
        throw new Error('Guest progress selection is invalid.');
    }
    const key = guestProgressSelectionKey(guestPlayerId, redditPlayerId);
    const derivedTransferId = guestProgressSelectionTransferId(guestPlayerId, redditPlayerId);
    const pendingGuestKey = guestProgressSelectionPendingKey(guestPlayerId);
    const pendingAccountKey = guestProgressSelectionAccountPendingKey(redditPlayerId);
    let indexedTransferIds: string[] = [];
    const locks: RedisLock[] = [];
    const lockKeys = [
        guestProgressSelectionAccountLockKey(redditPlayerId),
        guestProgressSelectionLockKey(guestPlayerId, redditPlayerId),
    ].sort();
    try {
        for (const lockKey of lockKeys) {
            const lock = await acquireRedisLock(lockKey, 60_000, redis);
            if (!lock) {
                throw new GuestProgressSelectionRetryableError(
                    'Guest progress selection is already in progress.',
                );
            }
            locks.push(lock);
        }
    } catch (error) {
        await releaseSubmissionLocksSafely(locks, 'Guest progress selection');
        throw error;
    }
    let lease: RedisLockLease | null = null;
    const startedAtMs = Date.now();
    const domainMs: Record<string, number> = {};
    const timed = async <T>(domain: string, run: () => Promise<T>): Promise<T> => {
        const domainStartedAtMs = Date.now();
        try {
            return await run();
        } finally {
            domainMs[domain] = (domainMs[domain] ?? 0) + (Date.now() - domainStartedAtMs);
        }
    };
    let reportedPhase: GuestTransferPhase = 'preparing';
    let persistRecoveryPhase: (() => Promise<void>) | null = null;
    const reportTiming = (
        outcome: 'completed' | 'retryable' | 'recovery_required' | 'not_needed' | 'failed',
    ): void => {
        console.log('Guest progress transfer timing:', JSON.stringify({
            choice,
            resumed: resume,
            phase: reportedPhase,
            outcome,
            totalMs: Date.now() - startedAtMs,
            ...domainMs,
        }));
    };
    try {
        lease = startRedisLockGroupLeaseRenewal(locks, 20_000, redis);
        const stopLeaseForFence = async (): Promise<void> => {
            if (!lease) return;
            const activeLease = lease;
            lease = null;
            await activeLease.stop().catch((error) => {
                console.error('Guest progress selection lease pause failed:', error);
            });
        };
        const restartLease = (): void => {
            lease = startRedisLockGroupLeaseRenewal(locks, 20_000, redis);
        };
        const confirmSelectionOwnership = async (): Promise<void> => {
            if (!lease || !await lease.confirmOwnership()) {
                throw new GuestProgressSelectionRetryableError(
                    'Guest progress selection ownership was lost. Try again.',
                );
            }
        };
        const runTransferMutation: RedisLockTransactionRunner = async (
            domainLocks,
            mutate: RedisLockMutation,
        ): Promise<void> => {
            const fencedLocks = [...new Map(
                [...locks, ...domainLocks].map((lock) => [lock.key, lock]),
            ).values()];
            await stopLeaseForFence();
            if (!await renewRedisLockGroup(fencedLocks, redis)) {
                throw new GuestProgressSelectionRetryableError(
                    'Guest progress selection ownership was lost. Try again.',
                );
            }
            const transaction = await beginOwnedRedisLockGroupTransaction(fencedLocks, redis);
            if (!transaction) {
                throw new GuestProgressSelectionRetryableError(
                    'Guest progress selection ownership was lost. Try again.',
                );
            }
            let committed: boolean;
            try {
                await mutate(transaction);
                committed = await commitOwnedRedisLockTransaction(transaction);
            } catch (error) {
                try {
                    await transaction.discard();
                } catch (_discardError) {
                }
                throw error;
            }
            if (!committed) {
                throw new GuestProgressSelectionRetryableError(
                    'Guest progress selection was interrupted. Try again.',
                );
            }
            restartLease();
        };
        const saveRecord = async (
            next: GuestProgressSelectionRecord | null,
            {
                markPending = false,
                clearPending = false,
            }: { markPending?: boolean; clearPending?: boolean } = {},
        ): Promise<void> => {
            await runTransferMutation([], async (transaction) => {
                if (next) await transaction.set(key, JSON.stringify(next));
                if (next?.status === 'completed') {
                    const receipt: GuestTransferReceipt = {
                        version: 4,
                        transferId: derivedTransferId,
                        guestPlayerId,
                        redditPlayerId,
                        choice: next.choice,
                        completedAt: next.completedAt || next.updatedAt,
                    };
                    await transaction.set(
                        guestProgressTransferReceiptKey(derivedTransferId),
                        JSON.stringify(receipt),
                    );
                    if (!indexedTransferIds.includes(derivedTransferId)) {
                        await transaction.set(
                            guestProgressTransferIndexKey(redditPlayerId),
                            JSON.stringify(
                                [...indexedTransferIds, derivedTransferId]
                                    .slice(-ACCOUNT_TRANSFER_INDEX_LIMIT),
                            ),
                        );
                    }
                }
                if (markPending) {
                    await transaction.set(pendingGuestKey, '1');
                    await transaction.set(pendingAccountKey, guestPlayerId);
                }
                if (clearPending) {
                    await transaction.del(pendingGuestKey);
                    await transaction.del(pendingAccountKey);
                }
            });
        };
        const currentRaw = await redis.get(key);
        indexedTransferIds = await readAccountTransferIndex(redditPlayerId);
        const pendingGuestForAccount = await redis.get(
            pendingAccountKey,
        );
        if (
            typeof pendingGuestForAccount === 'string'
            && pendingGuestForAccount
            && pendingGuestForAccount !== guestPlayerId
        ) {
            const conflict = new Error('Another guest progress transfer is already pending for this account.');
            (conflict as Error & { statusCode?: number }).statusCode = 409;
            (conflict as Error & { reason?: string }).reason = 'progress_transfer_pending';
            throw conflict;
        }
        let currentRecord: GuestProgressSelectionRecord | null = null;
        if (resume && transferId !== derivedTransferId) {
            throw guestProgressRecoveryRequiredError();
        }
        let newTransferPlaylist: DailyGpChallenge[] | null = null;
        if (!currentRaw) {
            const joinedTo = await readGuestPromotionTarget(guestPlayerId);
            if (joinedTo) {
                throw joinedTo === redditPlayerId
                    ? guestProgressTransferNotNeededError()
                    : guestProgressRecoveryRequiredError();
            }
            newTransferPlaylist = await getServerDailyGpPlaylist();
            if (!await guestHoldsTransferableProgress(guestPlayerId, newTransferPlaylist)) {
                throw guestProgressTransferNotNeededError();
            }
        }
        if (currentRaw) {
            let parsedRecord: unknown;
            try {
                parsedRecord = JSON.parse(currentRaw) as unknown;
            } catch {
                throw guestProgressRecoveryRequiredError();
            }
            if (!isRecordObject(parsedRecord)) {
                throw guestProgressRecoveryRequiredError();
            }
            if (parsedRecord.choice !== 'guest' && parsedRecord.choice !== 'account') {
                throw guestProgressRecoveryRequiredError();
            }
            if (parsedRecord.choice !== choice) {
                const conflict = new Error('A different guest progress choice was already made.');
                (conflict as Error & { statusCode?: number }).statusCode = 409;
                throw conflict;
            }
            if (parsedRecord.status === 'completed') {
                if (!isValidCompletedSelectionRecord(parsedRecord, guestPlayerId, redditPlayerId)) {
                    throw guestProgressRecoveryRequiredError();
                }
                const completedAt = parsedRecord.completedAt || parsedRecord.updatedAt || new Date().toISOString();
                reportedPhase = 'completed';
                await saveRecord(
                    { ...parsedRecord, completedAt },
                    { clearPending: true },
                );
                reportTiming('completed');
                return {
                    status: 'completed',
                    choice,
                    transferId: derivedTransferId,
                    sourceGuestPlayerId: guestPlayerId,
                    completedAt,
                };
            }
            if (!isValidPendingSelectionRecord(parsedRecord, guestPlayerId, redditPlayerId)) {
                throw guestProgressRecoveryRequiredError();
            }
            if (resumableRecordState(parsedRecord) === 'recovery_required') {
                throw guestProgressRecoveryRequiredError();
            }
            currentRecord = parsedRecord;
        }
        const frozenChallenges = currentRecord?.dailyChallengeSpecs
            ? currentRecord.dailyChallengeSpecs.map(transferChallengeFromSpec)
            : currentRecord?.dailyChallengeIds
                ? await resolveGuestTransferDailyChallenges(currentRecord.dailyChallengeIds)
                : newTransferPlaylist ?? await getServerDailyGpPlaylist();
        const dailyChallengeIds = currentRecord?.dailyChallengeIds
            ?? frozenChallenges.map((challenge) => challenge.id);
        const dailyChallengeSpecs = currentRecord?.dailyChallengeSpecs
            ?? frozenChallenges.map(transferChallengeSpec);
        if (dailyChallengeSpecs.length !== dailyChallengeIds.length) {
            throw guestProgressRecoveryRequiredError();
        }
        const inheritedPhase: GuestTransferPhase = currentRecord?.version === 4
            && isValidTransferPhase(currentRecord.phase)
            ? currentRecord.phase
            : currentRecord
                ? 'copying'
                : 'preparing';
        const preparing = inheritedPhase === 'preparing';
        const replacementRemaining = choice === 'guest'
            && !TRANSFER_COMPLETION_DOMAINS.every(
                (domain) => currentRecord?.completedDomains?.includes(domain),
            );
        const sourceInventory = !replacementRemaining
            ? currentRecord?.sourceInventory
            : preparing || !isValidSourceInventory(currentRecord?.sourceInventory)
                ? await captureGuestTransferSourceInventory(guestPlayerId, dailyChallengeSpecs)
                : currentRecord.sourceInventory;
        if (replacementRemaining && !isValidSourceInventory(sourceInventory)) {
            throw guestProgressRecoveryRequiredError();
        }
        const record: GuestProgressSelectionRecord = {
            version: 4,
            transferId: derivedTransferId,
            guestPlayerId,
            redditPlayerId,
            choice,
            status: 'pending',
            phase: preparing ? 'preparing' : inheritedPhase,
            updatedAt: new Date().toISOString(),
            completedDomains: currentRecord?.completedDomains ?? [],
            cleanedDomains: currentRecord?.cleanedDomains ?? [],
            dailyChallengeIds,
            dailyChallengeSpecs,
            ...(sourceInventory ? { sourceInventory } : {}),
        };
        persistRecoveryPhase = async (): Promise<void> => {
            await saveRecord(
                {
                    ...record,
                    status: 'recovery_required',
                    phase: 'recovery_required',
                    updatedAt: new Date().toISOString(),
                },
                { markPending: true },
            );
        };
        if (!record.completedDomains.includes('daily')) {
            await resolveGuestTransferDailyChallenges(record.dailyChallengeIds);
        }
        if (record.phase === 'preparing') {
            if (choice === 'guest') {
                await captureGuestTransferGarageBaseline(redditPlayerId, derivedTransferId);
                await clearOwedRewards(redditPlayerId);
                await clearOwedRewards(guestPlayerId);
            }
            reportedPhase = 'preparing';
            await saveRecord(record, { markPending: true });
        }
        if (record.phase !== 'cleaning') record.phase = 'copying';
        record.updatedAt = new Date().toISOString();
        reportedPhase = record.phase;
        type ObservedSource = {
            unlocks?: Record<string, string>;
            campaignProgress?: string | null;
            campaignStages?: Record<
                string,
                { entry: string | null; pb: string | null; rank: number | null }
            >;
            dailyDay?: {
                challengeId: string;
                entry: string | null;
                pb: string | null;
                rank: number | null;
            };
        };
        const verifySourceDomain = (domain: 'campaign' | 'daily' | 'unlocks') => (
            async (raw?: ObservedSource): Promise<void> => {
                if (!record.sourceInventory) return;
                let evidence: Partial<GuestTransferSourceInventory>;
                if (raw?.dailyDay) {
                    const expectedRow = record.sourceInventory.daily[raw.dailyDay.challengeId];
                    if (expectedRow !== undefined && stableFingerprint({
                        entry: raw.dailyDay.entry ?? null,
                        pb: raw.dailyDay.pb ?? null,
                        rank: raw.dailyDay.rank ?? null,
                    }) !== expectedRow) {
                        throw guestProgressRecoveryRequiredError();
                    }
                    return;
                }
                if (raw?.unlocks) {
                    evidence = {
                        unlocks: stableFingerprint(raw.unlocks ?? null),
                        unlockFields: { ...(raw.unlocks ?? {}) },
                    };
                } else if (raw?.campaignStages) {
                    evidence = {
                        campaignProgress: stableFingerprint(raw.campaignProgress ?? null),
                        campaignStages: Object.fromEntries(
                            Object.entries(raw.campaignStages).map(([raceId, row]) => [
                                raceId,
                                stableFingerprint({
                                    entry: row.entry ?? null,
                                    pb: row.pb ?? null,
                                    rank: row.rank ?? null,
                                }),
                            ]),
                        ),
                    };
                } else if (domain === 'campaign') {
                    evidence = {
                        campaignProgress: stableFingerprint(
                            await redis.get(campaignProgressKey(guestPlayerId)) ?? null,
                        ),
                        campaignStages: await captureCampaignStageEvidence(guestPlayerId),
                    };
                } else if (domain === 'daily') {
                    evidence = {
                        daily: await captureDailyEvidence(
                            guestPlayerId,
                            record.dailyChallengeSpecs ?? [],
                        ),
                    };
                } else {
                    const current = await redis.hGetAll(carUnlockHashKey(guestPlayerId));
                    evidence = {
                        unlocks: stableFingerprint(current ?? null),
                        unlockFields: { ...(current ?? {}) },
                    };
                }
                if (changedInventoryDomains(record.sourceInventory, evidence).includes(domain)) {
                    throw guestProgressRecoveryRequiredError();
                }
            }
        );
        await saveRecord(record, { markPending: true });
        if (choice === 'guest') {
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('campaign')) {
                await timed('campaignMs', () => mergeGuestCampaignProgress({
                    guestPlayerId,
                    redditPlayerId,
                    replace: true,
                    verifyGuestSource: verifySourceDomain('campaign'),
                    transactionRunner: runTransferMutation,
                }));
                record.completedDomains = [...record.completedDomains, 'campaign'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('daily')) {
                await timed('dailyMs', () => mergeGuestDailyProgress({
                    guestPlayerId,
                    redditPlayerId,
                    replace: true,
                    challengeIds: record.dailyChallengeIds,
                    challengeSpecs: record.dailyChallengeSpecs,
                    verifyGuestSource: verifySourceDomain('daily'),
                    recordedDailyChallengeIds: recordedDailyDays(record.sourceInventory),
                    transactionRunner: runTransferMutation,
                }));
                record.completedDomains = [...record.completedDomains, 'daily'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('unlocks')) {
                await timed('unlocksMs', () => mergeGuestCarUnlockProgress({
                    guestPlayerId,
                    redditPlayerId,
                    replace: true,
                    preserveSource: true,
                    verifyGuestSource: verifySourceDomain('unlocks'),
                    transactionRunner: runTransferMutation,
                }));
                record.completedDomains = [...record.completedDomains, 'unlocks'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (record.phase !== 'cleaning') {
                record.phase = 'cleaning';
                reportedPhase = 'cleaning';
                await saveRecord(record);
            }
            if (!record.cleanedDomains?.includes('campaign')) {
                await timed('campaignCleanupMs', () => cleanupGuestCampaignProgress({ guestPlayerId }));
                record.cleanedDomains = [...(record.cleanedDomains || []), 'campaign'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.cleanedDomains?.includes('daily')) {
                await timed('dailyCleanupMs', () => cleanupGuestDailyProgress({
                    guestPlayerId,
                    challengeIds: record.dailyChallengeIds,
                    challengeSpecs: record.dailyChallengeSpecs,
                }));
                record.cleanedDomains = [...(record.cleanedDomains || []), 'daily'];
                await saveRecord(record);
            }
        } else {
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('campaign')) {
                await timed('campaignMs', () => discardGuestCampaignProgress({ guestPlayerId }));
                record.completedDomains = [...record.completedDomains, 'campaign'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('daily')) {
                await timed('dailyMs', () => discardGuestDailyProgress({
                    guestPlayerId,
                    challengeIds: record.dailyChallengeIds,
                    challengeSpecs: record.dailyChallengeSpecs,
                }));
                record.completedDomains = [...record.completedDomains, 'daily'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('unlocks')) {
                await timed('unlocksMs', () => discardGuestCarUnlockProgress({ guestPlayerId, redditPlayerId }));
                record.completedDomains = [...record.completedDomains, 'unlocks'];
                await saveRecord(record);
            }
        }
        const completedAt = new Date().toISOString();
        if (choice === 'guest') {
            await timed('unlockCleanupMs', () => cleanupGuestCarUnlockProgress({
                guestPlayerId,
                redditPlayerId,
            }));
        }
        reportedPhase = 'completed';
        await saveRecord(
            {
                ...record,
                status: 'completed',
                phase: 'completed',
                completedAt,
                updatedAt: completedAt,
            },
            { clearPending: true },
        );
        reportTiming('completed');
        return {
            status: 'completed',
            choice,
            transferId: derivedTransferId,
            sourceGuestPlayerId: guestPlayerId,
            completedAt,
        };
    } catch (error) {
        const reason = (error as { reason?: string })?.reason;
        const outcome = reason === 'guest_progress_recovery_required'
            ? 'recovery_required'
            : reason === GUEST_PROGRESS_TRANSFER_NOT_NEEDED_REASON
                ? 'not_needed'
                : error instanceof GuestProgressSelectionRetryableError
                    ? 'retryable'
                    : 'failed';
        reportTiming(outcome);
        if (outcome === 'recovery_required' && persistRecoveryPhase) {
            try {
                await persistRecoveryPhase();
            } catch (persistError) {
                console.error('Guest progress recovery phase write failed:', persistError);
            }
        }
        if (outcome === 'failed') {
            console.error('Guest progress selection failed:', error);
        }
        throw error;
    } finally {
        if (lease) {
            await lease.stop().catch((error) => {
                console.error('Guest progress selection lease cleanup failed:', error);
            });
        }
        await releaseRedisLockGroup(locks, 'Guest progress selection', redis);
    }
}

export async function selectServerGuestProgress({
    playerId,
    redditUsername,
    guestToken,
    choice,
    action,
    transferId,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    choice?: unknown;
    action?: unknown;
    transferId?: unknown;
}): Promise<PlayerBootstrapPayload> {
    const safeUsername = sanitizeRedditUsername(redditUsername);
    if (action === 'resume' || action === 'status') {
        if (!safeUsername || typeof transferId !== 'string' || !transferId) {
            throw guestProgressRecoveryRequiredError();
        }
        const redditPlayerId = `reddit:${safeUsername.toLowerCase()}`;
        const known = await resolveAccountTransferState(redditPlayerId, { transferId });
        if (known?.state === 'completed' && known.transferId === transferId) {
            const state = await getServerPlayerBootstrap({ redditUsername: safeUsername });
            return { ...state, progressSelection: known };
        }
        if (action === 'status') {
            const state = await getServerPlayerBootstrap({ redditUsername: safeUsername });
            return known ? { ...state, progressSelection: known } : state;
        }
        if (!known
            || known.state !== 'resume_required'
            || !known.sourceGuestPlayerId
            || transferId !== known.transferId) {
            throw guestProgressRecoveryRequiredError();
        }
        const result = await selectGuestProgress({
            guestPlayerId: known.sourceGuestPlayerId,
            redditPlayerId,
            choice: known.choice,
            resume: true,
            transferId,
        });
        const state = await getServerPlayerBootstrap({ redditUsername: safeUsername });
        return {
            ...state,
            progressSelection: pendingSelectionPayload({
                guestPlayerId: result.sourceGuestPlayerId,
                redditPlayerId,
                choice: result.choice,
                state: 'completed',
                completedAt: result.completedAt,
            }),
        };
    }
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
    let guestJoinedAccount = false;

    const bareGuestId = !identity.canonicalPlayerId
        && !safeRequestRedditUsername
        && typeof playerId === 'string'
        && playerId.trim()
        ? `guest:${playerId.trim()}`
        : null;
    const bareGuestStatus = bareGuestId
        ? await resolveGuestIdentityStatus(bareGuestId)
        : null;
    const retiredGuestId = bareGuestStatus?.status === 'guest_identity_retired';
    retireGuestIdentity ||= retiredGuestId;

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
                guestSelectionPending: bareGuestStatus?.selectionPending,
            };
            profile = claimedGuest.profile;
        } else {
            const adoptedGuest = await adoptExistingGuestPlayerProfile({ playerId });
            if (adoptedGuest) {
                identity = {
                    canonicalPlayerId: adoptedGuest.canonicalPlayerId,
                    guestPlayerId: adoptedGuest.guestPlayerId,
                    guestToken: adoptedGuest.guestToken,
                    guestSelectionPending: bareGuestStatus?.selectionPending,
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
            carUnlocks: null,
            retireGuestIdentity,
        };
    }

    if (!profile) {
        previousProfile ??= await readPlayerProfile(identity.canonicalPlayerId);
    }

    let accountTransfer: GuestProgressSelection | null = null;
    if (identity.canonicalPlayerId.startsWith('reddit:')) {
        accountTransfer = await resolveAccountTransferState(identity.canonicalPlayerId);
        const transferBlocksSignIn = accountTransfer?.state === 'resume_required'
            || accountTransfer?.state === 'recovery_required';
        if (transferBlocksSignIn) {
            return {
                playerId: identity.canonicalPlayerId,
                guestToken: typeof guestToken === 'string' ? guestToken.trim() : null,
                redditUsername: safeRequestRedditUsername,
                leaderboardIdentity: 'reddit',
                playerPreferences: null,
                hasAnyData: false,
                isReturningPlayer: false,
                firstSeenAt: null,
                carUnlocks: null,
                retireGuestIdentity: false,
                progressSelection: accountTransfer,
            };
        }
        if (accountTransfer?.state === 'completed') {
            progressSelection = accountTransfer;
        }
        const guestPlayerId = await verifyGuestPlayerToken(guestToken);
        if (guestPlayerId) {
            const promotedTo = await readGuestPromotionTarget(`guest:${guestPlayerId}`);
            if (promotedTo) {
                retireGuestIdentity = true;
                guestJoinedAccount = promotedTo === identity.canonicalPlayerId
                    && !await redis.get(guestProgressSelectionKey(
                        `guest:${guestPlayerId}`,
                        identity.canonicalPlayerId,
                    ));
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
                        guestJoinedAccount = await readGuestPromotionTarget(`guest:${guestPlayerId}`)
                            === identity.canonicalPlayerId;
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
                        carUnlocks: null,
                        retireGuestIdentity: false,
                        progressSelection,
                    };
                }
            }
        }
    }

    if (!profile) {
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
    const backfillBlockedByTransfer = identity.canonicalPlayerId.startsWith('reddit:')
        ? Boolean(accountTransfer) && accountTransfer.state !== 'completed'
        : identity.guestSelectionPending ?? await isGuestProgressSelectionPending(
            identity.canonicalPlayerId,
        );
    const carUnlocks = await readPlayerCarUnlocks(
        identity.canonicalPlayerId,
        profile.hasAnyData,
    );
    if (!backfillBlockedByTransfer) {
        try {
            if (
                carUnlocks?.progress?.completedRace
                && !await hasRecordedCompletedRace(identity.canonicalPlayerId)
            ) {
                await recordCompletedRace(identity.canonicalPlayerId);
            }
        } catch (error) {
            console.error('Completed-race unlock backfill failed:', error);
        }
        await settleOwedRewards(identity.canonicalPlayerId);
    }
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
        carUnlocks,
        retireGuestIdentity,
        ...(guestJoinedAccount ? { guestJoinedAccount } : {}),
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

function playableLoadedChallenge(
    loaded: DailyGpChallenge | null | undefined,
    requestedId: string | null,
): DailyGpChallenge | null {
    if (!loaded || !requestedId || loaded.id !== requestedId) return null;
    return isDailyGpChallengePlayable(loaded) ? loaded : null;
}

export async function getServerDailyGpSnapshot({
    challengeId,
    loadedChallenge,
    playerId,
    leaderboardIdentity,
    redditUsername,
    guestToken,
    limit = DAILY_GP_DEFAULT_LIMIT,
    offset = 0,
}: {
    challengeId?: string | null;
    loadedChallenge?: DailyGpChallenge | null;
    playerId?: string | null;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    limit?: unknown;
    offset?: unknown;
} = {}): Promise<SnapshotPayload> {
    const requestedId = typeof challengeId === 'string' && challengeId ? challengeId : null;
    const loaded = playableLoadedChallenge(loadedChallenge, requestedId);
    let challenge: DailyGpChallenge | null = loaded;
    if (!challenge && requestedId === getTodayChallengeId()) {
        const activeChallenge = await getServerDailyGpChallenge();
        if (!isDailyGpChallengePlayable(activeChallenge)) {
            return createEmptyDailySnapshot(activeChallenge);
        }
        challenge = activeChallenge;
    } else if (!challenge && requestedId) {
        challenge = await getServerDailyGpPlayableChallenge(requestedId);
    } else if (!challenge) {
        challenge = await getServerDailyGpChallenge();
    }
    if (!challenge) {
        return createEmptyDailySnapshot(await getServerDailyGpChallenge());
    }

    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    const normalizedPlayerId = identity.canonicalPlayerId;
    if (normalizedPlayerId) {
        const loadedProfile = await ensurePlayerProfileExists({
            playerId: normalizedPlayerId,
            leaderboardIdentity,
            redditUsername,
        });
        return readSnapshot({
            competition: toDailyCompetition(challenge),
            playerId: normalizedPlayerId,
            limit: normalizeLimit(limit),
            offset: normalizeOffset(offset),
            loadedProfile,
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
    const progressTransferPending = identity.guestStatus === 'guest_promotion_pending'
        || (identity.canonicalPlayerId.startsWith('reddit:')
            && await isPlayerProgressSelectionPending(identity.canonicalPlayerId));
    if (progressTransferPending) {
        return {
            status: 503,
            body: {
                accepted: false,
                error: 'A progress transfer is in progress. Retrying automatically.',
                reason: 'progress_transfer_pending',
                retryAfterSeconds: 1,
            },
        };
    }

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
    const [standing, carUnlocks, reward, profile] = await Promise.allSettled([
        readPlayerStandingSummary(competition, normalizedPlayerId),
        readPlayerCarUnlocks(normalizedPlayerId, true),
        recordCompletedRace(normalizedPlayerId),
        upsertPlayerProfile({
            playerId: normalizedPlayerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: true,
        }),
    ]);
    await outcome.releaseLock;
    if (reward.status === 'rejected' && profile.status === 'rejected') {
        console.error('Daily run saved, but its profile write also failed:', profile.reason);
        throw reward.reason;
    }
    if (standing.status === 'rejected') {
        console.error('Daily run saved, but its rank could not be read:', standing.reason);
    }
    if (carUnlocks.status === 'rejected') {
        console.error('Daily run saved, but its Garage could not be read:', carUnlocks.reason);
    }
    if (reward.status === 'rejected') {
        console.error('Daily run saved, but its completed-race reward failed:', reward.reason);
    }
    if (profile.status === 'rejected') {
        console.error('Daily run saved, but its profile write failed:', profile.reason);
    }
    recordAnalyticsRaceBestEffort('daily', 'finish', normalizedPlayerId);
    return {
        status: 200,
        body: {
            ...(outcome.body as Record<string, unknown>),
            playerRank: standing.status === 'fulfilled' ? standing.value.playerRank : null,
            playerRankLabel: standing.status === 'fulfilled' ? standing.value.playerRankLabel : null,
            leaderboardEntryCount: standing.status === 'fulfilled' ? standing.value.leaderboardEntryCount : null,
            ...(carUnlocks.status === 'fulfilled' && reward.status === 'fulfilled'
                ? { carUnlocks: carUnlocks.value }
                : {}),
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
