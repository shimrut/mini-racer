import { redis } from '@devvit/redis';
import {
    CAMPAIGN_LIVE_STAGES,
    CAMPAIGN_NUMBERS_SERIES_ID,
    CAMPAIGN_SERIES,
    countCampaignMedals,
    getCampaignFinalStage,
    getCampaignSeries,
    getCampaignSeriesStages,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
    isCampaignSeriesFinished,
    isCampaignStageUnlocked,
} from '../../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../../game/medals/medal-timing.js';
import { TRACKS } from '../../../game/track/tracks.js';
import { loadStoredTracks } from '../tracks/stored-catalog.js';
import {
    CAMPAIGN_GUEST_EXPIRY_KEY,
    CAMPAIGN_GUEST_TTL_SECONDS,
    toCampaignCompetition,
    type Competition,
} from '../competition/competition.js';
import type { DailyGpLeaderboardEntry } from '../daily/daily-gp-model.js';
import {
    competitionHoldsPlayerRows,
    parseStoredEntry,
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
    writeEntry,
} from '../competition/competition-leaderboard.js';
import {
    classifyStoredCampaignProgress,
    classifyStoredLeaderboardEntry,
    readStoredUpdatedAt,
} from '../guest-transfer/guest-transfer-source-classification.js';
import { encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';
import { boardMergeWrite, decideBoardMerge, timeFitsBoard } from '../guest-transfer/board-merge.js';
import { campaignProgressKey } from './campaign-progress-key.js';
import { prepareCompetitionOpponentRace } from '../competition/competition-opponent-race.js';
import { resolveAuthorizedPlayerIdentity } from '../competition/competition-identity.js';
import { verifyGuestPlayerToken } from '../player/player-token.js';
import {
    competitionSubmissionLockKey,
    isMismatchedSubmissionOwner,
    submitCompetitionRun,
    SUBMISSION_IDENTITY_CHANGED_RESULT,
    SUBMISSION_LOCK_TTL_MS,
    type RankedSubmitReuseOptions,
} from '../competition/competition-submit.js';
import {
    classifyStoredPbRecordFor,
    getPlayerTrackPbRecord,
    type PlayerTrackPbRecord,
} from '../competition/pb-ghost-store.js';
import { redisCompressed } from '@devvit/redis';
import {
    getCarUnlockSnapshot,
    guestPromotionKey,
    readGuestPromotionTarget,
    recordCompletedRace,
} from '../player/car-unlock-store.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    commitOwnedRedisLockTransaction,
    createOwnedLockGroupRunner,
    releaseRedisLock,
    releaseRedisLockGroup,
    startRedisLockGroupLeaseRenewal,
    type RedisLock,
    type RedisLockLease,
    type RedisLockMutation,
    type RedisLockTransactionRunner,
} from '../redis/redis-lock.js';
import {
    GuestProgressRecoveryRequiredError,
    GuestProgressSelectionRetryableError,
} from '../guest-transfer/guest-progress-selection-error.js';
import { recordAnalyticsRaceBestEffort } from '../moderator/analytics-store.js';
import {
    guestProgressSelectionAccountPendingKey,
    guestProgressSelectionPendingKey,
    isPlayerProgressSelectionPending,
    isProgressTransferPending,
} from '../player/guest-retirement.js';
import { playerFieldHash } from '../redis/redis-names.js';
import { acquireRedisLockWithRetry } from '../redis/redis-lock-retry.js';
import { progressTransferPendingReply } from '../guest-transfer/progress-transfer-reply.js';
import { getCampaignAggregateTotalTimeMs } from '../../../game/campaign/aggregate.js';
import {
    campaignAggregateNeedsUpdate, queueCampaignAggregate, queueRemoveCampaignAggregate,
    readCampaignAggregateSnapshot, runCampaignAggregateFill,
} from './campaign-aggregate-store.js';

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

// One record for each series and player. `campaignId` holds the series name.
type CampaignProgress = {
    campaignId: string;
    startedAt: string | null;
    resultsByRaceId: Record<string, CampaignBestResult>;
    updatedAt: string | null;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const CAMPAIGN_PROGRESS_LOCK_TTL_MS = 30_000;
const CAMPAIGN_PROGRESS_LOCK_RETRY_DELAYS_MS = [5, 5, 5, 5];
const CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS = Math.max(
    1,
    Math.floor(CAMPAIGN_PROGRESS_LOCK_TTL_MS / 3),
);
// A copied stage queues 5 commands and a cleared one 4, so 4 stages fit the 24-command budget.
const CAMPAIGN_STAGES_PER_TRANSFER_WRITE = 4;
const CAMPAIGN_GUEST_CLEANUP_THROTTLE_SECONDS = 60;
const CAMPAIGN_GUEST_CLEANUP_LIMIT = 10;
export { CAMPAIGN_GUEST_EXPIRY_KEY };
const CAMPAIGN_GUEST_CLEANUP_THROTTLE_KEY = `${CAMPAIGN_GUEST_EXPIRY_KEY}:cleanup-throttle`;

const progressKey = campaignProgressKey;

function progressLockKey(playerId: string, seriesId: string): string {
    return `campaign:${seriesId}:progress-lock:${playerFieldHash(playerId)}`;
}

function allProgressLockKeys(playerId: string): string[] {
    return CAMPAIGN_SERIES.map((series) => progressLockKey(playerId, series.id));
}

type CampaignStage = (typeof CAMPAIGN_LIVE_STAGES)[number];

function isGuestPlayerId(playerId: string): boolean {
    return playerId.startsWith('guest:');
}

function guestExpiresAt(): Date {
    return new Date(Date.now() + CAMPAIGN_GUEST_TTL_SECONDS * 1000);
}

function competitionFor(stage: CampaignStage): Competition {
    return toCampaignCompetition(stage.seriesId, stage);
}

// The live stages in `raceIds`, in stage order, or all live stages.
function transferStages(raceIds?: readonly string[] | null): readonly CampaignStage[] {
    if (!raceIds) return CAMPAIGN_LIVE_STAGES;
    const named = new Set(raceIds);
    return CAMPAIGN_LIVE_STAGES.filter((stage) => named.has(stage.raceId));
}

// Each live stage's race-save lock per player; a transfer reads them to find a save that started first.
export function campaignSubmissionLockKeys(
    playerIds: readonly string[],
    raceIds?: readonly string[] | null,
): string[] {
    return transferStages(raceIds).flatMap((stage) => {
        const competition = competitionFor(stage);
        return playerIds.map((playerId) => competitionSubmissionLockKey(competition, playerId));
    });
}

function emptyProgress(seriesId: string): CampaignProgress {
    return {
        campaignId: seriesId,
        startedAt: null,
        resultsByRaceId: {},
        updatedAt: null,
    };
}

function parseBestResult(
    value: unknown,
    expectedRaceId: string | undefined,
    seriesId: string,
): CampaignBestResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Partial<CampaignBestResult>;
    const stage = getCampaignStage(row.raceId);
    if (
        !stage
        || stage.seriesId !== seriesId
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
    stage: CampaignStage,
    entry: DailyGpLeaderboardEntry | null,
    expectedPlayerId: string,
): CampaignBestResult | null {
    // As in a guest transfer, an early time without a lap count or check label still counts.
    if (
        !timeFitsBoard(entry, stage, expectedPlayerId)
        || !Number.isSafeInteger(entry.bestTimeMs)
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

export function parseCampaignProgress(
    raw: string | null | undefined,
    seriesId: string = CAMPAIGN_NUMBERS_SERIES_ID,
): CampaignProgress {
    if (!raw) return emptyProgress(seriesId);
    try {
        const value = JSON.parse(raw) as Partial<CampaignProgress>;
        if (value.campaignId !== seriesId) return emptyProgress(seriesId);
        const resultsByRaceId: Record<string, CampaignBestResult> = {};
        if (value.resultsByRaceId && typeof value.resultsByRaceId === 'object') {
            for (const [raceId, candidate] of Object.entries(value.resultsByRaceId)) {
                const result = parseBestResult(candidate, raceId, seriesId);
                if (result) resultsByRaceId[raceId] = result;
            }
        }
        return {
            campaignId: seriesId,
            startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
            resultsByRaceId,
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        };
    } catch (_error) {
        return emptyProgress(seriesId);
    }
}

async function readProgress(playerId: string, seriesId: string): Promise<CampaignProgress> {
    return parseCampaignProgress(await redis.get(progressKey(playerId, seriesId)), seriesId);
}

const STAGE_NUMBER_RE = /^\d{2,}$/;

// Rows for stages published after the request took its list: never progress, but writes keep them.
function unknownStageRows(raw: string | null | undefined, seriesId: string): Record<string, unknown> {
    if (!raw) return {};
    let value: { campaignId?: unknown; resultsByRaceId?: unknown };
    try {
        value = JSON.parse(raw);
    } catch (_error) {
        return {};
    }
    if (value?.campaignId !== seriesId) return {};
    const rows = value.resultsByRaceId;
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return {};
    const kept: Record<string, unknown> = {};
    const prefix = `${seriesId}-`;
    for (const [raceId, row] of Object.entries(rows)) {
        // Series names can prefix each other ("night", "night-v1"), so the rest must be the stage number.
        if (!raceId.startsWith(prefix) || !STAGE_NUMBER_RE.test(raceId.slice(prefix.length))) continue;
        if (!row || typeof row !== 'object' || (row as { raceId?: unknown }).raceId !== raceId) continue;
        if (getCampaignStage(raceId)) continue;
        kept[raceId] = row;
    }
    return kept;
}

// One read for a write: the verified progress, and the rows to keep unchanged.
async function readProgressForWrite(playerId: string, seriesId: string): Promise<{
    progress: CampaignProgress;
    unknownRows: Record<string, unknown>;
}> {
    const raw = await redis.get(progressKey(playerId, seriesId));
    return { progress: parseCampaignProgress(raw, seriesId), unknownRows: unknownStageRows(raw, seriesId) };
}

// The records of every live series, in series order.
async function readAllProgress(playerId: string): Promise<CampaignProgress[]> {
    return Promise.all(CAMPAIGN_SERIES.map((series) => readProgress(playerId, series.id)));
}

// Results of every series in one map; stage IDs start with the series name, so they never clash.
function mergeSeriesResults(
    progressList: readonly CampaignProgress[],
): Record<string, CampaignBestResult> {
    return Object.assign({}, ...progressList.map((progress) => progress.resultsByRaceId));
}

class CampaignProgressBusyError extends GuestProgressSelectionRetryableError {}

// A transfer owns the player's Campaign rows from its marks until it ends.
export class CampaignProgressTransferPendingError extends Error {
    constructor() {
        super('A progress transfer owns this Campaign progress.');
        this.name = 'CampaignProgressTransferPendingError';
    }
}

// Keys that show this player's transfer: its marks, and for a guest the target account.
function transferStateKeys(playerId: string): string[] {
    return isGuestPlayerId(playerId)
        ? [guestProgressSelectionPendingKey(playerId), guestPromotionKey(playerId)]
        : [guestProgressSelectionAccountPendingKey(playerId)];
}

async function assertNoProgressTransfer(playerId: string): Promise<void> {
    const values = await Promise.all(transferStateKeys(playerId).map((key) => redis.get(key)));
    if (values.some(Boolean)) throw new CampaignProgressTransferPendingError();
}

async function writeProgressWithOwnedLock(
    playerId: string,
    progress: CampaignProgress,
    lock: RedisLock,
    transactionRunner?: RedisLockTransactionRunner,
    { unknownRows = {}, fenceTransfer = false }: {
        unknownRows?: Record<string, unknown>;
        // Stops if a transfer started; the check holds until EXEC, so a later transfer fails the commit.
        fenceTransfer?: boolean;
    } = {},
): Promise<void> {
    const expiresAt = guestExpiresAt();
    const record = Object.keys(unknownRows).length
        ? { ...progress, resultsByRaceId: { ...unknownRows, ...progress.resultsByRaceId } }
        : progress;
    const enqueue: RedisLockMutation = async (transaction) => {
        await transaction.set(
            progressKey(playerId, progress.campaignId),
            JSON.stringify(record),
            isGuestPlayerId(playerId) ? { expiration: expiresAt } : undefined,
        );
        await queueCampaignAggregate(transaction, playerId, progress.campaignId, progress.resultsByRaceId);
        if (isGuestPlayerId(playerId)) {
            await transaction.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, {
                member: playerId,
                score: expiresAt.getTime(),
            });
        }
    };
    if (transactionRunner) {
        await transactionRunner([lock], enqueue);
    } else {
        const transaction = await beginOwnedRedisLockTransaction(lock, redis, fenceTransfer
            ? { watchedKeys: transferStateKeys(playerId), check: () => assertNoProgressTransfer(playerId) }
            : {});
        if (!transaction) throw new CampaignProgressBusyError('Campaign progress lock was lost.');
        await enqueue(transaction);
        if (!await commitOwnedRedisLockTransaction(transaction)) {
            throw new CampaignProgressBusyError('Campaign progress save was interrupted.');
        }
    }
    if (isGuestPlayerId(playerId)) await extendOtherGuestSeriesBestEffort(playerId, progress.campaignId);
}

// Play in one series renews the guest's other series records too.
async function extendOtherGuestSeriesBestEffort(playerId: string, seriesId: string): Promise<void> {
    const otherKeys = CAMPAIGN_SERIES
        .filter((series) => series.id !== seriesId)
        .map((series) => progressKey(playerId, series.id));
    if (!otherKeys.length) return;
    try {
        await Promise.all(otherKeys.map((key) => redis.expire(key, CAMPAIGN_GUEST_TTL_SECONDS)));
    } catch (error) {
        console.error('Campaign guest series expiry refresh failed:', error);
    }
}

async function mutateProgress(
    playerId: string,
    seriesId: string,
    mutate: (progress: CampaignProgress) => CampaignProgress | Promise<CampaignProgress>,
): Promise<CampaignProgress> {
    const lock = await acquireRedisLockWithRetry(
        progressLockKey(playerId, seriesId),
        CAMPAIGN_PROGRESS_LOCK_TTL_MS,
        CAMPAIGN_PROGRESS_LOCK_RETRY_DELAYS_MS,
        redis,
    );
    if (!lock) throw new CampaignProgressBusyError('Campaign progress update is already in progress.');
    try {
        const { progress: current, unknownRows } = await readProgressForWrite(playerId, seriesId);
        const next = await mutate(current);
        if (next === current) {
            // Adopt retained progress and repair a lost derived row, even without a new PB.
            if (await campaignAggregateNeedsUpdate(playerId, seriesId, current.resultsByRaceId)) {
                const transaction = await beginOwnedRedisLockTransaction(lock, redis, {
                    watchedKeys: transferStateKeys(playerId), check: () => assertNoProgressTransfer(playerId),
                });
                if (!transaction) throw new CampaignProgressBusyError('Campaign progress lock was lost.');
                await queueCampaignAggregate(transaction, playerId, seriesId, current.resultsByRaceId);
                if (!await commitOwnedRedisLockTransaction(transaction)) {
                    throw new CampaignProgressBusyError('Campaign aggregate repair was interrupted.');
                }
            }
            return current;
        }
        await writeProgressWithOwnedLock(playerId, next, lock, undefined, { unknownRows, fenceTransfer: true });
        return next;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Campaign progress lock cleanup failed:', error);
        });
    }
}

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
        ...candidates.flatMap((candidate) => allProgressLockKeys(candidate.member)),
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
            expired.flatMap(allProgressLockKeys).map((key) => redis.get(key)),
        );
        if (activeProgressLocks.some(Boolean)) {
            await transaction.unwatch();
            return 0;
        }
        await transaction.multi();
        for (const stage of CAMPAIGN_LIVE_STAGES) {
            const competition = competitionFor(stage);
            await transaction.zRem(competition.leaderboardKey, expired);
            await transaction.hDel(competition.entryHashKey, expired);
            await transaction.hDel(competition.pbHashKey, expired.map(playerFieldHash));
            await transaction.incrBy(competition.standingsRevisionKey, 1);
        }
        for (const playerId of expired) {
            for (const series of CAMPAIGN_SERIES) await transaction.del(progressKey(playerId, series.id));
        }
        for (const series of CAMPAIGN_SERIES) await queueRemoveCampaignAggregate(transaction, series.id, expired);
        await transaction.zRem(CAMPAIGN_GUEST_EXPIRY_KEY, expired);
        const results = await transaction.exec();
        return Array.isArray(results) && results.length > 0 ? expired.length : 0;
    } catch (error) {
        try {
            await transaction.discard();
        } catch (_discardError) {
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

// Medals from every series count toward the car skins.
export async function getCampaignResultsForCarUnlocks(
    playerId: string,
): Promise<CampaignProgress['resultsByRaceId']> {
    return mergeSeriesResults(await readAllProgress(playerId));
}

function earliestTime(values: readonly (string | null)[]): string | null {
    return values.filter((value): value is string => typeof value === 'string').sort()[0] ?? null;
}

function latestTime(values: readonly (string | null)[]): string | null {
    return values.filter((value): value is string => typeof value === 'string').sort().at(-1) ?? null;
}

// A player's Campaign across all series: results, first start and last change.
export type CampaignProgressSummary = {
    startedAt: string | null;
    resultsByRaceId: Record<string, CampaignBestResult>;
    updatedAt: string | null;
};

export async function getCampaignProgressForSelection(
    playerId: string,
    { repairEmpty = true }: { repairEmpty?: boolean } = {},
): Promise<CampaignProgressSummary> {
    const progressList = await Promise.all((await readAllProgress(playerId)).map((progress) => {
        if (!repairEmpty && !progress.startedAt && !Object.keys(progress.resultsByRaceId).length) {
            return progress;
        }
        return repairCampaignProgressFromLeaderboard(playerId, progress);
    }));
    return {
        startedAt: earliestTime(progressList.map((progress) => progress.startedAt)),
        resultsByRaceId: mergeSeriesResults(progressList),
        updatedAt: latestTime(progressList.map((progress) => progress.updatedAt)),
    };
}

function publicProgress(progress: CampaignProgress) {
    const seriesId = progress.campaignId;
    const stages = getCampaignSeriesStages(seriesId);
    const seriesRaceIds = new Set(stages.map((stage) => stage.raceId));
    const unlockedRaceIds = getCampaignUnlockedRaceIds(progress.resultsByRaceId)
        .filter((raceId) => seriesRaceIds.has(raceId));
    return {
        campaignId: seriesId,
        startedAt: progress.startedAt,
        resultsByRaceId: progress.resultsByRaceId,
        unlockedRaceIds,
        complete: stages.every((stage) => {
            const medal = progress.resultsByRaceId[stage.raceId]?.medal;
            return medal === 'gold' || medal === 'author';
        }),
        updatedAt: progress.updatedAt,
    };
}

// A short line for each live series, for the series choice on the Campaign screen.
function seriesSummaries(progressList: readonly CampaignProgress[]) {
    return CAMPAIGN_SERIES.map((series, index) => {
        const results = progressList[index]?.resultsByRaceId ?? {};
        return {
            id: series.id,
            name: series.name,
            ground: series.ground,
            grounds: series.grounds,
            stageCount: series.stages.length,
            medalCount: countCampaignMedals(results, series.id),
            finished: isCampaignSeriesFinished(series.id, results),
        };
    });
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

async function readCampaignStandingsByRaceId(playerId: string | null, seriesId: string) {
    const entries = await Promise.all(getCampaignSeriesStages(seriesId).map(async (stage) => {
        const competition = competitionFor(stage);
        const [totalCount, rank] = await Promise.all([
            redis.zCard(competition.leaderboardKey),
            readPlayerRank(competition, playerId),
        ]);
        return [stage.raceId, { rank, totalCount: totalCount || 0 }] as const;
    }));
    return Object.fromEntries(entries);
}

// Loads the stages' stored tracks in one read, before any layout or medal read.
async function loadStageTracks(stages: readonly { trackKey: string }[]): Promise<void> {
    await loadStoredTracks(stages.map((stage) => stage.trackKey));
}

async function repairCampaignProgressFromLeaderboard(
    playerId: string,
    progress: CampaignProgress,
    { retryIfBusy = false }: { retryIfBusy?: boolean } = {},
): Promise<CampaignProgress> {
    const seriesId = progress.campaignId;
    const stages = getCampaignSeriesStages(seriesId);
    await loadStageTracks(stages);
    let recoveredResults: CampaignBestResult[] = [];
    const readRecoveredResults = async () => (await Promise.all(stages.map(async (stage) => (
        campaignResultFromEntry(stage, await readEntryByPlayerId(competitionFor(stage), playerId), playerId)
    )))).filter((result): result is CampaignBestResult => result !== null);
    const withRecovered = (base: CampaignProgress): CampaignProgress => {
        const resultsByRaceId = { ...base.resultsByRaceId };
        let changed = false;
        for (const result of recoveredResults) {
            const previous = resultsByRaceId[result.raceId];
            if (previous && previous.bestTimeMs <= result.bestTimeMs) continue;
            resultsByRaceId[result.raceId] = result;
            changed = true;
        }
        if (!changed) return base;
        const nowIso = new Date().toISOString();
        return {
            campaignId: seriesId,
            startedAt: base.startedAt || nowIso,
            resultsByRaceId,
            updatedAt: nowIso,
        } satisfies CampaignProgress;
    };
    try {
        return await mutateProgress(playerId, seriesId, async (current) => {
            // A faster PB may have committed before its progress save failed; keep the faster evidence per stage.
            recoveredResults = await readRecoveredResults();
            await assertNoProgressTransfer(playerId);
            return withRecovered(current);
        });
    } catch (error) {
        if (!retryIfBusy && (error instanceof CampaignProgressBusyError || error instanceof CampaignProgressTransferPendingError)) {
            // Summaries may show board evidence while a transfer owns the source, but they save nothing.
            if (!recoveredResults.length) recoveredResults = await readRecoveredResults();
            return withRecovered(progress);
        }
        throw error;
    }
}

// A completed share needs only the saved medals; missing rows recover through the bootstrap repair.
export async function getCampaignResultsForSeries(
    playerId: string,
    seriesId: string,
): Promise<CampaignProgress['resultsByRaceId']> {
    const saved = await readProgress(playerId, seriesId);
    const progress = getCampaignSeriesStages(seriesId).every((stage) => saved.resultsByRaceId[stage.raceId])
        ? saved : await repairCampaignProgressFromLeaderboard(playerId, saved);
    return progress.resultsByRaceId;
}

export async function repairCampaignStandingsFromEntries(
    playerId: string,
    seriesId: string | null = null,
): Promise<void> {
    // A transfer owns the rows; as in a race save, the repair rechecks after each stage lock.
    if (await isProgressTransferPending(playerId)) return;
    const stages = seriesId ? getCampaignSeriesStages(seriesId) : CAMPAIGN_LIVE_STAGES;
    for (const stage of stages) {
        const competition = competitionFor(stage);
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
            if (await isProgressTransferPending(playerId)) return;
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
    seriesId: requestedSeriesId,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    seriesId?: unknown;
} = {}) {
    // Stage details cost 4 to 5 reads each, so the bootstrap reads one series only.
    const requested = requestedSeriesId != null && requestedSeriesId !== '';
    const series = getCampaignSeries(requested ? requestedSeriesId : CAMPAIGN_NUMBERS_SERIES_ID);
    if (!series) {
        return { status: 404, body: { reason: 'campaign_unavailable', error: 'This Campaign is unavailable.' } };
    }
    await loadStageTracks(getCampaignSeriesStages(series.id));
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

    const readable = Boolean(canonicalPlayerId && !guestPromotionPending);
    const progressList = readable
        ? await readAllProgress(canonicalPlayerId!)
        : CAMPAIGN_SERIES.map((entry) => emptyProgress(entry.id));
    const seriesIndex = CAMPAIGN_SERIES.findIndex((entry) => entry.id === series.id);
    if (readable) {
        progressList[seriesIndex] = await repairCampaignProgressFromLeaderboard(
            canonicalPlayerId!,
            progressList[seriesIndex],
        );
        await repairCampaignStandingsFromEntries(canonicalPlayerId!, series.id);
    }
    const progress = progressList[seriesIndex];
    const standingsByRaceId = await readCampaignStandingsByRaceId(readable ? canonicalPlayerId : null, series.id);
    const carUnlocks = readable
        ? await getCarUnlockSnapshot(canonicalPlayerId!, mergeSeriesResults(progressList))
        : null;
    return {
        status: 200,
        body: {
            campaignId: series.id,
            ranked: readable,
            signedIn: Boolean(canonicalPlayerId?.startsWith('reddit:')),
            campaignProgressPromotionPending,
            series: seriesSummaries(progressList),
            stages: series.stages,
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
    await loadStageTracks([stage]);
    const progress = await readProgress(identity.canonicalPlayerId, stage.seriesId);
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { error: 'Campaign race is locked.' } };
    }
    let startedProgress: CampaignProgress;
    try {
        startedProgress = await mutateProgress(identity.canonicalPlayerId, stage.seriesId, (freshProgress) => {
            const nowIso = new Date().toISOString();
            return freshProgress.startedAt
                ? freshProgress
                : { ...freshProgress, startedAt: nowIso, updatedAt: nowIso };
        });
    } catch (error) {
        if (error instanceof CampaignProgressBusyError) {
            return { status: 503, body: { error: 'Campaign progress is busy. Try again.' } };
        }
        if (error instanceof CampaignProgressTransferPendingError) return progressTransferPendingReply();
        throw error;
    }
    return { status: 200, body: { race: stage, progress: publicProgress(startedProgress) } };
}

async function readOtherSeriesResults(
    playerId: string,
    seriesId: string,
): Promise<Record<string, CampaignBestResult>> {
    const others = CAMPAIGN_SERIES.filter((series) => series.id !== seriesId);
    return mergeSeriesResults(await Promise.all(others.map((series) => readProgress(playerId, series.id))));
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
    await loadStageTracks([stage]);
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    await cleanupExpiredCampaignGuestsBestEffort();
    const snapshot = await readSnapshot({
        competition: competitionFor(stage),
        playerId: identity.canonicalPlayerId,
        limit: normalizeLimit(limit),
        offset: normalizeOffset(offset),
    });
    return { status: 200, body: { race: stage, ...snapshot } };
}

async function removeRetiredAggregateCandidate(playerId: string, seriesId: string): Promise<boolean> {
    const lock = await acquireRedisLock(progressLockKey(playerId, seriesId), CAMPAIGN_PROGRESS_LOCK_TTL_MS, redis);
    if (!lock) return false;
    try {
        let retired = false;
        const transaction = await beginOwnedRedisLockTransaction(lock, redis, {
            watchedKeys: [...transferStateKeys(playerId), CAMPAIGN_GUEST_EXPIRY_KEY],
            check: async () => {
                const [promotion, expiresAt] = await Promise.all([
                    readGuestPromotionTarget(playerId), redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, playerId),
                ]);
                retired = Boolean(promotion) || (Number.isFinite(expiresAt) && Number(expiresAt) <= Date.now());
            },
        });
        if (!transaction) return false;
        // The player may have raced while this fill waited; retry from the current source.
        if (!retired) {
            await transaction.discard();
            return false;
        }
        if (!await queueRemoveCampaignAggregate(transaction, seriesId, [playerId])) {
            await transaction.discard();
            return true;
        }
        return await commitOwnedRedisLockTransaction(transaction);
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => console.error('Campaign aggregate candidate lock cleanup failed:', error));
    }
}

async function retainCampaignAggregateGuestCandidate(
    playerId: string, seriesId: string,
): Promise<'active' | 'retired' | 'busy' | 'unsupported'> {
    const lock = await acquireRedisLock(progressLockKey(playerId, seriesId), CAMPAIGN_PROGRESS_LOCK_TTL_MS, redis);
    if (!lock) return 'busy';
    try {
        let state: 'active' | 'retired' | 'unsupported' = 'unsupported';
        let inferredExpiry: number | null = null;
        const transaction = await beginOwnedRedisLockTransaction(lock, redis, {
            watchedKeys: [...transferStateKeys(playerId), CAMPAIGN_GUEST_EXPIRY_KEY],
            check: async () => {
                await assertNoProgressTransfer(playerId);
                const existing = await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, playerId);
                if (existing !== null && existing !== undefined) {
                    if (Number.isFinite(existing)) state = Number(existing) > Date.now() ? 'active' : 'retired';
                    return;
                }
                const finalStage = getCampaignFinalStage(seriesId);
                const [progress, entry] = await Promise.all([
                    readProgress(playerId, seriesId),
                    finalStage ? readEntryByPlayerId(competitionFor(finalStage), playerId) : null,
                ]);
                const observations = [progress.updatedAt, entry?.updatedAt,
                    ...Object.values(progress.resultsByRaceId).map((row) => row.updatedAt)]
                    .map((value) => typeof value === 'string' ? Date.parse(value) : Number.NaN)
                    .filter(Number.isFinite);
                if (!observations.length) return;
                inferredExpiry = Math.max(...observations) + CAMPAIGN_GUEST_TTL_SECONDS * 1000;
                state = inferredExpiry > Date.now() ? 'active' : 'retired';
            },
        });
        if (!transaction) return 'busy';
        if (inferredExpiry === null) {
            await transaction.discard();
            return state;
        }
        // Another series can renew the shared guest expiry meanwhile; WATCH stops old evidence overwriting it.
        await transaction.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, { member: playerId, score: inferredExpiry });
        return await commitOwnedRedisLockTransaction(transaction) ? state : 'busy';
    } catch (error) {
        if (error instanceof CampaignProgressTransferPendingError) return 'busy';
        throw error;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => console.error('Campaign aggregate guest retention lock cleanup failed:', error));
    }
}

async function reconcileCampaignAggregateCandidate(playerId: string, seriesId: string): Promise<boolean> {
    if (!playerId.startsWith('reddit:') && !playerId.startsWith('guest:')) return true;
    if (isGuestPlayerId(playerId)) {
        // A permanent promotion mark must never recreate the retired guest.
        if (await readGuestPromotionTarget(playerId)) return removeRetiredAggregateCandidate(playerId, seriesId);
        const retention = await retainCampaignAggregateGuestCandidate(playerId, seriesId);
        if (retention === 'busy') return false;
        if (retention === 'unsupported') return true;
        if (retention === 'retired') return removeRetiredAggregateCandidate(playerId, seriesId);
    }
    try {
        await repairCampaignProgressFromLeaderboard(playerId, await readProgress(playerId, seriesId), { retryIfBusy: true });
        return true;
    } catch (error) {
        if (error instanceof CampaignProgressBusyError || error instanceof CampaignProgressTransferPendingError) return false;
        throw error;
    }
}

// Uses the existing migration scheduler; ranks never wait for old finishers to visit.
export async function runCampaignAggregateFills(): Promise<void> {
    for (const series of CAMPAIGN_SERIES) {
        if (!getCampaignFinalStage(series.id)) continue;
        await runCampaignAggregateFill(series.id, (playerId) => reconcileCampaignAggregateCandidate(playerId, series.id));
    }
}

export async function getServerCampaignAggregate({
    seriesId, playerId, redditUsername, guestToken, limit, offset,
}: {
    seriesId?: unknown; playerId?: unknown; redditUsername?: unknown; guestToken?: unknown; limit?: unknown; offset?: unknown;
} = {}) {
    const series = getCampaignSeries(seriesId);
    if (!series || !getCampaignFinalStage(series.id)) {
        return { status: 404, body: { reason: 'campaign_unavailable', error: 'This Campaign leaderboard is unavailable.' } };
    }
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    const canonicalPlayerId = identity.canonicalPlayerId;
    if (!canonicalPlayerId) return identityRequired();
    if (identity.guestStatus === 'guest_promotion_pending' || await isProgressTransferPending(canonicalPlayerId)) {
        return progressTransferPendingReply();
    }
    await cleanupExpiredCampaignGuestsBestEffort();
    let progress: CampaignProgress;
    try {
        progress = await repairCampaignProgressFromLeaderboard(
            canonicalPlayerId, await readProgress(canonicalPlayerId, series.id), { retryIfBusy: true },
        );
    } catch (error) {
        if (error instanceof CampaignProgressTransferPendingError) return progressTransferPendingReply();
        if (error instanceof CampaignProgressBusyError) return { status: 503, body: { error: 'Campaign progress is busy. Try again.' } };
        throw error;
    }
    const totalTimeMs = getCampaignAggregateTotalTimeMs(series.id, progress.resultsByRaceId);
    if (totalTimeMs === null) {
        return { status: 403, body: { reason: 'campaign_unfinished', error: 'Finish this Campaign before opening its leaderboard.' } };
    }
    const ready = await runCampaignAggregateFill(series.id,
        (candidate) => reconcileCampaignAggregateCandidate(candidate, series.id));
    return { status: 200, body: await readCampaignAggregateSnapshot({
        seriesId: series.id, playerId: canonicalPlayerId, totalTimeMs,
        limit: normalizeLimit(limit), offset: normalizeOffset(offset), ready,
    }) };
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
    await loadStageTracks([stage]);
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    await cleanupExpiredCampaignGuestsBestEffort();
    if (identity.canonicalPlayerId) {
        const progress = await readProgress(identity.canonicalPlayerId, stage.seriesId);
        if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
            return { status: 403, body: { error: 'Campaign race is locked.', reason: 'race_locked' } };
        }
    }
    return prepareCompetitionOpponentRace({
        competition: competitionFor(stage),
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
    if (progressTransferPending) return progressTransferPendingReply();
    if (isMismatchedSubmissionOwner(identity.canonicalPlayerId, submissionOwnerId)) {
        return SUBMISSION_IDENTITY_CHANGED_RESULT;
    }
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { accepted: false, error: 'Campaign race not found.' } };
    await loadStageTracks([stage]);

    const canonicalPlayerId = identity.canonicalPlayerId;
    const progress = await readProgress(canonicalPlayerId, stage.seriesId);
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { accepted: false, error: 'Campaign race is locked.' } };
    }

    const competition = competitionFor(stage);
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
            savedProgress = await mutateProgress(canonicalPlayerId, stage.seriesId, (freshProgress) => {
                const previous = freshProgress.resultsByRaceId[stage.raceId] ?? null;
                if (previous && previous.bestTimeMs <= body.bestTimeMs) return freshProgress;
                return {
                    campaignId: stage.seriesId,
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
            // The board row predates the transfer marks, so the transfer copies it; progress is not written again.
            if (error instanceof CampaignProgressTransferPendingError) return progressTransferPendingReply();
            throw error;
        }

        const confirmedResult = savedProgress.resultsByRaceId[stage.raceId];
        if (!confirmedResult || confirmedResult.bestTimeMs > body.bestTimeMs) {
            return {
                status: 503,
                body: { accepted: false, error: 'Campaign progress save was interrupted. Retry.' },
            };
        }

        const [carUnlocks, reward] = await Promise.allSettled([
            readOtherSeriesResults(canonicalPlayerId, stage.seriesId).then((otherResults) => (
                getCarUnlockSnapshot(
                    canonicalPlayerId,
                    { ...otherResults, ...savedProgress.resultsByRaceId },
                    redis,
                    true,
                )
            )),
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
    await loadStageTracks([stage]);
    const personalBest = await getPlayerTrackPbRecord({
        playerId: identity.canonicalPlayerId,
        competition: competitionFor(stage),
        track: TRACKS[stage.trackKey],
    });
    return {
        status: 200,
        body: {
            campaignId: stage.seriesId,
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            personalBest,
        },
    };
}

type GuestCampaignStageSource = {
    rawEntry: string | null;
    rank: number | null;
    entry: DailyGpLeaderboardEntry | null;
    pb: PlayerTrackPbRecord | null;
    rawPb: string | null;
};

type GuestCampaignSourceSnapshot = {
    progressBySeries: Map<string, CampaignProgress>;
    stages: Map<string, GuestCampaignStageSource>;
    rawProgressBySeries: Record<string, string | null>;
    malformed: string[];
    newestUpdatedAt: string | null;
};

async function captureClassifiedGuestCampaignSource(
    guestPlayerId: string,
    stagesToRead: readonly CampaignStage[] = CAMPAIGN_LIVE_STAGES,
): Promise<GuestCampaignSourceSnapshot> {
    const malformed: string[] = [];
    let newestUpdatedAt: string | null = null;
    const observeTimestamp = (value: string | null | undefined) => {
        if (!value) return;
        const parsed = Date.parse(value);
        if (!Number.isFinite(parsed)) return;
        if (!newestUpdatedAt || parsed > Date.parse(newestUpdatedAt)) newestUpdatedAt = value;
    };

    const rawProgressBySeries: Record<string, string | null> = {};
    const progressBySeries = new Map<string, CampaignProgress>();
    const rawProgressList = await Promise.all(
        CAMPAIGN_SERIES.map((series) => redis.get(progressKey(guestPlayerId, series.id))),
    );
    for (const [seriesIndex, series] of CAMPAIGN_SERIES.entries()) {
        const rawProgress = rawProgressList[seriesIndex] ?? null;
        rawProgressBySeries[series.id] = rawProgress;
        progressBySeries.set(series.id, parseCampaignProgress(rawProgress, series.id));
        observeTimestamp(readStoredUpdatedAt(rawProgress));
        const progressClass = classifyStoredCampaignProgress(rawProgress, series.id);
        const label = series.id === CAMPAIGN_NUMBERS_SERIES_ID ? 'campaign:progress' : `campaign:progress:${series.id}`;
        if (progressClass.state === 'malformed') {
            malformed.push(`${label}:${progressClass.reason}`);
        } else if (progressClass.state === 'valid') {
            for (const row of Object.values(progressClass.record.rows)) observeTimestamp(row.updatedAt);
        }
    }

    const stages = new Map<string, GuestCampaignStageSource>();
    const stageRows = await Promise.all(stagesToRead.map((stage) => {
        const competition = competitionFor(stage);
        return Promise.all([
            redis.hGet(competition.entryHashKey, guestPlayerId),
            redisCompressed.hGet(competition.pbHashKey, playerFieldHash(guestPlayerId)),
            typeof redis.zScore === 'function'
                ? redis.zScore(competition.leaderboardKey, guestPlayerId)
                : Promise.resolve(null),
        ]);
    }));
    for (const [stageIndex, stage] of stagesToRead.entries()) {
        const competition = competitionFor(stage);
        const [rawEntry, rawPb, rank] = stageRows[stageIndex];
        const pbClass = classifyStoredPbRecordFor(rawPb, competition, TRACKS[stage.trackKey]);
        const entryClass = classifyStoredLeaderboardEntry(rawEntry, guestPlayerId, stage);
        observeTimestamp(readStoredUpdatedAt(rawEntry));
        observeTimestamp(readStoredUpdatedAt(rawPb));
        if (entryClass.state === 'malformed') {
            malformed.push(`campaign:entry:${stage.raceId}:${entryClass.reason}`);
        }
        if (pbClass.state === 'malformed') {
            malformed.push(`campaign:pb:${stage.raceId}:${pbClass.reason}`);
        }
        stages.set(stage.raceId, {
            rawEntry: rawEntry ?? null,
            rank: rank ?? null,
            entry: entryClass.state === 'valid'
                ? parseStoredEntry(rawEntry, stage.trackKey)
                : null,
            pb: pbClass.state === 'valid' ? pbClass.record : null,
            rawPb: rawPb ?? null,
        });
    }

    return {
        progressBySeries,
        rawProgressBySeries,
        stages,
        malformed,
        newestUpdatedAt,
    };
}

// Moves guest Campaign progress to the account, keeping the faster time per stage.
export async function mergeGuestCampaignProgress({
    guestPlayerId,
    redditPlayerId,
    verifyGuestSource,
    transactionRunner,
    raceIds,
    classifySource = false,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    // Checks guest rows before any write, so a damaged row stops the transfer instead of being dropped.
    classifySource?: boolean;
    // The stages either player holds a row on; every live stage when absent.
    raceIds?: readonly string[] | null;
    verifyGuestSource?: (observed?: {
        campaignProgress: string | null;
        campaignSeriesProgress: Record<string, string | null>;
        campaignStages: Record<string, { entry: string | null; pb: string | null; rank: number | null }>;
    }) => void | Promise<void>;
    transactionRunner?: RedisLockTransactionRunner;
}): Promise<{ merged: boolean; mergedRaceIds: string[] }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return { merged: false, mergedRaceIds: [] };
    }

    const locks: RedisLock[] = [];
    let lease: RedisLockLease | null = null;
    const startLease = () => startRedisLockGroupLeaseRenewal(
        locks,
        CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS,
        redis,
    );
    const confirmMergeOwnership = async () => {
        if (!lease || !await lease.confirmOwnership()) {
            throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
        }
    };
    // Without the transfer's runner (tests), the progress locks fence each write.
    const runner = transactionRunner ?? createOwnedLockGroupRunner(
        locks,
        (reason) => new CampaignProgressBusyError(reason === 'lost'
            ? 'Campaign merge ownership was lost.'
            : 'Campaign leaderboard copy was interrupted.'),
        redis,
    );
    const runMutation = async (
        domainLocks: readonly RedisLock[],
        mutate: RedisLockMutation,
    ): Promise<void> => {
        const activeLease = lease;
        lease = null;
        if (activeLease) {
            await activeLease.stop().catch((error) => {
                console.error('Campaign merge lease pause failed:', error);
            });
        }
        await runner(domainLocks, mutate);
        lease = startLease();
    };
    try {
        // Transfer marks block new saves and in-flight saves are checked, so the merge needs no stage locks.
        for (const key of [
            ...allProgressLockKeys(guestPlayerId),
            ...allProgressLockKeys(redditPlayerId),
        ].sort()) {
            const lock = await acquireRedisLock(key, CAMPAIGN_PROGRESS_LOCK_TTL_MS, redis);
            if (!lock) throw new CampaignProgressBusyError('Campaign merge is already in progress.');
            locks.push(lock);
        }
        lease = startLease();
        await confirmMergeOwnership();

        const stages = transferStages(raceIds);
        await loadStageTracks(stages);
        const guestSource = classifySource
            ? await captureClassifiedGuestCampaignSource(guestPlayerId, stages)
            : null;
        if (guestSource?.malformed.length) {
            await ensureGuestCampaignRetention(guestPlayerId, guestSource.newestUpdatedAt);
            throw new GuestProgressRecoveryRequiredError(
                `Campaign guest source needs review: ${guestSource.malformed.join(', ')}`,
            );
        }
        if (guestSource) {
            await verifyGuestSource?.({
                campaignProgress: guestSource.rawProgressBySeries[CAMPAIGN_NUMBERS_SERIES_ID] ?? null,
                campaignSeriesProgress: Object.fromEntries(
                    Object.entries(guestSource.rawProgressBySeries)
                        .filter(([seriesId]) => seriesId !== CAMPAIGN_NUMBERS_SERIES_ID),
                ),
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

        const guestProgressBySeries = new Map<string, CampaignProgress>();
        const redditProgressBySeries = new Map<string, CampaignProgress>();
        const mergedResultsBySeries = new Map<string, Record<string, CampaignBestResult>>();
        let hasGuestEvidence = false;
        // Account rows on unknown stages stay; unknown guest rows are not copied.
        const redditUnknownRowsBySeries = new Map<string, Record<string, unknown>>();
        const seriesProgress = await Promise.all(CAMPAIGN_SERIES.map(async (series) => {
            const [guestProgress, redditRead] = await Promise.all([
                guestSource
                    ? Promise.resolve(guestSource.progressBySeries.get(series.id) ?? emptyProgress(series.id))
                    : readProgress(guestPlayerId, series.id),
                readProgressForWrite(redditPlayerId, series.id),
            ]);
            return { series, guestProgress, redditProgress: redditRead.progress, redditUnknownRows: redditRead.unknownRows };
        }));
        for (const { series, guestProgress, redditProgress, redditUnknownRows } of seriesProgress) {
            guestProgressBySeries.set(series.id, guestProgress);
            redditProgressBySeries.set(series.id, redditProgress);
            redditUnknownRowsBySeries.set(series.id, redditUnknownRows);
            mergedResultsBySeries.set(series.id, { ...redditProgress.resultsByRaceId });
            hasGuestEvidence ||= Boolean(
                guestProgress.startedAt
                || Object.keys(guestProgress.resultsByRaceId).length > 0
            );
        }

        // Read every stage at the same time.
        const stageReads = await Promise.all(stages.map(async (stage) => {
            const competition = competitionFor(stage);
            const track = TRACKS[stage.trackKey];
            const [snapshotlessGuestEntry, rawRedditEntry, snapshotlessGuestPb, redditPb, redditRankedScore] = await Promise.all([
                guestSource
                    ? Promise.resolve(null)
                    : readEntryByPlayerId(competition, guestPlayerId),
                redis.hGet(competition.entryHashKey, redditPlayerId),
                guestSource
                    ? Promise.resolve(null)
                    : getPlayerTrackPbRecord({ playerId: guestPlayerId, competition, track }),
                getPlayerTrackPbRecord({ playerId: redditPlayerId, competition, track }),
                redis.zScore(competition.leaderboardKey, redditPlayerId),
            ]);
            return {
                stage,
                competition,
                snapshotlessGuestEntry,
                redditEntry: parseStoredEntry(rawRedditEntry, competition.trackKey),
                snapshotlessGuestPb,
                redditPb,
                redditRankedScore,
            };
        }));

        // Decide what each stage needs. A stage with nothing to write is skipped.
        const stageWrites: { raceId: string; mutate: RedisLockMutation }[] = [];
        const mergedRaceIds: string[] = [];
        for (const read of stageReads) {
            const { stage, competition, redditEntry, redditPb, redditRankedScore } = read;
            const guestProgress = guestProgressBySeries.get(stage.seriesId)!;
            const redditProgress = redditProgressBySeries.get(stage.seriesId)!;
            const mergedResults = mergedResultsBySeries.get(stage.seriesId)!;
            const stageSource = guestSource?.stages.get(stage.raceId);
            const guestEntry = guestSource ? (stageSource?.entry ?? null) : read.snapshotlessGuestEntry;
            const guestPb = guestSource ? (stageSource?.pb ?? null) : read.snapshotlessGuestPb;
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
            const guestWins = Boolean(
                guestResult
                && (!redditResult || guestResult.bestTimeMs < redditResult.bestTimeMs),
            );
            const selectedResult = fasterCampaignResult(redditResult, guestResult);
            if (selectedResult) {
                mergedResults[stage.raceId] = selectedResult;
            }
            if (guestWins && guestResult) {
                mergedRaceIds.push(stage.raceId);
            }
            const { entryToWrite, guestPbWins } = decideBoardMerge({
                board: competition,
                guestPlayerId,
                redditPlayerId,
                guestEntry,
                guestPb,
                redditEntry,
                redditPb,
                redditRankedScore,
            });
            let rawGuestPb: string | undefined;
            if (guestPbWins) {
                const validated = guestSource ? stageSource?.rawPb ?? null : null;
                rawGuestPb = validated !== null
                    ? encodeRedisCompressedValue(validated)
                    : await redis.hGet(competition.pbHashKey, playerFieldHash(guestPlayerId));
                if (!rawGuestPb) {
                    throw new Error(`Campaign guest PB disappeared during promotion: ${stage.raceId}`);
                }
            }
            const mutate = boardMergeWrite(competition, redditPlayerId, entryToWrite, rawGuestPb);
            if (mutate) stageWrites.push({ raceId: stage.raceId, mutate });
        }

        // Write the stages in groups, one fenced transaction for each group.
        await confirmMergeOwnership();
        for (let index = 0; index < stageWrites.length; index += CAMPAIGN_STAGES_PER_TRANSFER_WRITE) {
            const group = stageWrites.slice(index, index + CAMPAIGN_STAGES_PER_TRANSFER_WRITE);
            await runMutation([], async (transaction) => {
                for (const write of group) await write.mutate(transaction);
            });
        }

        if (!hasGuestEvidence) return { merged: false, mergedRaceIds: [] };

        await confirmMergeOwnership();
        const nowIso = new Date().toISOString();
        for (const series of CAMPAIGN_SERIES) {
            const guestProgress = guestProgressBySeries.get(series.id)!;
            const redditProgress = redditProgressBySeries.get(series.id)!;
            const mergedResults = mergedResultsBySeries.get(series.id)!;
            const hasRecord = (progress: CampaignProgress) => Boolean(
                progress.startedAt || Object.keys(progress.resultsByRaceId).length,
            );
            // Numbers is always written; a later series only when a player has a record in it.
            const touched = series.id === CAMPAIGN_NUMBERS_SERIES_ID
                || hasRecord(guestProgress)
                || Object.keys(mergedResults).length !== Object.keys(redditProgress.resultsByRaceId).length
                || mergedRaceIds.some((raceId) => getCampaignStage(raceId)?.seriesId === series.id);
            if (!touched) continue;
            const redditProgressLock = locks.find((lock) => (
                lock.key === progressLockKey(redditPlayerId, series.id)
            ))!;
            await writeProgressWithOwnedLock(redditPlayerId, {
                campaignId: series.id,
                startedAt: redditProgress.startedAt || guestProgress.startedAt || nowIso,
                resultsByRaceId: mergedResults,
                updatedAt: nowIso,
            }, redditProgressLock, runMutation, { unknownRows: redditUnknownRowsBySeries.get(series.id) });
        }

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

async function guestHasAnyProgress(guestPlayerId: string): Promise<boolean> {
    const values = await Promise.all(
        CAMPAIGN_SERIES.map((series) => redis.get(progressKey(guestPlayerId, series.id))),
    );
    return values.some(Boolean);
}

// Deletes guest Campaign rows in resumable groups (cleanup or discard); progress records go last.
async function clearGuestCampaignProgress(
    guestPlayerId: string,
    label: 'cleanup' | 'discard',
    transactionRunner?: RedisLockTransactionRunner,
    raceIds?: readonly string[] | null,
): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const locks: RedisLock[] = [];
    try {
        for (const key of allProgressLockKeys(guestPlayerId).sort()) {
            const lock = await acquireRedisLock(key, CAMPAIGN_PROGRESS_LOCK_TTL_MS, redis);
            if (!lock) throw new CampaignProgressBusyError(`Campaign ${label} is already in progress.`);
            locks.push(lock);
        }
        // Each write renews and watches the progress locks, and the transfer lock when the transfer runs it.
        const runner = transactionRunner ?? createOwnedLockGroupRunner(
            [],
            (reason) => new CampaignProgressBusyError(reason === 'lost'
                ? `Campaign ${label} ownership was lost.`
                : `Campaign ${label} was interrupted.`),
            redis,
        );
        const hadProgress = await guestHasAnyProgress(guestPlayerId);
        const stagesToClear = (await Promise.all(transferStages(raceIds).map(async (stage) => (
            await competitionHoldsPlayerRows(competitionFor(stage), guestPlayerId) ? stage : null
        )))).filter((stage): stage is CampaignStage => stage !== null);

        for (let index = 0; index < stagesToClear.length; index += CAMPAIGN_STAGES_PER_TRANSFER_WRITE) {
            const group = stagesToClear.slice(index, index + CAMPAIGN_STAGES_PER_TRANSFER_WRITE);
            await runner(locks, async (transaction) => {
                for (const stage of group) {
                    const competition = competitionFor(stage);
                    await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
                    await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
                    await transaction.hDel(competition.pbHashKey, [playerFieldHash(guestPlayerId)]);
                    await transaction.incrBy(competition.standingsRevisionKey, 1);
                }
            });
        }
        await runner(locks, async (transaction) => {
            for (const series of CAMPAIGN_SERIES) {
                await transaction.del(progressKey(guestPlayerId, series.id));
                await queueRemoveCampaignAggregate(transaction, series.id, [guestPlayerId]);
            }
            await transaction.zRem(CAMPAIGN_GUEST_EXPIRY_KEY, [guestPlayerId]);
        });
        return hadProgress;
    } finally {
        await releaseRedisLockGroup(locks, `Campaign ${label}`, redis);
    }
}

export async function cleanupGuestCampaignProgress({
    guestPlayerId,
    transactionRunner,
    raceIds,
}: {
    guestPlayerId: string;
    transactionRunner?: RedisLockTransactionRunner;
    raceIds?: readonly string[] | null;
}): Promise<boolean> {
    return clearGuestCampaignProgress(guestPlayerId, 'cleanup', transactionRunner, raceIds);
}

export async function discardGuestCampaignProgress({
    guestPlayerId,
    transactionRunner,
    raceIds,
}: {
    guestPlayerId: string;
    transactionRunner?: RedisLockTransactionRunner;
    raceIds?: readonly string[] | null;
}): Promise<boolean> {
    return clearGuestCampaignProgress(guestPlayerId, 'discard', transactionRunner, raceIds);
}
