import { redis } from '@devvit/redis';
import { redisCompressed } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    DEFAULT_TRACK_KEY,
    getTrackName,
    hasTrack,
} from '../../../game/track/catalog.js';
import { readDailySchedulePool } from './daily-schedule-store.js';
import { assertTrackKey, queueStoredTrackRecord, freezeStoredTrack, matchesStoredTrack, readStoredTracksRevision } from '../tracks/track-store.js';
import { confirmStoredTracks, loadStoredTracks, reloadPinnedCatalog } from '../tracks/stored-catalog.js';
import { readCompleteTrack } from '../tracks/track-readiness.js';
import { withTrackPlacementLock, commitTrackPlacement, TrackPlacementRetryError } from '../tracks/track-placement-lock.js';
import { TRACKS } from '../../../game/track/tracks.js';
import { getTrackGround } from '../../../game/track/grounds.js';
import { isLiveGround } from '../../../game/track/live-grounds.js';
import { formatRaceTime } from '../shared/format-race-time.js';
import {
    resolveLeaderboardDisplayName,
    sanitizeRedditUsername,
} from '../../../game/shared/leaderboard-identity.js';
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
    getUtcDayStart,
    getDailyGpCompetitionTtlSeconds,
    isDailyGpChallengePlayable,
    normalizeDailyGpRaceContract,
    type DailyGpChallenge,
} from './daily-gp-model.js';
import { getBackfilledDailyGpChallenge } from './daily-gp-history-backfill.js';
import type { FinalDailyGpPodium } from '../podium/daily-podium-model.js';
import type { DailyPodiumReplayGhostSlot } from '../podium/daily-podium-replay.js';
import { createTrackFingerprint } from '../competition/pb-ghost-trace.js';
import { toCampaignCompetition, toDailyCompetition } from '../competition/competition.js';
import { prepareCompetitionOpponentRace } from '../competition/competition-opponent-race.js';
import {
    createEmptySnapshot,
    parseStoredEntry,
    competitionHoldsPlayerRows,
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
    type SnapshotPayload,
} from '../competition/competition-leaderboard.js';
import {
    readPlayerProfile,
    readPlayerProfileMap,
    resolveAuthorizedPlayerIdentity,
    upsertPlayerProfile,
    ensurePlayerProfileExists,
} from '../competition/competition-identity.js';
import {
    challengeCollectionKey,
    classifyStoredPbRecordFor,
    getPlayerTrackPbRecord,
} from '../competition/pb-ghost-store.js';
import { classifyStoredLeaderboardEntry } from '../guest-transfer/guest-transfer-source-classification.js';
import { encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';
import { boardMergeWrite, decideBoardMerge } from '../guest-transfer/board-merge.js';
import {
    acquireRedisLock,
    createOwnedLockGroupRunner,
    releaseRedisLockGroup,
    startRedisLockGroupLeaseRenewal,
    type RedisLock,
    type RedisLockLease,
    type RedisLockMutation,
    type RedisLockTransactionRunner,
} from '../redis/redis-lock.js';
import {
    GuestProgressRecoveryRequiredError,
    GuestProgressSelectionContinueError,
    GuestProgressSelectionRetryableError,
} from '../guest-transfer/guest-progress-selection-error.js';
import {
    getCarUnlockSnapshot,
    discardGuestCarUnlockProgress,
    isValidCarUnlockEventField,
    cleanupGuestCarUnlockProgress,
    hasCarUnlockProgress,
    mergeGuestCarUnlockProgress,
    readGuestPromotionTarget,
    carUnlockHashKey,
    recordCompletedRace,
    type CarUnlockSnapshot,
} from '../player/car-unlock-store.js';
import {
    campaignSubmissionLockKeys,
    cleanupGuestCampaignProgress,
    discardGuestCampaignProgress,
    getCampaignResultsForCarUnlocks,
    getCampaignProgressForSelection,
    mergeGuestCampaignProgress,
} from '../campaign/campaign-store.js';
import { campaignProgressKey, campaignProgressKeys } from '../campaign/campaign-progress-key.js';
import {
    CAMPAIGN_LIVE_STAGES,
    CAMPAIGN_NUMBERS_SERIES_ID,
    CAMPAIGN_SERIES,
    getCampaignUnlockedRaceIds,
} from '../../../game/campaign/manifest.js';
import { PLAYER_SELECTABLE_CAR_ASSETS } from '../../../game/car/car-unlock-policy.js';
import {
    guestProgressSelectionAccountPendingKey,
    guestProgressTransferReceiptKey,
    guestProgressTransferIndexKey,
    guestProgressSelectionPendingKey,
    isPlayerProgressSelectionPending,
} from '../player/guest-retirement.js';
import {
    competitionSubmissionLockKey,
    isMismatchedSubmissionOwner,
    submitCompetitionRun,
    SUBMISSION_IDENTITY_CHANGED_RESULT,
    type RankedSubmitReuseOptions,
} from '../competition/competition-submit.js';
import { playerFieldHash } from '../redis/redis-names.js';
import { carryGuestSettings } from '../player/transfer-settings.js';
import { cleanupExpiredDailyGuestsBestEffort } from './daily-guest-cleanup.js';
import { dailyBoardKeys, readTransferBoards } from '../player/raced-list-fill.js';
import { progressTransferPendingReply } from '../guest-transfer/progress-transfer-reply.js';

import { recordAnalyticsRace, recordAnalyticsRaceBestEffort } from '../moderator/analytics-store.js';

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
    choice?: GuestTransferChoice;
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
        campaignTotalStages: CAMPAIGN_LIVE_STAGES.length,
        dailySavedResults: null,
        dailyPlaylistSize: null,
        carsUnlocked: null,
        carsTotal: PLAYER_SELECTABLE_CAR_ASSETS.length,
        unlocks,
    };
}

type GuestTransferPhase = 'preparing' | 'copying' | 'cleaning' | 'completed' | 'recovery_required';

type GuestProgressSelectionRecord = {
    version?: 2 | 3 | 4;
    transferId?: string;
    guestPlayerId: string;
    redditPlayerId: string;
    choice: GuestTransferChoice;
    status: 'pending' | 'completed' | 'recovery_required';
    phase?: GuestTransferPhase;
    updatedAt: string;
    completedDomains: string[];
    cleanedDomains?: string[];
    dailyChallengeIds?: string[];
    dailyChallengeSpecs?: GuestTransferDailyChallengeSpec[];
    // Frozen days the current Daily step finished; absent between steps.
    dailyStepDone?: number;
    sourceInventory?: GuestTransferSourceInventory;
    completedAt?: string;
};

// Keep account drops guest progress; Merge keeps the faster time; 'guest' (retired Keep guest) runs as Merge.
export type GuestTransferChoice = 'guest' | 'account' | 'merge';

function isGuestTransferChoice(value: unknown): value is GuestTransferChoice {
    return value === 'guest' || value === 'account' || value === 'merge';
}

// Keep guest deleted account results, so old requests and started transfers run as Merge instead.
function runnableTransferChoice(choice: GuestTransferChoice): 'account' | 'merge' {
    return choice === 'account' ? 'account' : 'merge';
}

// Keep guest and Merge copy the guest's progress, then clean it up.
function copiesGuestProgress(choice: GuestTransferChoice): boolean {
    return choice === 'guest' || choice === 'merge';
}

type GuestTransferReceipt = {
    version: 4;
    transferId: string;
    guestPlayerId: string;
    redditPlayerId: string;
    choice: GuestTransferChoice;
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
    // The Numbers progress record keeps its old name so older transfers still compare.
    campaignProgress: string;
    // The progress records of the other series. Older transfers have none.
    campaignSeriesProgress?: Record<string, string>;
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
    raceIds?: readonly string[] | null,
): Promise<Record<string, string>> {
    const playerField = playerFieldHash(guestPlayerId);
    const named = raceIds ? new Set(raceIds) : null;
    const stages = named
        ? CAMPAIGN_LIVE_STAGES.filter((stage) => named.has(stage.raceId))
        : CAMPAIGN_LIVE_STAGES;
    const rows = await Promise.all(stages.map(async (stage) => {
        const competition = toCampaignCompetition(stage.seriesId, stage);
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

async function captureCampaignSeriesProgressEvidence(
    playerId: string,
): Promise<Record<string, string>> {
    const series = CAMPAIGN_SERIES.filter((entry) => entry.id !== CAMPAIGN_NUMBERS_SERIES_ID);
    const values = await Promise.all(
        series.map((entry) => redis.get(campaignProgressKey(playerId, entry.id))),
    );
    return Object.fromEntries(series.map((entry, index) => [
        entry.id,
        stableFingerprint(values[index] ?? null),
    ]));
}

async function captureDailyEvidence(
    guestPlayerId: string,
    challengeSpecs: readonly GuestTransferDailyChallengeSpec[],
): Promise<Record<string, string>> {
    const field = playerFieldHash(guestPlayerId);
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
    campaignRaceIds?: readonly string[] | null,
): Promise<GuestTransferSourceInventory> {
    const [campaignProgress, campaignSeriesProgress, campaignStages, daily, unlocks] = await Promise.all([
        redis.get(campaignProgressKey(guestPlayerId)),
        captureCampaignSeriesProgressEvidence(guestPlayerId),
        captureCampaignStageEvidence(guestPlayerId, campaignRaceIds),
        captureDailyEvidence(guestPlayerId, challengeSpecs),
        redis.hGetAll(carUnlockHashKey(guestPlayerId)),
    ]);
    return {
        campaignProgress: stableFingerprint(campaignProgress ?? null),
        campaignSeriesProgress,
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
        || rowsChanged(expected.campaignSeriesProgress ?? {}, observed.campaignSeriesProgress)
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
        && (value.campaignSeriesProgress === undefined || isRecordObject(value.campaignSeriesProgress))
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
        && isGuestTransferChoice(value.choice)
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
        || !isGuestTransferChoice(value.choice)
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
        copiesGuestProgress(value.choice)
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
    if (value.dailyStepDone !== undefined && (
        !Number.isInteger(value.dailyStepDone)
        || Number(value.dailyStepDone) < 0
        || Number(value.dailyStepDone) > value.dailyChallengeIds.length
    )) {
        return false;
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
    if (!isGuestTransferChoice(value.choice)) return false;
    if (value.guestPlayerId !== guestPlayerId || value.redditPlayerId !== redditPlayerId) return false;
    if (value.version === 4
        && value.transferId !== guestProgressSelectionTransferId(guestPlayerId, redditPlayerId)) {
        return false;
    }
    return true;
}

export function guestProgressSelectionKey(guestPlayerId: string, redditPlayerId: string): string {
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

const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_CURSOR_KEY = 'dailygp:maintenance:challenge-history:v1:cursor';
const DAILY_GP_CHALLENGE_HISTORY_MAINTENANCE_BATCH_SIZE = 50;

export async function readPlayerCarUnlocks(
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

function createEmptyDailySnapshot(challenge: DailyGpChallenge): SnapshotPayload {
    return createEmptySnapshot(toDailyCompetition(challenge), DAILY_GP_DEFAULT_LIMIT);
}

function parseStoredChallengeContract(raw: string | null | undefined): DailyGpChallenge | null {
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

        const trackKey = assertTrackKey(parsed.trackKey);

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

export function parseStoredChallenge(raw: string | null | undefined): DailyGpChallenge | null {
    const challenge = parseStoredChallengeContract(raw);
    try {
        return challenge && hasTrack(challenge.trackKey) ? challenge : null;
    } catch (_error) {
        return null;
    }
}

// Transfers keep their pinned catalog; geometry readers keep keys published after the pin.
type DailyChallengeReadMode = 'pinned' | 'contract';

// Loads these Dailies' stored tracks in one read, before any layout, name or medal read.
async function loadChallengeTracks(challenges: readonly (DailyGpChallenge | null | undefined)[]): Promise<void> {
    await loadStoredTracks(challenges.map((challenge) => challenge?.trackKey));
}

async function readStoredDailyGpChallenge(
    challengeId: string,
    mode: DailyChallengeReadMode = 'pinned',
): Promise<DailyGpChallenge | null> {
    const raw = await redis.hGet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, challengeId);
    return mode === 'contract' ? parseStoredChallengeContract(raw) : parseStoredChallenge(raw);
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

const DAILY_COMMIT_ATTEMPTS = 5;
const DAILY_COMMIT_RETRY_MS = 150;

// One request creates a new Daily under the placement lock; others wait and return the committed Daily.
async function commitDailyChallenge(challenge: DailyGpChallenge, dayIndex?: number): Promise<DailyGpChallenge> {
    for (let attempt = 1; ; attempt += 1) {
        const stored = await readStoredDailyGpChallenge(challenge.id);
        if (stored) return stored;
        try {
            return await placeDailyChallenge(challenge, dayIndex);
        } catch (error) {
            if (!(error instanceof TrackPlacementRetryError) || attempt >= DAILY_COMMIT_ATTEMPTS) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, DAILY_COMMIT_RETRY_MS * attempt));
    }
}

// History and the track freeze commit together, so a failure leaves no orphan lock or editable challenge.
async function placeDailyChallenge(challenge: DailyGpChallenge, dayIndex?: number): Promise<DailyGpChallenge> {
    const result = await withTrackPlacementLock((lock) => commitTrackPlacement(
        [lock], [DAILY_GP_CHALLENGE_HISTORY_HASH_KEY], async () => {
            const raw = await redis.hGet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, challenge.id);
            const existing = parseStoredChallenge(raw);
            if (existing) return { result: existing };
            if (raw) throw new TrackPlacementRetryError('The Daily could not be confirmed. Retry before racing.');
            const trackKey = dayIndex === undefined ? challenge.trackKey
                : await pickNextTrackKeyForToday(getUtcDayStart(dayIndex));
            const complete = await readCompleteTrack(trackKey);
            if (dayIndex !== undefined && !isLiveGround(getTrackGround(complete.track).key)) {
                throw new TrackPlacementRetryError('The Daily track changed. Retry before racing.');
            }
            const committed = dayIndex === undefined ? challenge : buildDailyGpChallengeForDayIndexWithTrack(dayIndex, trackKey);
            const frozen = complete.stored && !complete.stored.lockedAt
                ? freezeStoredTrack(complete.stored, 'daily', new Date()) : null;
            const cacheRevision = frozen ? await readStoredTracksRevision() + 1 : null;
            return { result: committed, confirm: (results) => results[0] === 1,
                reconcile: async () => await redis.hGet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, committed.id) === JSON.stringify(committed)
                    && (!frozen || await matchesStoredTrack(frozen, cacheRevision)),
                mutate: async (transaction) => {
                    await transaction.hSetNX(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, committed.id, JSON.stringify(committed));
                    await transaction.expire(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS);
                    if (frozen) await queueStoredTrackRecord(transaction, frozen);
                } };
        },
    ));
    await stampDailyCompetitionExpiry(result);
    await maintainChallengeHistory();
    // Committed; if the catalog cannot load now, the retry finds the stored Daily.
    await reloadPinnedCatalog();
    await loadChallengeTracks([result]);
    return result;
}

async function writeStoredDailyGpChallenge(challenge: DailyGpChallenge): Promise<DailyGpChallenge> {
    return commitDailyChallenge(challenge);
}

async function readStoredOrBackfilledDailyGpChallenge(
    challengeId: string,
    mode: DailyChallengeReadMode = 'pinned',
): Promise<DailyGpChallenge | null> {
    const stored = await readStoredDailyGpChallenge(challengeId, mode);
    if (stored) {
        if (mode === 'pinned') await loadChallengeTracks([stored]);
        return stored;
    }

    const backfilled = getBackfilledDailyGpChallenge(challengeId);
    if (!backfilled) {
        return null;
    }

    const written = await writeStoredDailyGpChallenge(backfilled);
    if (mode === 'pinned') await loadChallengeTracks([written]);
    return written;
}

// Every stored Daily, oldest first. The history keeps each day for 50 years.
export async function readDailyChallengeHistory(): Promise<DailyGpChallenge[]> {
    return (await readStoredChallengeEntries())
        .filter((entry) => Number.isFinite(Date.parse(entry.startsAt)))
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
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

// A track on a hidden ground keeps its slot; the schedule skips it until the ground is live.
function isScheduleTrackLive(trackKey: string): boolean {
    return isLiveGround(getTrackGround(TRACKS[trackKey]).key);
}

async function pickNextTrackKeyForToday(todayStartsAt: Date): Promise<string> {
    const pool = await readDailySchedulePool();
    // About once a day: the pick reads the ground of every scheduled track.
    await loadStoredTracks([...pool, DEFAULT_TRACK_KEY]);
    if (pool.length === 0) {
        return DEFAULT_TRACK_KEY;
    }
    const firstTrackKey = pool.find(isScheduleTrackLive) ?? DEFAULT_TRACK_KEY;

    const todayMs = todayStartsAt.getTime();
    const priorEntries = (await readStoredChallengeEntries())
        .filter((entry) => Number.isFinite(Date.parse(entry.startsAt)) && Date.parse(entry.startsAt) < todayMs)
        .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

    const playhead = priorEntries[0]?.trackKey;
    if (!playhead) {
        return firstTrackKey;
    }

    const playheadIndex = pool.indexOf(playhead);
    if (playheadIndex === -1) {
        return firstTrackKey;
    }

    // The next live track after the last day's track, from the start again after the end.
    for (let step = 1; step <= pool.length; step += 1) {
        const trackKey = pool[(playheadIndex + step) % pool.length];
        if (isScheduleTrackLive(trackKey)) return trackKey;
    }
    return firstTrackKey;
}

function getTodayChallengeId(): string {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = getUtcDayStart(dayIndex);
    return createDailyChallengeId(formatUtcChallengeDate(startsAt));
}

async function pickTodayDailyGpChallenge(mode: DailyChallengeReadMode = 'pinned'): Promise<DailyGpChallenge> {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = getUtcDayStart(dayIndex);
    const challengeId = createDailyChallengeId(formatUtcChallengeDate(startsAt));

    const stored = await readStoredOrBackfilledDailyGpChallenge(challengeId, mode);
    if (stored) {
        return stored;
    }

    const trackKey = await pickNextTrackKeyForToday(startsAt);
    return buildDailyGpChallengeForDayIndexWithTrack(dayIndex, trackKey);
}

async function resolveTodayDailyGpChallenge(mode: DailyChallengeReadMode = 'pinned'): Promise<DailyGpChallenge> {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = getUtcDayStart(dayIndex);
    const challengeId = createDailyChallengeId(formatUtcChallengeDate(startsAt));

    const stored = await readStoredOrBackfilledDailyGpChallenge(challengeId, mode);
    if (stored) {
        return stored;
    }

    await loadStoredTracks([DEFAULT_TRACK_KEY]);
    const challenge = buildDailyGpChallengeForDayIndexWithTrack(dayIndex, DEFAULT_TRACK_KEY);

    const committed = await commitDailyChallenge(challenge, dayIndex);
    if (mode === 'pinned') await loadChallengeTracks([committed]);
    return committed;
}

export async function persistServerDailyGpChallenge(challenge: DailyGpChallenge): Promise<DailyGpChallenge> {
    return commitDailyChallenge(challenge);
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

// A copied day queues 5 commands and a cleared one 4, so 4 days fit the 24-command budget.
const DAILY_DAYS_PER_TRANSFER_WRITE = 4;
// Days per Daily step piece, capped per request to stay well inside the client's 15 s wait.
const DAILY_DAYS_PER_TRANSFER_PIECE = 20;
const DAILY_DAYS_PER_TRANSFER_REQUEST = 60;

function dailySubmissionLockKeys(
    challengeIds: readonly string[],
    playerIds: readonly string[],
): string[] {
    return challengeIds.flatMap((id) => (
        playerIds.map((playerId) => competitionSubmissionLockKey({ mode: 'daily', id }, playerId))
    ));
}

// The transfer's Daily days: playable days it holds and every day either player raced, oldest first.
async function freezeTransferDays(
    record: GuestProgressSelectionRecord,
    racedChallengeIds: readonly string[],
): Promise<void> {
    const challengeIds = [...new Set([...(record.dailyChallengeIds ?? []), ...racedChallengeIds])].sort();
    const specsById = new Map((record.dailyChallengeSpecs ?? []).map((spec) => [spec.id, spec]));
    const loaded = await resolveGuestTransferDailyChallenges(
        challengeIds.filter((challengeId) => !specsById.has(challengeId)),
    );
    for (const challenge of loaded) specsById.set(challenge.id, transferChallengeSpec(challenge));
    record.dailyChallengeIds = challengeIds;
    record.dailyChallengeSpecs = challengeIds.map((challengeId) => specsById.get(challengeId)!);
}

// Saves check the marks after their lock, so the transfer reads every lock once to find earlier saves.
async function ensureNoRaceSaveInFlight(
    playerIds: readonly string[],
    campaignRaceIds: readonly string[] | null,
    challengeIds: readonly string[],
): Promise<void> {
    const keys = [
        ...campaignSubmissionLockKeys(playerIds, campaignRaceIds),
        ...dailySubmissionLockKeys(challengeIds, playerIds),
    ];
    if (keys.length === 0) return;
    const owners = await redis.mGet(keys);
    if (owners.some((owner) => owner !== null && owner !== undefined)) {
        throw new GuestProgressSelectionRetryableError('A race is still saving. Try again.');
    }
}

async function releaseSubmissionLocksSafely(
    locks: readonly RedisLock[],
    context: string,
): Promise<void> {
    await releaseRedisLockGroup(locks, context, redis);
}

export function guestProgressRecoveryRequiredError(): GuestProgressRecoveryRequiredError {
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
        return readDailyGpPlaylist();
    }
    if (challengeIds.length === 0) return [];
    // One read for every stored day; a day not stored yet takes the usual path.
    const storedRaw = await redis.hMGet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, challengeIds);
    const challenges = await Promise.all(challengeIds.map((challengeId, index) => (
        parseStoredChallenge(storedRaw[index])
            ?? readDailyGpChallengeById(challengeId, { persistFallback: false })
    )));
    await loadChallengeTracks(challenges);
    if (challenges.some((challenge) => !challenge || !TRACKS[challenge.trackKey])) {
        throw guestProgressRecoveryRequiredError();
    }
    return challenges as DailyGpChallenge[];
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
    const challenge = await resolveTodayDailyGpChallenge('contract');
    await confirmStoredTracks([challenge.trackKey]);
    if (!hasTrack(challenge.trackKey)) {
        throw new TrackPlacementRetryError('The Daily track could not be confirmed. Retry before racing.');
    }
    return challenge;
}

async function readDailyGpChallengeById(
    challengeId?: string | null,
    { persistFallback = true }: { persistFallback?: boolean } = {},
    mode: DailyChallengeReadMode = 'pinned',
): Promise<DailyGpChallenge | null> {
    if (typeof challengeId !== 'string' || !challengeId) {
        return null;
    }

    const stored = await readStoredOrBackfilledDailyGpChallenge(challengeId, mode);
    if (stored) {
        return stored;
    }

    if (challengeId !== getTodayChallengeId()) {
        return null;
    }

    if (persistFallback) {
        return resolveTodayDailyGpChallenge(mode);
    }
    return pickTodayDailyGpChallenge(mode);
}

export async function getServerDailyGpChallengeById(
    challengeId?: string | null,
    options: { persistFallback?: boolean } = {},
): Promise<DailyGpChallenge | null> {
    const challenge = await readDailyGpChallengeById(challengeId, options, 'contract');
    if (!challenge) return null;
    await confirmStoredTracks([challenge.trackKey]);
    return hasTrack(challenge.trackKey) ? challenge : null;
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
    const challenge = challengeId === getTodayChallengeId()
        ? await getServerDailyGpChallenge()
        : await getServerDailyGpChallengeById(challengeId, { persistFallback: false });
    if (challenge && isDailyGpChallengePlayable(challenge)) {
        return challenge;
    }

    if (challengeId === getTodayChallengeId()) {
        const activeChallenge = await getServerDailyGpChallenge();
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

async function readDailyGpPlaylist(
    now = new Date(),
    mode: DailyChallengeReadMode = 'pinned',
    requestedIds?: readonly string[],
): Promise<DailyGpChallenge[]> {
    const todayIndex = getUtcDayIndex(now);
    const challenges: DailyGpChallenge[] = [];
    const requested = requestedIds ? new Set(requestedIds) : null;
    const challengeIds = Array.from({ length: DAILY_GP_PLAYLIST_DAYS }, (_unused, offset) => (
        createDailyChallengeId(getUtcDayStart(todayIndex - offset).toISOString().slice(0, 10))
    )).filter((challengeId) => !requested || requested.has(challengeId));
    if (!challengeIds.length) return [];
    const activeChallenge = !requested || requested.has(getTodayChallengeId())
        ? await resolveTodayDailyGpChallenge(mode) : null;
    const storedIds = challengeIds.filter((challengeId) => challengeId !== activeChallenge?.id);
    const storedRaw = storedIds.length > 0
        ? await redis.hMGet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, storedIds)
        : [];
    const storedById = new Map(storedIds.map((challengeId, index) => [
        challengeId,
        (mode === 'contract' ? parseStoredChallengeContract : parseStoredChallenge)(
            typeof storedRaw[index] === 'string' ? storedRaw[index] : null,
        ),
    ]));

    for (const challengeId of challengeIds) {
        const challenge = challengeId === activeChallenge?.id
            ? activeChallenge
            : storedById.get(challengeId) ?? await readStoredOrBackfilledDailyGpChallenge(challengeId, mode);
        if (challenge && isDailyGpChallengePlayable(challenge, now)) {
            challenges.push(challenge);
        }
    }

    if (mode === 'pinned') await loadChallengeTracks(challenges);
    return challenges;
}

// PB summaries use only the requested IDs, so another day's missing record cannot block them.
export async function getServerDailyGpPlaylistContracts(
    now = new Date(),
    requestedIds?: readonly string[],
): Promise<DailyGpChallenge[]> {
    return readDailyGpPlaylist(now, 'contract', requestedIds);
}

export async function getServerDailyGpPlaylist(now = new Date()): Promise<DailyGpChallenge[]> {
    const challenges = await getServerDailyGpPlaylistContracts(now);
    await confirmStoredTracks(challenges.map((challenge) => challenge.trackKey));
    return challenges.filter((challenge) => hasTrack(challenge.trackKey));
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
        redisCompressed.hGet(competition.pbHashKey, playerFieldHash(guestPlayerId)),
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

// Moves guest Daily rows to the account, keeping the faster time per day.
export async function mergeGuestDailyProgress({
    guestPlayerId,
    redditPlayerId,
    challengeIds,
    challengeSpecs,
    verifyGuestSource,
    recordedDailyChallengeIds,
    transactionRunner,
    classifySource = false,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    challengeIds?: string[];
    challengeSpecs?: GuestTransferDailyChallengeSpec[];
    verifyGuestSource?: (observed?: {
        dailyDay: { challengeId: string; entry: string | null; pb: string | null; rank: number | null };
    }) => void | Promise<void>;
    recordedDailyChallengeIds?: ReadonlySet<string>;
    transactionRunner: RedisLockTransactionRunner;
    // Checks guest rows before any write, so a damaged row stops the transfer instead of being dropped.
    classifySource?: boolean;
}): Promise<{ merged: boolean; mergedChallengeIds: string[] }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return { merged: false, mergedChallengeIds: [] };
    }

    const playlist = await resolveGuestTransferDailyChallenges(challengeIds);
    const mergedChallengeIds: string[] = [];
    let hasGuestEvidence = false;

    await verifyGuestSource?.();

    // Reads all days at once; takes a day only if a player holds a row there or the transfer recorded it.
    const days = await Promise.all(playlist.map(async (challenge) => {
        const competition = toDailyCompetition(challenge);
        const track = TRACKS[challenge.trackKey];
        if (!track) {
            if (challengeSpecs?.some((spec) => spec.id === challenge.id)) {
                throw guestProgressRecoveryRequiredError();
            }
            return null;
        }
        const [guestHoldsRows, accountHoldsRows] = await Promise.all([
            competitionHoldsPlayerRows(competition, guestPlayerId),
            competitionHoldsPlayerRows(competition, redditPlayerId),
        ]);
        const wasRecorded = recordedDailyChallengeIds?.has(challenge.id) ?? false;
        if (!guestHoldsRows && !accountHoldsRows && !wasRecorded) return null;
        const guestSource = classifySource
            ? await captureClassifiedGuestDailySource(competition, track, challenge, guestPlayerId)
            : null;
        const state = await readDailyMergeState(
            competition,
            track,
            guestPlayerId,
            redditPlayerId,
            guestSource,
        );
        return { challenge, competition, guestHoldsRows, guestSource, state };
    }));

    // Check every guest day, and decide its writes, before the first write.
    const dayWrites: RedisLockMutation[] = [];
    for (const day of days) {
        if (!day) continue;
        const { challenge, competition, guestSource } = day;
        hasGuestEvidence ||= day.guestHoldsRows;
        if (guestSource?.malformed.length) {
            throw guestProgressRecoveryRequiredError();
        }
        if (guestSource) {
            await verifyGuestSource?.({
                dailyDay: { challengeId: challenge.id, ...guestSource.observed },
            });
        }
        const { guestEntryWins, entryToWrite, guestPbWins } = decideBoardMerge({
            board: competition,
            guestPlayerId,
            redditPlayerId,
            ...day.state,
        });

        let rawGuestPb: string | undefined;
        if (guestPbWins) {
            if (guestSource) {
                rawGuestPb = guestSource.decodedPb === null
                    ? undefined
                    : encodeRedisCompressedValue(guestSource.decodedPb);
            } else {
                rawGuestPb = await redis.hGet(
                    competition.pbHashKey,
                    playerFieldHash(guestPlayerId),
                );
            }
            if (!rawGuestPb) {
                throw new Error(`Daily guest PB disappeared during promotion: ${challenge.id}`);
            }
        }
        const mutate = boardMergeWrite(competition, redditPlayerId, entryToWrite, rawGuestPb);
        if (mutate) dayWrites.push(mutate);
        if (guestEntryWins) {
            mergedChallengeIds.push(challenge.id);
        }
    }

    for (let index = 0; index < dayWrites.length; index += DAILY_DAYS_PER_TRANSFER_WRITE) {
        const group = dayWrites.slice(index, index + DAILY_DAYS_PER_TRANSFER_WRITE);
        await transactionRunner([], async (transaction) => {
            for (const write of group) await write(transaction);
        });
    }

    if (!hasGuestEvidence) {
        return { merged: false, mergedChallengeIds: [] };
    }
    return {
        merged: mergedChallengeIds.length > 0,
        mergedChallengeIds,
    };
}

// Deletes guest Daily rows in groups (cleanup or discard), only on days the guest holds a row.
async function clearGuestDailyProgress({
    guestPlayerId,
    challengeIds,
    challengeSpecs,
    transactionRunner,
}: {
    guestPlayerId: string;
    challengeIds?: string[];
    challengeSpecs?: GuestTransferDailyChallengeSpec[];
    transactionRunner: RedisLockTransactionRunner;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const playlist = Array.isArray(challengeSpecs)
        ? challengeSpecs.map(transferChallengeFromSpec)
        : await resolveGuestTransferDailyChallenges(challengeIds);
    const competitions = (await Promise.all(playlist.map(async (challenge) => {
        const competition = toDailyCompetition(challenge);
        return await guestOwnsDailyDay(competition, guestPlayerId) ? competition : null;
    }))).filter((competition): competition is ReturnType<typeof toDailyCompetition> => competition !== null);
    for (let index = 0; index < competitions.length; index += DAILY_DAYS_PER_TRANSFER_WRITE) {
        const group = competitions.slice(index, index + DAILY_DAYS_PER_TRANSFER_WRITE);
        await transactionRunner([], async (transaction) => {
            for (const competition of group) {
                await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
                await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
                await transaction.hDel(competition.pbHashKey, [playerFieldHash(guestPlayerId)]);
                await transaction.incrBy(competition.standingsRevisionKey, 1);
            }
        });
    }
    return competitions.length > 0;
}

export async function cleanupGuestDailyProgress(input: {
    guestPlayerId: string;
    challengeIds?: string[];
    challengeSpecs?: GuestTransferDailyChallengeSpec[];
    transactionRunner: RedisLockTransactionRunner;
}): Promise<boolean> {
    return clearGuestDailyProgress(input);
}

export async function discardGuestDailyProgress(input: {
    guestPlayerId: string;
    challengeIds?: string[];
    challengeSpecs?: GuestTransferDailyChallengeSpec[];
    transactionRunner: RedisLockTransactionRunner;
}): Promise<boolean> {
    return clearGuestDailyProgress(input);
}

async function countDailyProgressResults(
    playerId: string,
    playlist: DailyGpChallenge[],
): Promise<number> {
    await loadChallengeTracks(playlist);
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
    // With complete raced lists, count every raced day, archived or emptied too; the list only grows.
    const listed = await readTransferBoards([playerId]);
    const [dailySavedResults, carUnlocks] = await Promise.all([
        listed
            ? Promise.resolve(listed.dailyChallengeIds.length)
            : countDailyProgressResults(playerId, dailyPlaylist),
        getCarUnlockSnapshot(playerId, campaign.resultsByRaceId),
    ]);
    return {
        campaignResults,
        campaignUnlockedTracks,
        campaignTotalStages: CAMPAIGN_LIVE_STAGES.length,
        dailySavedResults,
        dailyPlaylistSize: listed ? null : dailyPlaylist.length,
        carsUnlocked: carUnlocks.unlockedAssets.length,
        carsTotal: PLAYER_SELECTABLE_CAR_ASSETS.length,
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
    for (const key of campaignProgressKeys(guestPlayerId)) {
        const rawProgress = await redis.get(key);
        if (!rawProgress) continue;
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
    // Complete raced lists name every board the guest can hold a row on, archived days too.
    const listed = await readTransferBoards([guestPlayerId]);
    const listedStages = listed ? new Set(listed.campaignRaceIds) : null;
    const boards = [
        ...CAMPAIGN_LIVE_STAGES
            .filter((stage) => !listedStages || listedStages.has(stage.raceId))
            .map((stage) => toCampaignCompetition(stage.seriesId, stage)),
        ...(listed
            ? listed.dailyChallengeIds.map(dailyBoardKeys)
            : dailyPlaylist.map((challenge) => toDailyCompetition(challenge))),
    ];
    const holds = await Promise.all(boards.map((board) => (
        competitionHoldsPlayerRows(board, guestPlayerId)
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

export function pendingSelectionPayload({
    guestPlayerId,
    redditPlayerId,
    choice,
    state,
    required = true,
    completedAt,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    choice?: GuestTransferChoice;
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
        ...(choice ? { choice: runnableTransferChoice(choice) } : {}),
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
        if (!isGuestTransferChoice(receipt.choice)) return null;
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
    return copiesGuestProgress(record.choice)
        && !TRANSFER_COMPLETION_DOMAINS.every(
            (domain) => record.completedDomains?.includes(domain),
        );
}

function resumableRecordState(
    record: GuestProgressSelectionRecord,
): 'resume_required' | 'recovery_required' {
    if (record.phase === 'recovery_required') return 'recovery_required';
    if (!hasReplacementRemaining(record)) return 'resume_required';
    // A transfer with marks but no copy yet captures its inventory on the next try.
    if (record.version === 4 && record.phase === 'preparing' && record.completedDomains.length === 0) {
        return 'resume_required';
    }
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
    try {
        survivingSource = await captureGuestTransferSourceInventory(guestId, specs);
        destinationEvidence = {
            campaignProgress: stableFingerprint(await redis.get(campaignProgressKey(accountId)) ?? null),
            campaignSeriesProgress: await captureCampaignSeriesProgressEvidence(accountId),
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
            choice?: GuestTransferChoice,
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
    const dailyPlaylist = await readDailyGpPlaylist();
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
    choice: requestedChoice,
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
    choice: GuestTransferChoice;
    transferId: string;
    sourceGuestPlayerId: string;
    completedAt: string;
}> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        throw new Error('Guest progress selection requires a guest and Reddit identity.');
    }
    if (!isGuestTransferChoice(requestedChoice)) {
        throw new Error('Guest progress selection is invalid.');
    }
    const choice = runnableTransferChoice(requestedChoice);
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
        outcome: 'completed' | 'continued' | 'retryable' | 'recovery_required' | 'not_needed' | 'failed',
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
        const coordinatorRunner = createOwnedLockGroupRunner(
            locks,
            (reason) => new GuestProgressSelectionRetryableError(reason === 'lost'
                ? 'Guest progress selection ownership was lost. Try again.'
                : 'Guest progress selection was interrupted. Try again.'),
            redis,
        );
        const runTransferMutation: RedisLockTransactionRunner = async (
            domainLocks,
            mutate: RedisLockMutation,
        ): Promise<void> => {
            await stopLeaseForFence();
            await coordinatorRunner(domainLocks, mutate);
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
            newTransferPlaylist = await readDailyGpPlaylist();
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
            if (!isGuestTransferChoice(parsedRecord.choice)) {
                throw guestProgressRecoveryRequiredError();
            }
            if (runnableTransferChoice(parsedRecord.choice) !== choice) {
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
                : newTransferPlaylist ?? await readDailyGpPlaylist();
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
        const replacementRemaining = copiesGuestProgress(choice)
            && !TRANSFER_COMPLETION_DOMAINS.every(
                (domain) => currentRecord?.completedDomains?.includes(domain),
            );
        // Capture only after the marks, so no race changes the guest's rows before the copy.
        const recaptureInventory = replacementRemaining
            && (preparing || !isValidSourceInventory(currentRecord?.sourceInventory));
        const sourceInventory = recaptureInventory ? undefined : currentRecord?.sourceInventory;
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
            ...(currentRecord?.dailyStepDone !== undefined ? { dailyStepDone: currentRecord.dailyStepDone } : {}),
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
            reportedPhase = 'preparing';
            await saveRecord(record, { markPending: true });
        }
        // Saves past the mark check took their series list first, so a list loaded now covers every stage.
        try {
            await reloadPinnedCatalog();
        } catch (error) {
            console.error('Guest progress transfer could not load the series list:', error);
            throw new GuestProgressSelectionRetryableError('The tracks could not load. Try again.');
        }
        // No race starts after the marks, so complete raced lists cover every board; else use all stages and days.
        const transferBoards = await readTransferBoards([guestPlayerId, redditPlayerId]);
        const campaignRaceIds = transferBoards?.campaignRaceIds ?? null;
        await ensureNoRaceSaveInFlight(
            [guestPlayerId, redditPlayerId],
            campaignRaceIds,
            [...new Set([
                ...(record.dailyChallengeIds ?? []),
                ...(transferBoards?.dailyChallengeIds ?? []),
            ])],
        );
        if (preparing && transferBoards) {
            await freezeTransferDays(record, transferBoards.dailyChallengeIds);
        }
        if (recaptureInventory) {
            record.sourceInventory = await captureGuestTransferSourceInventory(
                guestPlayerId,
                record.dailyChallengeSpecs ?? [],
                campaignRaceIds,
            );
        }
        if (replacementRemaining && !isValidSourceInventory(record.sourceInventory)) {
            throw guestProgressRecoveryRequiredError();
        }
        if (record.phase !== 'cleaning') record.phase = 'copying';
        record.updatedAt = new Date().toISOString();
        reportedPhase = record.phase;
        type ObservedSource = {
            unlocks?: Record<string, string>;
            campaignProgress?: string | null;
            campaignSeriesProgress?: Record<string, string | null>;
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
        const verifySourceDomain = (
            domain: 'campaign' | 'daily' | 'unlocks',
            dailySpecs?: readonly GuestTransferDailyChallengeSpec[],
        ) => (
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
                        campaignSeriesProgress: Object.fromEntries(
                            Object.entries(raw.campaignSeriesProgress ?? {}).map(([seriesId, value]) => [
                                seriesId,
                                stableFingerprint(value ?? null),
                            ]),
                        ),
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
                        campaignSeriesProgress: await captureCampaignSeriesProgressEvidence(guestPlayerId),
                        campaignStages: await captureCampaignStageEvidence(guestPlayerId, campaignRaceIds),
                    };
                } else if (domain === 'daily') {
                    // Only this piece's days can differ; other days keep their recorded rows.
                    evidence = {
                        daily: {
                            ...record.sourceInventory.daily,
                            ...await captureDailyEvidence(
                                guestPlayerId,
                                dailySpecs ?? record.dailyChallengeSpecs ?? [],
                            ),
                        },
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
        // When this request's share is done and days remain, save the position and ask the client to continue.
        let dailyDaysThisRequest = 0;
        const runDailyInPieces = async (
            step: (
                challengeIds: string[],
                challengeSpecs: GuestTransferDailyChallengeSpec[],
            ) => Promise<unknown>,
        ): Promise<void> => {
            const challengeIds = record.dailyChallengeIds ?? [];
            const challengeSpecs = record.dailyChallengeSpecs ?? [];
            let done = record.dailyStepDone ?? 0;
            while (done < challengeIds.length) {
                if (dailyDaysThisRequest >= DAILY_DAYS_PER_TRANSFER_REQUEST) {
                    reportedPhase = record.phase ?? reportedPhase;
                    throw new GuestProgressSelectionContinueError(derivedTransferId);
                }
                const end = Math.min(challengeIds.length, done + DAILY_DAYS_PER_TRANSFER_PIECE);
                await step(challengeIds.slice(done, end), challengeSpecs.slice(done, end));
                dailyDaysThisRequest += end - done;
                done = end;
                if (done < challengeIds.length) {
                    record.dailyStepDone = done;
                    await saveRecord(record);
                    await confirmSelectionOwnership();
                }
            }
            delete record.dailyStepDone;
        };
        if (copiesGuestProgress(choice)) {
            // Merge keeps the faster time per board, after checking guest rows for damage.
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('campaign')) {
                await timed('campaignMs', () => mergeGuestCampaignProgress({
                    guestPlayerId,
                    redditPlayerId,
                    raceIds: campaignRaceIds,
                    classifySource: true,
                    verifyGuestSource: verifySourceDomain('campaign'),
                    transactionRunner: runTransferMutation,
                }));
                record.completedDomains = [...record.completedDomains, 'campaign'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('daily')) {
                await timed('dailyMs', () => runDailyInPieces((challengeIds, challengeSpecs) => (
                    mergeGuestDailyProgress({
                        guestPlayerId,
                        redditPlayerId,
                        classifySource: true,
                        challengeIds,
                        challengeSpecs,
                        verifyGuestSource: verifySourceDomain('daily', challengeSpecs),
                        recordedDailyChallengeIds: recordedDailyDays(record.sourceInventory),
                        transactionRunner: runTransferMutation,
                    })
                )));
                record.completedDomains = [...record.completedDomains, 'daily'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('unlocks')) {
                await timed('unlocksMs', () => mergeGuestCarUnlockProgress({
                    guestPlayerId,
                    redditPlayerId,
                    preserveSource: true,
                    verifyGuestSource: verifySourceDomain('unlocks'),
                    transactionRunner: runTransferMutation,
                }));
                await carryGuestSettings({ guestPlayerId, redditPlayerId, choice });
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
                await timed('campaignCleanupMs', () => cleanupGuestCampaignProgress({
                    guestPlayerId,
                    raceIds: campaignRaceIds,
                    transactionRunner: runTransferMutation,
                }));
                record.cleanedDomains = [...(record.cleanedDomains || []), 'campaign'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.cleanedDomains?.includes('daily')) {
                await timed('dailyCleanupMs', () => runDailyInPieces((challengeIds, challengeSpecs) => (
                    cleanupGuestDailyProgress({
                        guestPlayerId,
                        challengeIds,
                        challengeSpecs,
                        transactionRunner: runTransferMutation,
                    })
                )));
                record.cleanedDomains = [...(record.cleanedDomains || []), 'daily'];
                await saveRecord(record);
            }
        } else {
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('campaign')) {
                await timed('campaignMs', () => discardGuestCampaignProgress({
                    guestPlayerId,
                    raceIds: campaignRaceIds,
                    transactionRunner: runTransferMutation,
                }));
                record.completedDomains = [...record.completedDomains, 'campaign'];
                await saveRecord(record);
            }
            await confirmSelectionOwnership();
            if (!record.completedDomains?.includes('daily')) {
                await timed('dailyMs', () => runDailyInPieces((challengeIds, challengeSpecs) => (
                    discardGuestDailyProgress({
                        guestPlayerId,
                        challengeIds,
                        challengeSpecs,
                        transactionRunner: runTransferMutation,
                    })
                )));
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
        if (copiesGuestProgress(choice)) {
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
        const outcome = error instanceof GuestProgressSelectionContinueError
            ? 'continued'
            : reason === 'guest_progress_recovery_required'
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
    await cleanupExpiredDailyGuestsBestEffort();
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
    await confirmStoredTracks([challenge.trackKey]);
    if (!hasTrack(challenge.trackKey)) return createEmptyDailySnapshot(challenge);

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
    if (progressTransferPending) return progressTransferPendingReply();

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
