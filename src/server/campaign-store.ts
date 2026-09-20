import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
    isCampaignStageUnlocked,
} from '../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { TRACKS } from '../../game/track/tracks.js';
import {
    CAMPAIGN_GUEST_TTL_SECONDS,
    toCampaignCompetition,
    type Competition,
} from './competition.js';
import type { DailyGpLeaderboardEntry } from './daily-gp-model.js';
import {
    competitionHoldsPlayerRows,
    parseStoredEntry,
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
    writeEntry,
} from './competition-leaderboard.js';
import {
    classifyStoredCampaignProgress,
    classifyStoredLeaderboardEntry,
    readStoredUpdatedAt,
    type StoredRecordClassification,
} from './guest-transfer-source-classification.js';
import { encodeRedisCompressedValue } from './redis-compressed-value.js';
import { campaignProgressKey } from './campaign-progress-key.js';
import { prepareCompetitionOpponentRace } from './competition-opponent-race.js';
import { resolveAuthorizedPlayerIdentity } from './competition-identity.js';
import { verifyGuestPlayerToken } from './player-token.js';
import {
    competitionSubmissionLockKey,
    isMismatchedSubmissionOwner,
    submitCompetitionRun,
    SUBMISSION_IDENTITY_CHANGED_RESULT,
    SUBMISSION_LOCK_TTL_MS,
    type RankedSubmitReuseOptions,
} from './competition-submit.js';
import {
    classifyStoredPbRecordFor,
    getPlayerTrackPbRecord,
    type PlayerTrackPbRecord,
} from './pb-ghost-store.js';
import { redisCompressed } from '@devvit/redis';
import {
    getCarUnlockSnapshot,
    readGuestPromotionTarget,
    recordCompletedRace,
} from './car-unlock-store.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockGroupTransaction,
    beginOwnedRedisLockTransaction,
    commitOwnedRedisLockTransaction,
    releaseRedisLock,
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
import { recordAnalyticsRaceBestEffort } from './analytics-store.js';
import { isPlayerProgressSelectionPending } from './guest-retirement.js';

type CampaignMedal = 'bronze' | 'silver' | 'gold' | 'author';

export type CampaignBestResult = {
    raceId: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    rulesRevision: number;
    bestTimeMs: number;
    medal: CampaignMedal | null;
    checkpointTimesSec: number[] | null;
    updatedAt: string;
};

type CampaignProgress = {
    campaignId: typeof CAMPAIGN_ID;
    startedAt: string | null;
    resultsByRaceId: Record<string, CampaignBestResult>;
    updatedAt: string | null;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const CAMPAIGN_PROGRESS_LOCK_TTL_MS = 30_000;
const CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS = Math.max(
    1,
    Math.floor(CAMPAIGN_PROGRESS_LOCK_TTL_MS / 3),
);
const CAMPAIGN_GUEST_CLEANUP_THROTTLE_SECONDS = 60;
const CAMPAIGN_GUEST_CLEANUP_LIMIT = 10;
export const CAMPAIGN_GUEST_EXPIRY_KEY = `campaign:${CAMPAIGN_ID}:guest-expiry`;
const CAMPAIGN_GUEST_CLEANUP_THROTTLE_KEY = `${CAMPAIGN_GUEST_EXPIRY_KEY}:cleanup-throttle`;

function playerField(playerId: string): string {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

const progressKey = campaignProgressKey;

function progressLockKey(playerId: string): string {
    return `campaign:${CAMPAIGN_ID}:progress-lock:${playerField(playerId)}`;
}

function isGuestPlayerId(playerId: string): boolean {
    return playerId.startsWith('guest:');
}

function guestExpiresAt(): Date {
    return new Date(Date.now() + CAMPAIGN_GUEST_TTL_SECONDS * 1000);
}

function competitionFor(stage: { raceId: string; trackKey: string; lapCount: number; rulesRevision: number }, playerId: string | null): Competition {
    return toCampaignCompetition(CAMPAIGN_ID, stage, { playerId });
}

function emptyProgress(): CampaignProgress {
    return {
        campaignId: CAMPAIGN_ID,
        startedAt: null,
        resultsByRaceId: {},
        updatedAt: null,
    };
}

function parseBestResult(value: unknown, expectedRaceId?: string): CampaignBestResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Partial<CampaignBestResult>;
    const stage = getCampaignStage(row.raceId);
    if (
        !stage
        || (expectedRaceId && row.raceId !== expectedRaceId)
        || row.trackKey !== stage.trackKey
        || row.lapCount !== stage.lapCount
        || row.rulesRevision !== stage.rulesRevision
        || !Number.isSafeInteger(row.bestTimeMs)
        || Number(row.bestTimeMs) <= 0
        || typeof row.updatedAt !== 'string'
    ) {
        return null;
    }
    const medal = row.medal === 'bronze'
        || row.medal === 'silver'
        || row.medal === 'gold'
        || row.medal === 'author'
        ? row.medal
        : null;
    return {
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        rulesRevision: stage.rulesRevision,
        bestTimeMs: Math.round(Number(row.bestTimeMs)),
        medal,
        checkpointTimesSec: Array.isArray(row.checkpointTimesSec)
            ? row.checkpointTimesSec.map(Number).filter(Number.isFinite)
            : null,
        updatedAt: row.updatedAt,
    };
}

function campaignResultFromEntry(
    stage: (typeof CAMPAIGN_STAGES)[number],
    entry: DailyGpLeaderboardEntry | null,
    expectedPlayerId: string,
): CampaignBestResult | null {
    if (
        !entry
        || entry.playerId !== expectedPlayerId
        || entry.trackKey !== stage.trackKey
        || !Number.isSafeInteger(entry.bestTimeMs)
        || entry.bestTimeMs <= 0
        || entry.completedLaps !== stage.lapCount
        || entry.validationMethod !== 'strict-replay'
    ) return null;
    return {
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        rulesRevision: stage.rulesRevision,
        bestTimeMs: Math.round(entry.bestTimeMs),
        medal: getMedalForRaceTime(
            stage.trackKey,
            entry.bestTimeMs / 1000,
            stage.lapCount,
        ),
        checkpointTimesSec: entry.checkpointTimesSec ?? null,
        updatedAt: entry.updatedAt,
    };
}

function fasterCampaignResult(
    first: CampaignBestResult | null | undefined,
    second: CampaignBestResult | null | undefined,
): CampaignBestResult | null {
    if (!first) return second ?? null;
    if (!second) return first;
    return second.bestTimeMs < first.bestTimeMs ? second : first;
}

export function parseCampaignProgress(raw: string | null | undefined): CampaignProgress {
    if (!raw) return emptyProgress();
    try {
        const value = JSON.parse(raw) as Partial<CampaignProgress>;
        if (value.campaignId !== CAMPAIGN_ID) return emptyProgress();
        const resultsByRaceId: Record<string, CampaignBestResult> = {};
        if (value.resultsByRaceId && typeof value.resultsByRaceId === 'object') {
            for (const [raceId, candidate] of Object.entries(value.resultsByRaceId)) {
                const result = parseBestResult(candidate, raceId);
                if (result) resultsByRaceId[raceId] = result;
            }
        }
        return {
            campaignId: CAMPAIGN_ID,
            startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
            resultsByRaceId,
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        };
    } catch (_error) {
        return emptyProgress();
    }
}

async function readProgress(playerId: string): Promise<CampaignProgress> {
    return parseCampaignProgress(await redis.get(progressKey(playerId)));
}

/** Campaign progress left under a promoted guest means its migration never finished, so that guest is still needed. */
export async function hasStoredCampaignProgress(playerId: string): Promise<boolean> {
    return Boolean(await redis.get(progressKey(playerId)));
}

class CampaignProgressBusyError extends GuestProgressSelectionRetryableError {}

async function writeProgressWithOwnedLock(
    playerId: string,
    progress: CampaignProgress,
    lock: RedisLock,
    transactionRunner?: RedisLockTransactionRunner,
): Promise<void> {
    const expiresAt = guestExpiresAt();
    const enqueue: RedisLockMutation = async (transaction) => {
        await transaction.set(
            progressKey(playerId),
            JSON.stringify(progress),
            isGuestPlayerId(playerId) ? { expiration: expiresAt } : undefined,
        );
        if (isGuestPlayerId(playerId)) {
            await transaction.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, {
                member: playerId,
                score: expiresAt.getTime(),
            });
        }
    };
    if (transactionRunner) {
        await transactionRunner([lock], enqueue);
        return;
    }
    const transaction = await beginOwnedRedisLockTransaction(lock, redis);
    if (!transaction) throw new CampaignProgressBusyError('Campaign progress lock was lost.');
    await enqueue(transaction);
    if (!await commitOwnedRedisLockTransaction(transaction)) {
        throw new CampaignProgressBusyError('Campaign progress save was interrupted.');
    }
}

async function mutateProgress(
    playerId: string,
    mutate: (progress: CampaignProgress) => CampaignProgress,
): Promise<CampaignProgress> {
    let lock: RedisLock | null = null;
    for (let attempt = 0; attempt < 5 && !lock; attempt += 1) {
        lock = await acquireRedisLock(progressLockKey(playerId), CAMPAIGN_PROGRESS_LOCK_TTL_MS, redis);
        if (!lock && attempt < 4) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
    }
    if (!lock) throw new CampaignProgressBusyError('Campaign progress update is already in progress.');
    try {
        const current = await readProgress(playerId);
        const next = mutate(current);
        if (next === current) return current;
        await writeProgressWithOwnedLock(playerId, next, lock);
        return next;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Campaign progress lock cleanup failed:', error);
        });
    }
}

/**
 * Makes sure a guest whose Campaign source is being kept for review will still be collected.
 *
 * Guests are enrolled in the expiry ledger only when a progress row is written. A guest holding
 * a personal best or a leaderboard row and no progress row was never enrolled, so preserving its
 * source for a reviewer would keep it for ever. Holding data for review is not a reason to hold
 * it without end.
 *
 * The deadline comes from the newest usable timestamp in the source plus the ordinary retention
 * period, never from today: data that has already outlived its retention gets no extension. An
 * existing ledger entry is left exactly as it is. A source with no usable timestamp is reported
 * and left alone, because choosing a deadline for it would be inventing one.
 */
async function ensureGuestCampaignRetention(
    guestPlayerId: string,
    newestUpdatedAt: string | null,
    nowMs = Date.now(),
): Promise<void> {
    if (!guestPlayerId.startsWith('guest:')) return;
    if (typeof redis.zScore !== 'function') return;
    const existing = await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, guestPlayerId);
    if (existing !== undefined && existing !== null && Number.isFinite(Number(existing))) return;

    const observedMs = newestUpdatedAt ? Date.parse(newestUpdatedAt) : Number.NaN;
    if (!Number.isFinite(observedMs)) {
        console.error(
            'Campaign guest source held for review carries no usable timestamp; '
            + 'its retention needs an explicit decision:',
            guestPlayerId,
        );
        return;
    }
    const expiresAtMs = observedMs + CAMPAIGN_GUEST_TTL_SECONDS * 1000;
    await redis.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, {
        member: guestPlayerId,
        // Data already past its retention is due for the next sweep, not given a fresh term.
        score: expiresAtMs <= nowMs ? nowMs : expiresAtMs,
    });
}

export async function cleanupExpiredCampaignGuests(nowMs = Date.now()): Promise<number> {
    const candidates = await redis.zRange(CAMPAIGN_GUEST_EXPIRY_KEY, 0, nowMs, {
        by: 'score',
        limit: { offset: 0, count: CAMPAIGN_GUEST_CLEANUP_LIMIT },
    });
    if (!candidates.length) return 0;
    const throttle = await redis.set(CAMPAIGN_GUEST_CLEANUP_THROTTLE_KEY, '1', {
        nx: true,
        expiration: new Date(nowMs + CAMPAIGN_GUEST_CLEANUP_THROTTLE_SECONDS * 1000),
    });
    if (!throttle) return 0;

    const transaction = await redis.watch(
        CAMPAIGN_GUEST_EXPIRY_KEY,
        ...candidates.map((candidate) => progressLockKey(candidate.member)),
    );
    try {
        const expired: string[] = [];
        for (const candidate of candidates) {
            const score = await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, candidate.member);
            if (Number.isFinite(score) && Number(score) <= nowMs) expired.push(candidate.member);
        }
        if (!expired.length) {
            await transaction.unwatch();
            return 0;
        }
        const activeProgressLocks = await Promise.all(
            expired.map((playerId) => redis.get(progressLockKey(playerId))),
        );
        if (activeProgressLocks.some(Boolean)) {
            await transaction.unwatch();
            return 0;
        }
        await transaction.multi();
        for (const stage of CAMPAIGN_STAGES) {
            const competition = competitionFor(stage, null);
            await transaction.zRem(competition.leaderboardKey, expired);
            await transaction.hDel(competition.entryHashKey, expired);
            await transaction.hDel(competition.pbHashKey, expired.map(playerField));
            await transaction.incrBy(competition.standingsRevisionKey, 1);
        }
        for (const playerId of expired) await transaction.del(progressKey(playerId));
        await transaction.zRem(CAMPAIGN_GUEST_EXPIRY_KEY, expired);
        const results = await transaction.exec();
        return Array.isArray(results) && results.length > 0 ? expired.length : 0;
    } catch (error) {
        try {
            await transaction.discard();
        } catch (_discardError) {
            // EXEC may already have closed the transaction.
        }
        throw error;
    }
}

async function cleanupExpiredCampaignGuestsBestEffort(): Promise<void> {
    try {
        await cleanupExpiredCampaignGuests();
    } catch (error) {
        console.error('Campaign guest cleanup failed:', error);
    }
}

export async function getCampaignResultsForCarUnlocks(
    playerId: string,
): Promise<CampaignProgress['resultsByRaceId']> {
    return (await readProgress(playerId)).resultsByRaceId;
}

export async function getCampaignProgressForSelection(
    playerId: string,
    { repairEmpty = true }: { repairEmpty?: boolean } = {},
): Promise<CampaignProgress> {
    const progress = await readProgress(playerId);
    // Empty progress is common for a guest who only opened Campaign; avoid a full stage scan
    // during the cheap selection evidence check when there is no stored result to repair.
    if (!repairEmpty && !progress.startedAt && !Object.keys(progress.resultsByRaceId).length) {
        return progress;
    }
    return repairCampaignProgressFromLeaderboard(playerId, progress);
}

function publicProgress(progress: CampaignProgress) {
    const unlockedRaceIds = getCampaignUnlockedRaceIds(progress.resultsByRaceId);
    return {
        campaignId: CAMPAIGN_ID,
        startedAt: progress.startedAt,
        resultsByRaceId: progress.resultsByRaceId,
        unlockedRaceIds,
        complete: CAMPAIGN_STAGES.every((stage) => {
            const medal = progress.resultsByRaceId[stage.raceId]?.medal;
            return medal === 'gold' || medal === 'author';
        }),
        updatedAt: progress.updatedAt,
    };
}

async function identityFor(input: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
}) {
    return resolveAuthorizedPlayerIdentity(input);
}

function identityRequired() {
    return {
        status: 401,
        body: { error: 'Player identity is required for Campaign competition.' },
    };
}

async function readCampaignStandingsByRaceId(playerId: string | null) {
    const entries = await Promise.all(CAMPAIGN_STAGES.map(async (stage) => {
        const competition = competitionFor(stage, playerId);
        const [totalCount, rank] = await Promise.all([
            redis.zCard(competition.leaderboardKey),
            readPlayerRank(competition, playerId),
        ]);
        return [stage.raceId, { rank, totalCount: totalCount || 0 }] as const;
    }));
    return Object.fromEntries(entries);
}

async function repairCampaignProgressFromLeaderboard(
    playerId: string,
    progress: CampaignProgress,
): Promise<CampaignProgress> {
    const missingStages = CAMPAIGN_STAGES.filter(
        (stage) => !progress.resultsByRaceId[stage.raceId],
    );
    if (!missingStages.length) return progress;

    const recovered = await Promise.all(missingStages.map(async (stage) => {
        const entry = await readEntryByPlayerId(
            competitionFor(stage, playerId),
            playerId,
        );
        return campaignResultFromEntry(stage, entry, playerId);
    }));
    const recoveredResults = recovered.filter(
        (result): result is CampaignBestResult => result !== null,
    );
    if (!recoveredResults.length) return progress;

    return mutateProgress(playerId, (freshProgress) => {
        const resultsByRaceId = { ...freshProgress.resultsByRaceId };
        let changed = false;
        for (const result of recoveredResults) {
            if (resultsByRaceId[result.raceId]) continue;
            resultsByRaceId[result.raceId] = result;
            changed = true;
        }
        if (!changed) return freshProgress;
        const nowIso = new Date().toISOString();
        return {
            campaignId: CAMPAIGN_ID,
            startedAt: freshProgress.startedAt || nowIso,
            resultsByRaceId,
            updatedAt: nowIso,
        } satisfies CampaignProgress;
    });
}

export async function repairCampaignStandingsFromEntries(playerId: string): Promise<void> {
    for (const stage of CAMPAIGN_STAGES) {
        const competition = competitionFor(stage, playerId);
        const [entry, rankedScore] = await Promise.all([
            readEntryByPlayerId(competition, playerId),
            redis.zScore(competition.leaderboardKey, playerId),
        ]);
        if (!entry || Number(rankedScore) === entry.bestTimeMs) continue;

        const lock = await acquireRedisLock(
            competitionSubmissionLockKey(competition, playerId),
            SUBMISSION_LOCK_TTL_MS,
            redis,
        );
        if (!lock) continue;
        try {
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) continue;
            const [currentEntry, currentRankedScore] = await Promise.all([
                readEntryByPlayerId(competition, playerId),
                redis.zScore(competition.leaderboardKey, playerId),
            ]);
            if (!currentEntry || Number(currentRankedScore) === currentEntry.bestTimeMs) {
                await transaction.unwatch();
                continue;
            }
            await writeEntry(competition, playerId, currentEntry, transaction);
            const results = await transaction.exec();
            if (!Array.isArray(results) || results.length === 0) {
                console.error(`Campaign standings repair was interrupted: ${stage.raceId}`);
            }
        } catch (error) {
            console.error(`Campaign standings repair failed: ${stage.raceId}`, error);
        } finally {
            await releaseRedisLock(lock, redis).catch((error) => {
                console.error('Campaign standings repair lock cleanup failed:', error);
            });
        }
    }
}

export async function getServerCampaignBootstrap({
    playerId,
    redditUsername,
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    const canonicalPlayerId = identity.canonicalPlayerId;
    let guestPromotionPending = identity.guestStatus === 'guest_promotion_pending';
    let campaignProgressPromotionPending = false;
    await cleanupExpiredCampaignGuestsBestEffort();

    if (canonicalPlayerId?.startsWith('reddit:') && !guestPromotionPending) {
        const guestPlayerId = await verifyGuestPlayerToken(guestToken);
        if (guestPlayerId) {
            const promotedTo = await readGuestPromotionTarget(`guest:${guestPlayerId}`);
            guestPromotionPending = !promotedTo;
            campaignProgressPromotionPending = guestPromotionPending;
        }
    }

    const progress = canonicalPlayerId && !guestPromotionPending
        ? await readProgress(canonicalPlayerId).then((current) => (
            repairCampaignProgressFromLeaderboard(canonicalPlayerId, current)
        ))
        : emptyProgress();
    if (canonicalPlayerId && !guestPromotionPending) await repairCampaignStandingsFromEntries(canonicalPlayerId);
    const standingsByRaceId = await readCampaignStandingsByRaceId(canonicalPlayerId && !guestPromotionPending ? canonicalPlayerId : null);
    const carUnlocks = canonicalPlayerId && !guestPromotionPending
        ? await getCarUnlockSnapshot(canonicalPlayerId, progress.resultsByRaceId)
        : null;
    return {
        status: 200,
        body: {
            campaignId: CAMPAIGN_ID,
            ranked: Boolean(canonicalPlayerId && !guestPromotionPending),
            signedIn: Boolean(canonicalPlayerId?.startsWith('reddit:')),
            guestPromotionPending,
            campaignProgressPromotionPending,
            progressSelectionRequired: guestPromotionPending,
            stages: CAMPAIGN_STAGES,
            progress: publicProgress(progress),
            standingsByRaceId,
            carUnlocks,
        },
    };
}

export async function startServerCampaignRace({
    raceId,
    playerId,
    redditUsername,
    guestToken,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) return identityRequired();
    const progressTransferPending = identity.guestStatus === 'guest_promotion_pending'
        || (identity.canonicalPlayerId.startsWith('reddit:')
            && await isPlayerProgressSelectionPending(identity.canonicalPlayerId));
    if (progressTransferPending) {
        return {
            status: 409,
            body: {
                error: 'Choose which progress to keep before starting a ranked Campaign race.',
                reason: 'progress_selection_required',
            },
        };
    }
    await cleanupExpiredCampaignGuestsBestEffort();
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const progress = await readProgress(identity.canonicalPlayerId);
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { error: 'Campaign race is locked.' } };
    }
    let startedProgress: CampaignProgress;
    try {
        startedProgress = await mutateProgress(identity.canonicalPlayerId, (freshProgress) => {
            const nowIso = new Date().toISOString();
            return freshProgress.startedAt
                ? freshProgress
                : { ...freshProgress, startedAt: nowIso, updatedAt: nowIso };
        });
    } catch (error) {
        if (error instanceof CampaignProgressBusyError) {
            return { status: 503, body: { error: 'Campaign progress is busy. Try again.' } };
        }
        throw error;
    }
    return { status: 200, body: { race: stage, progress: publicProgress(startedProgress) } };
}

function normalizeLimit(value: unknown): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? Math.min(MAX_LIMIT, Math.max(1, parsed)) : DEFAULT_LIMIT;
}

function normalizeOffset(value: unknown): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? Math.max(0, parsed) : 0;
}

export async function getServerCampaignSnapshot({
    raceId,
    playerId,
    redditUsername,
    guestToken,
    limit,
    offset,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    limit?: unknown;
    offset?: unknown;
} = {}) {
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    await cleanupExpiredCampaignGuestsBestEffort();
    const snapshot = await readSnapshot({
        competition: competitionFor(stage, identity.canonicalPlayerId),
        playerId: identity.canonicalPlayerId,
        limit: normalizeLimit(limit),
        offset: normalizeOffset(offset),
    });
    return { status: 200, body: { race: stage, ...snapshot } };
}

export async function prepareServerCampaignLeaderboardRace({
    raceId,
    playerId,
    redditUsername,
    guestToken,
    selection,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    selection?: unknown;
}) {
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.', reason: 'race_not_found' } };
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    await cleanupExpiredCampaignGuestsBestEffort();
    if (identity.canonicalPlayerId) {
        const progress = await readProgress(identity.canonicalPlayerId);
        if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
            return { status: 403, body: { error: 'Campaign race is locked.', reason: 'race_locked' } };
        }
    }
    return prepareCompetitionOpponentRace({
        competition: competitionFor(stage, identity.canonicalPlayerId),
        playerId: identity.canonicalPlayerId,
        race: stage,
        selection,
    });
}

export async function submitServerCampaignRun({
    raceId,
    trackKey,
    replay,
    playerId,
    redditUsername,
    guestToken,
    requestRateLimitIdentity,
    submissionOwnerId,
}: {
    raceId?: unknown;
    trackKey?: unknown;
    replay?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    requestRateLimitIdentity?: unknown;
    submissionOwnerId?: unknown;
} = {}, reuse?: RankedSubmitReuseOptions) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) {
        return {
            status: 401,
            body: { accepted: false, error: 'Player identity is required to submit Campaign results.' },
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
    // Checked before the stage lock, so a result queued under another account is never mistaken for a locked stage.
    if (isMismatchedSubmissionOwner(identity.canonicalPlayerId, submissionOwnerId)) {
        return SUBMISSION_IDENTITY_CHANGED_RESULT;
    }
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { accepted: false, error: 'Campaign race not found.' } };

    const canonicalPlayerId = identity.canonicalPlayerId;
    const progress = await readProgress(canonicalPlayerId);
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { accepted: false, error: 'Campaign race is locked.' } };
    }

    const competition = competitionFor(stage, canonicalPlayerId);
    const outcome = await submitCompetitionRun({
        competition,
        playerId: canonicalPlayerId,
        redditUsername,
        trackKey,
        replay,
        requestRateLimitIdentity,
    }, reuse);
    if (outcome.status !== 200 || !(outcome.body as { accepted?: boolean }).accepted) {
        return { status: outcome.status, body: outcome.body };
    }

    try {
        recordAnalyticsRaceBestEffort('campaign', 'finish', identity.canonicalPlayerId);

        const body = outcome.body as {
            accepted: true;
            improved: boolean;
            bestTimeMs: number;
            checkpointTimesSec: number[] | null;
        };
        const nowIso = new Date().toISOString();
        const result: CampaignBestResult = {
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            lapCount: stage.lapCount,
            rulesRevision: stage.rulesRevision,
            bestTimeMs: body.bestTimeMs,
            medal: getMedalForRaceTime(stage.trackKey, body.bestTimeMs / 1000, stage.lapCount),
            checkpointTimesSec: body.checkpointTimesSec,
            updatedAt: nowIso,
        };
        let savedProgress: CampaignProgress;
        try {
            savedProgress = await mutateProgress(canonicalPlayerId, (freshProgress) => {
                const previous = freshProgress.resultsByRaceId[stage.raceId] ?? null;
                if (previous && previous.bestTimeMs <= body.bestTimeMs) return freshProgress;
                return {
                    campaignId: CAMPAIGN_ID,
                    startedAt: freshProgress.startedAt || nowIso,
                    resultsByRaceId: { ...freshProgress.resultsByRaceId, [stage.raceId]: result },
                    updatedAt: nowIso,
                } satisfies CampaignProgress;
            });
        } catch (error) {
            if (error instanceof CampaignProgressBusyError) {
                return {
                    status: 503,
                    body: { accepted: false, error: 'Campaign progress save was interrupted. Retry.' },
                };
            }
            throw error;
        }

        const confirmedResult = savedProgress.resultsByRaceId[stage.raceId];
        if (!confirmedResult || confirmedResult.bestTimeMs > body.bestTimeMs) {
            return {
                status: 503,
                body: { accepted: false, error: 'Campaign progress save was interrupted. Retry.' },
            };
        }

        // The progress is saved, and it is the record the Keep Progress chooser reads. Neither job
        // below can unsave it, so each settles on its own and only what failed is left out.
        const [carUnlocks, reward] = await Promise.allSettled([
            getCarUnlockSnapshot(
                canonicalPlayerId,
                savedProgress.resultsByRaceId,
                redis,
                true,
            ),
            recordCompletedRace(canonicalPlayerId),
        ]);
        if (carUnlocks.status === 'rejected') {
            console.error('Campaign run saved, but its Garage could not be read:', carUnlocks.reason);
        }
        if (reward.status === 'rejected') {
            console.error('Campaign run saved, but its completed-race reward failed:', reward.reason);
        }

        return {
            status: 200,
            body: {
                ...outcome.body as Record<string, unknown>,
                progress: publicProgress(savedProgress),
                // This Garage counts the finish before the reward is stored. Without the reward,
                // the next start-up could lock the car again, so the answer shows no Garage at all.
                ...(carUnlocks.status === 'fulfilled' && reward.status === 'fulfilled'
                    ? { carUnlocks: carUnlocks.value }
                    : {}),
            },
        };
    } finally {
        await outcome.releaseLock;
    }
}

export async function getServerCampaignPbGhost({
    raceId,
    playerId,
    redditUsername,
    guestToken,
}: {
    raceId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) return identityRequired();
    await cleanupExpiredCampaignGuestsBestEffort();
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const personalBest = await getPlayerTrackPbRecord({
        playerId: identity.canonicalPlayerId,
        competition: competitionFor(stage, identity.canonicalPlayerId),
        track: TRACKS[stage.trackKey],
    });
    return {
        status: 200,
        body: {
            campaignId: CAMPAIGN_ID,
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            personalBest,
        },
    };
}

type GuestCampaignStageSource = {
    /** The three values the recorded inventory fingerprints, exactly as read. */
    rawEntry: string | null;
    rank: number | null;
    entry: DailyGpLeaderboardEntry | null;
    entryClass: StoredRecordClassification<unknown>;
    pb: PlayerTrackPbRecord | null;
    pbClass: StoredRecordClassification<PlayerTrackPbRecord>;
    /**
     * The personal best exactly as it was validated, before compression. The copy re-encodes this
     * rather than reading the field again, so the bytes written are the bytes that were judged.
     */
    rawPb: string | null;
};

type GuestCampaignSourceSnapshot = {
    progress: CampaignProgress;
    stages: Map<string, GuestCampaignStageSource>;
    /** The progress row exactly as read, for the inventory check. */
    rawProgress: string | null;
    /** Domain and reason for every row a person has to look at. Never carries player data. */
    malformed: string[];
    /** Rows a supported campaign, track, or simulation change made unusable. */
    obsolete: string[];
    /** Newest usable timestamp anywhere in the source. Retention for a held source derives from it. */
    newestUpdatedAt: string | null;
};

/**
 * Reads the guest's whole Campaign source once and classifies every row in it.
 *
 * Two reasons this is one pass, taken before the loop rather than inside it:
 *
 * 1. Every row must be judged before the first destination write. A malformed row found halfway
 *    through would otherwise stop a replacement that had already emptied earlier stages.
 * 2. The copy then runs from this snapshot. Re-reading the source after validating it would let
 *    a row that expired in between be copied as absent, which under `replace` deletes the
 *    account's row instead.
 *
 * The read count matches what the loop used to do on its own: one entry and one personal best
 * per stage, plus the progress row.
 */
async function captureClassifiedGuestCampaignSource(
    guestPlayerId: string,
): Promise<GuestCampaignSourceSnapshot> {
    const malformed: string[] = [];
    const obsolete: string[] = [];
    let newestUpdatedAt: string | null = null;
    const observeTimestamp = (value: string | null | undefined) => {
        if (!value) return;
        const parsed = Date.parse(value);
        if (!Number.isFinite(parsed)) return;
        if (!newestUpdatedAt || parsed > Date.parse(newestUpdatedAt)) newestUpdatedAt = value;
    };

    const rawProgress = await redis.get(progressKey(guestPlayerId));
    // Taken from the stored value itself, so a record that is damaged elsewhere still dates the
    // source it belongs to. This is what a held source's retention deadline is derived from.
    observeTimestamp(readStoredUpdatedAt(rawProgress));
    const progressClass = classifyStoredCampaignProgress(rawProgress);
    if (progressClass.state === 'malformed') {
        malformed.push(`campaign:progress:${progressClass.reason}`);
    } else if (progressClass.state === 'valid') {
        for (const row of Object.values(progressClass.record.rows)) observeTimestamp(row.updatedAt);
        for (const raceId of progressClass.record.obsoleteRaceIds) {
            obsolete.push(`campaign:progress:${raceId}`);
        }
    }

    const stages = new Map<string, GuestCampaignStageSource>();
    for (const stage of CAMPAIGN_STAGES) {
        const competition = competitionFor(stage, guestPlayerId);
        const [rawEntry, rawPb, rank] = await Promise.all([
            redis.hGet(competition.entryHashKey, guestPlayerId),
            redisCompressed.hGet(competition.pbHashKey, playerField(guestPlayerId)),
            typeof redis.zScore === 'function'
                ? redis.zScore(competition.leaderboardKey, guestPlayerId)
                : Promise.resolve(null),
        ]);
        const pbClass = classifyStoredPbRecordFor(rawPb, competition, TRACKS[stage.trackKey]);
        const entryClass = classifyStoredLeaderboardEntry(rawEntry, guestPlayerId, stage);
        observeTimestamp(readStoredUpdatedAt(rawEntry));
        observeTimestamp(readStoredUpdatedAt(rawPb));
        if (entryClass.state === 'malformed') {
            malformed.push(`campaign:entry:${stage.raceId}:${entryClass.reason}`);
        } else if (entryClass.state === 'obsolete') {
            obsolete.push(`campaign:entry:${stage.raceId}:${entryClass.reason}`);
        }
        if (pbClass.state === 'malformed') {
            malformed.push(`campaign:pb:${stage.raceId}:${pbClass.reason}`);
        } else if (pbClass.state === 'obsolete') {
            obsolete.push(`campaign:pb:${stage.raceId}:${pbClass.reason}`);
        }
        stages.set(stage.raceId, {
            rawEntry: rawEntry ?? null,
            rank: rank ?? null,
            // Parsed from the raw value already read, so this costs no extra round trip.
            entry: entryClass.state === 'valid'
                ? parseStoredEntry(rawEntry, stage.trackKey)
                : null,
            entryClass,
            pb: pbClass.state === 'valid' ? pbClass.record : null,
            pbClass,
            rawPb: rawPb ?? null,
        });
    }

    return {
        progress: parseCampaignProgress(rawProgress),
        rawProgress: rawProgress ?? null,
        stages,
        malformed,
        obsolete,
        newestUpdatedAt,
    };
}

export async function mergeGuestCampaignProgress({
    guestPlayerId,
    redditPlayerId,
    replace = false,
    verifyGuestSource,
    transactionRunner,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    replace?: boolean;
    /**
     * Called once the guest submission and progress locks are held, and before the first account
     * write. A transfer uses it to prove the source still matches the inventory it recorded.
     *
     * A replacing merge hands over the exact rows it is about to copy, so the check and the copy
     * cannot see different data. Anything else calls it with nothing and lets it read for itself.
     */
    verifyGuestSource?: (observed?: {
        campaignProgress: string | null;
        campaignStages: Record<string, { entry: string | null; pb: string | null; rank: number | null }>;
    }) => void | Promise<void>;
    transactionRunner?: RedisLockTransactionRunner;
}): Promise<{ merged: boolean; mergedRaceIds: string[] }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return { merged: false, mergedRaceIds: [] };
    }

    const locks: RedisLock[] = [];
    let lease: RedisLockLease | null = null;
    const acquireAll = async (keys: string[], ttlMs: number) => {
        for (const key of [...new Set(keys)].sort()) {
            const lock = await acquireRedisLock(key, ttlMs, redis);
            if (!lock) throw new CampaignProgressBusyError('Campaign merge is already in progress.');
            locks.push(lock);
        }
    };
    const confirmMergeOwnership = async () => {
        if (!lease || !await lease.confirmOwnership()) {
            throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
        }
    };
    const runMutation = async (
        domainLocks: readonly RedisLock[],
        mutate: RedisLockMutation,
    ): Promise<void> => {
        if (transactionRunner) {
            const activeLease = lease;
            lease = null;
            if (activeLease) {
                await activeLease.stop().catch((error) => {
                    console.error('Campaign merge lease pause failed:', error);
                });
            }
            await transactionRunner(domainLocks, mutate);
            lease = startRedisLockGroupLeaseRenewal(
                locks,
                Math.max(1, Math.floor(SUBMISSION_LOCK_TTL_MS / 3)),
                redis,
            );
            return;
        }
        const lock = domainLocks[0];
        if (!lock) throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
        await mutate(transaction);
        if (!await commitOwnedRedisLockTransaction(transaction)) {
            throw new CampaignProgressBusyError('Campaign leaderboard copy was interrupted.');
        }
    };
    try {
        // Match submission's lock order: stage writes finish before either progress record is claimed.
        await acquireAll(CAMPAIGN_STAGES.flatMap((stage) => {
            const competition = competitionFor(stage, null);
            return [
                competitionSubmissionLockKey(competition, guestPlayerId),
                competitionSubmissionLockKey(competition, redditPlayerId),
            ];
        }), SUBMISSION_LOCK_TTL_MS);
        await acquireAll([
            progressLockKey(guestPlayerId),
            progressLockKey(redditPlayerId),
        ], CAMPAIGN_PROGRESS_LOCK_TTL_MS);
        lease = startRedisLockGroupLeaseRenewal(
            locks,
            Math.max(1, Math.floor(SUBMISSION_LOCK_TTL_MS / 3)),
            redis,
        );
        await confirmMergeOwnership();

        // Read and judge the entire guest source before anything else. Everything below - the
        // inventory check and the copy alike - works from this one snapshot, so the payload that
        // is checked against the recorded inventory is the payload that gets written. Reading the
        // source again between those two steps is what let an expiry in between be copied as
        // absent, which under `replace` empties the account instead.
        const guestSource = replace
            ? await captureClassifiedGuestCampaignSource(guestPlayerId)
            : null;
        // Damage is reported before the inventory check. The two stop the transfer for different
        // reasons, and a damaged row that never moved would otherwise be reported as a changed
        // source, which sends a reviewer looking for a change that did not happen.
        if (guestSource?.malformed.length) {
            // The source stays for a reviewer, so it must still be enrolled for collection.
            // A guest with rows but no progress row was never enrolled by ordinary play.
            await ensureGuestCampaignRetention(guestPlayerId, guestSource.newestUpdatedAt);
            throw new GuestProgressRecoveryRequiredError(
                `Campaign guest source needs review: ${guestSource.malformed.join(', ')}`,
            );
        }
        if (guestSource) {
            await verifyGuestSource?.({
                campaignProgress: guestSource.rawProgress,
                campaignStages: Object.fromEntries(
                    [...guestSource.stages].map(([raceId, source]) => [raceId, {
                        entry: source.rawEntry,
                        pb: source.rawPb,
                        rank: source.rank,
                    }]),
                ),
            });
        } else {
            await verifyGuestSource?.();
        }

        const guestProgressLock = locks.find((lock) => lock.key === progressLockKey(guestPlayerId))!;
        const redditProgressLock = locks.find((lock) => lock.key === progressLockKey(redditPlayerId))!;
        const [guestProgress, redditProgress] = await Promise.all([
            guestSource ? Promise.resolve(guestSource.progress) : readProgress(guestPlayerId),
            readProgress(redditPlayerId),
        ]);
        const mergedResults = replace
            ? Object.create(null)
            : { ...redditProgress.resultsByRaceId };
        const mergedRaceIds: string[] = [];
        let hasGuestEvidence = Boolean(
            guestProgress.startedAt
            || Object.keys(guestProgress.resultsByRaceId).length > 0
        );
        for (const stage of CAMPAIGN_STAGES) {
            await confirmMergeOwnership();
            const guestCompetition = competitionFor(stage, guestPlayerId);
            const redditCompetition = competitionFor(stage, redditPlayerId);
            // Guest values come from the validated snapshot when one was taken. Only the account
            // side is read here, so the source cannot change between its check and its copy.
            const stageSource = guestSource?.stages.get(stage.raceId);
            const [snapshotlessGuestEntry, redditEntry, snapshotlessGuestPb, redditPb, redditRankedScore] = await Promise.all([
                guestSource
                    ? Promise.resolve(null)
                    : readEntryByPlayerId(guestCompetition, guestPlayerId),
                readEntryByPlayerId(redditCompetition, redditPlayerId),
                guestSource
                    ? Promise.resolve(null)
                    : getPlayerTrackPbRecord({
                        playerId: guestPlayerId,
                        competition: guestCompetition,
                        track: TRACKS[stage.trackKey],
                    }),
                getPlayerTrackPbRecord({
                    playerId: redditPlayerId,
                    competition: redditCompetition,
                    track: TRACKS[stage.trackKey],
                }),
                redis.zScore(redditCompetition.leaderboardKey, redditPlayerId),
            ]);
            const guestEntry = guestSource ? (stageSource?.entry ?? null) : snapshotlessGuestEntry;
            const guestPb = guestSource ? (stageSource?.pb ?? null) : snapshotlessGuestPb;
            const guestEntryResult = campaignResultFromEntry(
                stage,
                guestEntry,
                guestPlayerId,
            );
            const redditEntryResult = campaignResultFromEntry(
                stage,
                redditEntry,
                redditPlayerId,
            );
            hasGuestEvidence ||= Boolean(guestEntryResult || guestPb);
            const guestResult = fasterCampaignResult(
                guestProgress.resultsByRaceId[stage.raceId],
                guestEntryResult,
            );
            const redditResult = fasterCampaignResult(
                redditProgress.resultsByRaceId[stage.raceId],
                redditEntryResult,
            );
            const guestWins = replace
                ? Boolean(guestResult)
                : Boolean(
                    guestResult
                    && (!redditResult || guestResult.bestTimeMs < redditResult.bestTimeMs),
                );
            const guestCanSupplyWinningPb = replace
                ? Boolean(guestPb)
                : Boolean(guestPb && (!redditPb || guestPb.bestTimeMs < redditPb.bestTimeMs));
            const selectedResult = replace ? guestResult : fasterCampaignResult(redditResult, guestResult);
            if (selectedResult) {
                mergedResults[stage.raceId] = selectedResult;
            }
            if (guestWins && guestResult) {
                mergedRaceIds.push(stage.raceId);
            }
            const guestEntryWins = replace
                ? Boolean(guestEntry && guestEntryResult)
                : Boolean(
                    guestEntry
                    && guestEntryResult
                    && (!redditEntryResult || guestEntry.bestTimeMs < redditEntryResult.bestTimeMs)
                );
            const entryToWrite = replace && guestResult && !guestEntry
                ? {
                    playerId: redditPlayerId,
                    trackKey: stage.trackKey,
                    bestTimeMs: guestResult.bestTimeMs,
                    updatedAt: guestResult.updatedAt,
                    completedLaps: stage.lapCount,
                    checkpointTimesSec: guestResult.checkpointTimesSec,
                    validationMethod: 'strict-replay' as const,
                }
                : guestEntryWins
                    ? { ...guestEntry!, playerId: redditPlayerId }
                : (!replace && redditEntry && redditEntryResult && Number(redditRankedScore) !== redditEntry.bestTimeMs
                    ? redditEntry
                    : null);
            const accountEntryLock = locks.find((lock) => (
                lock.key === competitionSubmissionLockKey(redditCompetition, redditPlayerId)
            ));
            if (transactionRunner) {
                if (!accountEntryLock) throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
                let rawGuestPb: string | undefined;
                if (guestCanSupplyWinningPb) {
                    // From the validated snapshot when there is one, re-encoded the way the
                    // compressing client would have. Reading the field again here would let a row
                    // that expired since validation be copied as absent.
                    const validated = guestSource ? stageSource?.rawPb ?? null : null;
                    rawGuestPb = validated !== null
                        ? encodeRedisCompressedValue(validated)
                        : await redis.hGet(guestCompetition.pbHashKey, playerField(guestPlayerId));
                    if (!rawGuestPb) {
                        throw new Error(`Campaign guest PB disappeared during promotion: ${stage.raceId}`);
                    }
                }
                if (entryToWrite || replace || rawGuestPb) {
                    await runMutation([accountEntryLock], async (transaction) => {
                        if (entryToWrite) {
                            await writeEntry(redditCompetition, redditPlayerId, entryToWrite, transaction);
                        } else if (replace) {
                            await transaction.hDel(redditCompetition.entryHashKey, [redditPlayerId]);
                            await transaction.zRem(redditCompetition.leaderboardKey, [redditPlayerId]);
                            await transaction.incrBy(redditCompetition.standingsRevisionKey, 1);
                        }
                        if (rawGuestPb) {
                            await transaction.hSet(redditCompetition.pbHashKey, {
                                [playerField(redditPlayerId)]: rawGuestPb,
                            });
                        } else if (replace) {
                            await transaction.hDel(redditCompetition.pbHashKey, [playerField(redditPlayerId)]);
                        }
                    });
                }
            } else {
                if (entryToWrite || replace) {
                    if (!accountEntryLock) throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
                    const transaction = await beginOwnedRedisLockTransaction(accountEntryLock, redis);
                    if (!transaction) throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
                    if (entryToWrite) {
                        await writeEntry(redditCompetition, redditPlayerId, entryToWrite, transaction);
                    } else {
                        await transaction.hDel(redditCompetition.entryHashKey, [redditPlayerId]);
                        await transaction.zRem(redditCompetition.leaderboardKey, [redditPlayerId]);
                        await transaction.incrBy(redditCompetition.standingsRevisionKey, 1);
                    }
                    if (!await commitOwnedRedisLockTransaction(transaction)) {
                        throw new CampaignProgressBusyError('Campaign leaderboard copy was interrupted.');
                    }
                }
                if (guestCanSupplyWinningPb) {
                    const rawGuestPb = guestSource
                        ? stageSource?.rawPb ?? null
                        : await redisCompressed.hGet(
                            guestCompetition.pbHashKey,
                            playerField(guestPlayerId),
                        );
                    if (!rawGuestPb) {
                        throw new Error(`Campaign guest PB disappeared during promotion: ${stage.raceId}`);
                    }
                    await redisCompressed.hSet(redditCompetition.pbHashKey, {
                        [playerField(redditPlayerId)]: rawGuestPb,
                    });
                } else if (replace) {
                    await redisCompressed.hDel(redditCompetition.pbHashKey, [playerField(redditPlayerId)]);
                }
            }
        }

        if (!hasGuestEvidence && !replace) return { merged: false, mergedRaceIds: [] };

        await confirmMergeOwnership();
        const nowIso = new Date().toISOString();
        await writeProgressWithOwnedLock(redditPlayerId, {
            campaignId: CAMPAIGN_ID,
            startedAt: replace
                ? (guestProgress.startedAt || null)
                : (redditProgress.startedAt || guestProgress.startedAt || nowIso),
            resultsByRaceId: mergedResults,
            updatedAt: nowIso,
        }, redditProgressLock, transactionRunner ? runMutation : undefined);

        // Keep the guest source until the transfer coordinator checkpoints the whole
        // domain. A later retry must be able to reconstruct replacement progress if
        // another domain or its checkpoint fails.
        return { merged: mergedRaceIds.length > 0, mergedRaceIds };
    } finally {
        if (lease) {
            await lease.stop().catch((error) => {
                console.error('Campaign merge lease cleanup failed:', error);
            });
        }
        await releaseRedisLockGroup(locks, 'Campaign merge', redis);
    }
}

export async function cleanupGuestCampaignProgress({
    guestPlayerId,
}: {
    guestPlayerId: string;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const locks: RedisLock[] = [];
    let lease: RedisLockLease | null = null;
    try {
        for (const key of CAMPAIGN_STAGES.flatMap((stage) => {
            const competition = competitionFor(stage, null);
            return [competitionSubmissionLockKey(competition, guestPlayerId)];
        }).concat(progressLockKey(guestPlayerId)).sort()) {
            const lock = await acquireRedisLock(key, SUBMISSION_LOCK_TTL_MS, redis);
            if (!lock) throw new CampaignProgressBusyError('Campaign cleanup is already in progress.');
            locks.push(lock);
            // Start renewing as soon as the first lock is acquired. The array is
            // intentionally shared so newly acquired locks join the lease.
            lease ??= startRedisLockGroupLeaseRenewal(
                locks,
                CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS,
                redis,
            );
        }
        const progressLock = locks.find((lock) => lock.key === progressLockKey(guestPlayerId));
        if (!progressLock) throw new CampaignProgressBusyError('Campaign cleanup lock was lost.');
        const hadProgress = Boolean(await redis.get(progressKey(guestPlayerId)));
        if (!lease || !await lease.confirmOwnership()) {
            throw new CampaignProgressBusyError('Campaign cleanup ownership was lost.');
        }
        await lease.stop().catch((error) => {
            console.error('Campaign cleanup lease pause failed:', error);
        });
        lease = null;
        if (!await renewRedisLockGroup(locks, redis)) {
            throw new CampaignProgressBusyError('Campaign cleanup ownership was lost.');
        }
        const transaction = await beginOwnedRedisLockGroupTransaction(locks, redis);
        if (!transaction) throw new CampaignProgressBusyError('Campaign cleanup lock was lost.');
        for (const stage of CAMPAIGN_STAGES) {
            const competition = competitionFor(stage, guestPlayerId);
            await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
            await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
            await transaction.hDel(competition.pbHashKey, [playerField(guestPlayerId)]);
            await transaction.incrBy(competition.standingsRevisionKey, 1);
        }
        await transaction.del(progressKey(guestPlayerId));
        await transaction.zRem(CAMPAIGN_GUEST_EXPIRY_KEY, [guestPlayerId]);
        if (!await commitOwnedRedisLockTransaction(transaction)) {
            throw new CampaignProgressBusyError('Campaign cleanup was interrupted.');
        }
        return hadProgress;
    } finally {
        if (lease) {
            await lease.stop().catch((error) => {
                console.error('Campaign cleanup lease cleanup failed:', error);
            });
        }
        await releaseRedisLockGroup(locks, 'Campaign cleanup', redis);
    }
}

export async function discardGuestCampaignProgress({
    guestPlayerId,
}: {
    guestPlayerId: string;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const locks: RedisLock[] = [];
    let lease: RedisLockLease | null = null;
    try {
        for (const key of CAMPAIGN_STAGES.flatMap((stage) => {
            const competition = competitionFor(stage, null);
            return [
                competitionSubmissionLockKey(competition, guestPlayerId),
            ];
        }).concat(progressLockKey(guestPlayerId)).sort()) {
            const lock = await acquireRedisLock(key, SUBMISSION_LOCK_TTL_MS, redis);
            if (!lock) throw new CampaignProgressBusyError('Campaign discard is already in progress.');
            locks.push(lock);
            lease ??= startRedisLockGroupLeaseRenewal(
                locks,
                CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS,
                redis,
            );
        }
        const progressLock = locks.find((lock) => lock.key === progressLockKey(guestPlayerId));
        if (!progressLock) throw new CampaignProgressBusyError('Campaign discard lock was lost.');
        const hadProgress = Boolean(await redis.get(progressKey(guestPlayerId)));
        if (!lease || !await lease.confirmOwnership()) {
            throw new CampaignProgressBusyError('Campaign discard ownership was lost.');
        }
        await lease.stop().catch((error) => {
            console.error('Campaign discard lease pause failed:', error);
        });
        lease = null;
        if (!await renewRedisLockGroup(locks, redis)) {
            throw new CampaignProgressBusyError('Campaign discard ownership was lost.');
        }
        // The lease is stopped for the writes below, so the group is refreshed on the same
        // cadence it would have renewed on. On a fast store this never fires.
        let renewedAtMs = Date.now();
        const keepLocksFresh = async (): Promise<void> => {
            if (Date.now() - renewedAtMs < CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS) return;
            if (!await renewRedisLockGroup(locks, redis)) {
                throw new CampaignProgressBusyError('Campaign discard ownership was lost.');
            }
            renewedAtMs = Date.now();
        };
        const commit = async (mutate: RedisLockMutation): Promise<void> => {
            const transaction = await beginOwnedRedisLockGroupTransaction(locks, redis);
            if (!transaction) throw new CampaignProgressBusyError('Campaign discard lock was lost.');
            await mutate(transaction);
            if (!await commitOwnedRedisLockTransaction(transaction)) {
                throw new CampaignProgressBusyError('Campaign discard was interrupted.');
            }
        };

        // One sweep decides which boards still hold this guest. A stage the guest never raced
        // needs no transaction and no standings bump, and a stage a previous attempt already
        // cleared reads empty — so a retry resumes here instead of repeating the whole campaign.
        const stagesToClear = (await Promise.all(CAMPAIGN_STAGES.map(async (stage) => {
            // Raw presence, not a parsed record: this sweep decides what never gets deleted, and
            // the progress record that would prompt a retry is removed once it finishes. An entry
            // that no longer parses, a PB from a superseded track revision, and a ranking left
            // without its entry are all still this guest's rows to take with them.
            const holdsRows = await competitionHoldsPlayerRows(
                competitionFor(stage, guestPlayerId),
                guestPlayerId,
            );
            return holdsRows ? stage : null;
        }))).filter((stage): stage is (typeof CAMPAIGN_STAGES)[number] => stage !== null);

        // One stage per transaction. Queuing every stage into a single MULTI held it open
        // across the whole campaign, and a store that timed that out failed all of it.
        for (const stage of stagesToClear) {
            await keepLocksFresh();
            const competition = competitionFor(stage, guestPlayerId);
            await commit(async (transaction) => {
                await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
                await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
                await transaction.hDel(competition.pbHashKey, [playerField(guestPlayerId)]);
                await transaction.incrBy(competition.standingsRevisionKey, 1);
            });
        }

        // Last, so the progress record still names an unfinished discard for any retry.
        await keepLocksFresh();
        await commit(async (transaction) => {
            await transaction.del(progressKey(guestPlayerId));
            await transaction.zRem(CAMPAIGN_GUEST_EXPIRY_KEY, [guestPlayerId]);
        });
        return hadProgress;
    } finally {
        if (lease) {
            await lease.stop().catch((error) => {
                console.error('Campaign discard lease cleanup failed:', error);
            });
        }
        await releaseRedisLockGroup(locks, 'Campaign discard', redis);
    }
}
