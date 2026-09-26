import { redis } from '@devvit/redis';
import {
    CAMPAIGN_LIVE_STAGES,
    CAMPAIGN_NUMBERS_SERIES_ID,
    CAMPAIGN_SERIES,
    countCampaignMedals,
    getCampaignSeries,
    getCampaignSeriesStages,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
    isCampaignSeriesFinished,
    isCampaignStageUnlocked,
} from '../../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../../game/medals/medal-timing.js';
import { TRACKS } from '../../../game/track/tracks.js';
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
    withOpponentRaceReady,
} from '../competition/competition-leaderboard.js';
import {
    classifyStoredCampaignProgress,
    classifyStoredLeaderboardEntry,
    readStoredUpdatedAt,
    type StoredRecordClassification,
} from '../guest-transfer/guest-transfer-source-classification.js';
import { encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';
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
    readGuestPromotionTarget,
    recordCompletedRace,
} from '../player/car-unlock-store.js';
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
} from '../redis/redis-lock.js';
import {
    GuestProgressRecoveryRequiredError,
    GuestProgressSelectionRetryableError,
} from '../guest-transfer/guest-progress-selection-error.js';
import { recordAnalyticsRaceBestEffort } from '../moderator/analytics-store.js';
import { isPlayerProgressSelectionPending, isProgressTransferPending } from '../player/guest-retirement.js';
import { playerFieldHash } from '../redis/redis-names.js';
import { acquireRedisLockWithRetry } from '../redis/redis-lock-retry.js';
import { progressTransferPendingReply } from '../guest-transfer/progress-transfer-reply.js';

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

// The race-save lock of every live stage, for each player. A transfer reads
// them once to find a save that started before it set its marks.
export function campaignSubmissionLockKeys(playerIds: readonly string[]): string[] {
    return CAMPAIGN_LIVE_STAGES.flatMap((stage) => {
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

// The records of every live series, in series order.
async function readAllProgress(playerId: string): Promise<CampaignProgress[]> {
    return Promise.all(CAMPAIGN_SERIES.map((series) => readProgress(playerId, series.id)));
}

// The results of every series in one map. Stage IDs start with the series name,
// so they never clash.
function mergeSeriesResults(
    progressList: readonly CampaignProgress[],
): Record<string, CampaignBestResult> {
    return Object.assign({}, ...progressList.map((progress) => progress.resultsByRaceId));
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
            progressKey(playerId, progress.campaignId),
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
    } else {
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) throw new CampaignProgressBusyError('Campaign progress lock was lost.');
        await enqueue(transaction);
        if (!await commitOwnedRedisLockTransaction(transaction)) {
            throw new CampaignProgressBusyError('Campaign progress save was interrupted.');
        }
    }
    if (isGuestPlayerId(playerId)) await extendOtherGuestSeriesBestEffort(playerId, progress.campaignId);
}

// Play in one series counts as play in all series: the guest's other series
// records get the same expiry, so a guest who plays only Dirt keeps Numbers.
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
    mutate: (progress: CampaignProgress) => CampaignProgress,
): Promise<CampaignProgress> {
    const lock = await acquireRedisLockWithRetry(
        progressLockKey(playerId, seriesId),
        CAMPAIGN_PROGRESS_LOCK_TTL_MS,
        CAMPAIGN_PROGRESS_LOCK_RETRY_DELAYS_MS,
        redis,
    );
    if (!lock) throw new CampaignProgressBusyError('Campaign progress update is already in progress.');
    try {
        const current = await readProgress(playerId, seriesId);
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

// The Campaign of one player over every series: the results of all series, the
// first start and the last change.
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

async function repairCampaignProgressFromLeaderboard(
    playerId: string,
    progress: CampaignProgress,
): Promise<CampaignProgress> {
    const seriesId = progress.campaignId;
    const missingStages = getCampaignSeriesStages(seriesId).filter(
        (stage) => !progress.resultsByRaceId[stage.raceId],
    );
    if (!missingStages.length) return progress;

    const recovered = await Promise.all(missingStages.map(async (stage) => {
        const entry = await readEntryByPlayerId(
            competitionFor(stage),
            playerId,
        );
        return campaignResultFromEntry(stage, entry, playerId);
    }));
    const recoveredResults = recovered.filter(
        (result): result is CampaignBestResult => result !== null,
    );
    if (!recoveredResults.length) return progress;

    return mutateProgress(playerId, seriesId, (freshProgress) => {
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
            campaignId: seriesId,
            startedAt: freshProgress.startedAt || nowIso,
            resultsByRaceId,
            updatedAt: nowIso,
        } satisfies CampaignProgress;
    });
}

export async function repairCampaignStandingsFromEntries(
    playerId: string,
    seriesId: string | null = null,
): Promise<void> {
    // A transfer owns the player's rows until it ends. Like a race save, the
    // repair checks for one again after it takes each stage lock.
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
    // Stage details (standings, ranks, repairs) cost 4 to 5 reads for each
    // stage, so the bootstrap reads them for one series only.
    const series = getCampaignSeries(requestedSeriesId) ?? getCampaignSeries(CAMPAIGN_NUMBERS_SERIES_ID)!;
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
    entryClass: StoredRecordClassification<unknown>;
    pb: PlayerTrackPbRecord | null;
    pbClass: StoredRecordClassification<PlayerTrackPbRecord>;
    rawPb: string | null;
};

type GuestCampaignSourceSnapshot = {
    progressBySeries: Map<string, CampaignProgress>;
    stages: Map<string, GuestCampaignStageSource>;
    rawProgressBySeries: Record<string, string | null>;
    malformed: string[];
    obsolete: string[];
    newestUpdatedAt: string | null;
};

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

    const rawProgressBySeries: Record<string, string | null> = {};
    const progressBySeries = new Map<string, CampaignProgress>();
    for (const series of CAMPAIGN_SERIES) {
        const rawProgress = (await redis.get(progressKey(guestPlayerId, series.id))) ?? null;
        rawProgressBySeries[series.id] = rawProgress;
        progressBySeries.set(series.id, parseCampaignProgress(rawProgress, series.id));
        observeTimestamp(readStoredUpdatedAt(rawProgress));
        const progressClass = classifyStoredCampaignProgress(rawProgress, series.id);
        const label = series.id === CAMPAIGN_NUMBERS_SERIES_ID ? 'campaign:progress' : `campaign:progress:${series.id}`;
        if (progressClass.state === 'malformed') {
            malformed.push(`${label}:${progressClass.reason}`);
        } else if (progressClass.state === 'valid') {
            for (const row of Object.values(progressClass.record.rows)) observeTimestamp(row.updatedAt);
            for (const raceId of progressClass.record.obsoleteRaceIds) {
                obsolete.push(`${label}:${raceId}`);
            }
        }
    }

    const stages = new Map<string, GuestCampaignStageSource>();
    for (const stage of CAMPAIGN_LIVE_STAGES) {
        const competition = competitionFor(stage);
        const [rawEntry, rawPb, rank] = await Promise.all([
            redis.hGet(competition.entryHashKey, guestPlayerId),
            redisCompressed.hGet(competition.pbHashKey, playerFieldHash(guestPlayerId)),
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
        progressBySeries,
        rawProgressBySeries,
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
        await acquireAll(CAMPAIGN_LIVE_STAGES.flatMap((stage) => {
            const competition = competitionFor(stage);
            return [
                competitionSubmissionLockKey(competition, guestPlayerId),
                competitionSubmissionLockKey(competition, redditPlayerId),
            ];
        }), SUBMISSION_LOCK_TTL_MS);
        await acquireAll([
            ...allProgressLockKeys(guestPlayerId),
            ...allProgressLockKeys(redditPlayerId),
        ], CAMPAIGN_PROGRESS_LOCK_TTL_MS);
        lease = startRedisLockGroupLeaseRenewal(
            locks,
            Math.max(1, Math.floor(SUBMISSION_LOCK_TTL_MS / 3)),
            redis,
        );
        await confirmMergeOwnership();

        const guestSource = replace
            ? await captureClassifiedGuestCampaignSource(guestPlayerId)
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
        for (const series of CAMPAIGN_SERIES) {
            const [guestProgress, redditProgress] = await Promise.all([
                guestSource
                    ? Promise.resolve(guestSource.progressBySeries.get(series.id) ?? emptyProgress(series.id))
                    : readProgress(guestPlayerId, series.id),
                readProgress(redditPlayerId, series.id),
            ]);
            guestProgressBySeries.set(series.id, guestProgress);
            redditProgressBySeries.set(series.id, redditProgress);
            mergedResultsBySeries.set(series.id, replace
                ? Object.create(null)
                : { ...redditProgress.resultsByRaceId });
            hasGuestEvidence ||= Boolean(
                guestProgress.startedAt
                || Object.keys(guestProgress.resultsByRaceId).length > 0
            );
        }
        const mergedRaceIds: string[] = [];
        for (const stage of CAMPAIGN_LIVE_STAGES) {
            const guestProgress = guestProgressBySeries.get(stage.seriesId)!;
            const redditProgress = redditProgressBySeries.get(stage.seriesId)!;
            const mergedResults = mergedResultsBySeries.get(stage.seriesId)!;
            await confirmMergeOwnership();
            const guestCompetition = competitionFor(stage);
            const redditCompetition = competitionFor(stage);
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
                ? withOpponentRaceReady(
                    {
                        playerId: redditPlayerId,
                        trackKey: stage.trackKey,
                        bestTimeMs: guestResult.bestTimeMs,
                        updatedAt: guestResult.updatedAt,
                        completedLaps: stage.lapCount,
                        checkpointTimesSec: guestResult.checkpointTimesSec,
                        validationMethod: 'strict-replay' as const,
                    },
                    guestPb,
                    redditCompetition,
                )
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
                    const validated = guestSource ? stageSource?.rawPb ?? null : null;
                    rawGuestPb = validated !== null
                        ? encodeRedisCompressedValue(validated)
                        : await redis.hGet(guestCompetition.pbHashKey, playerFieldHash(guestPlayerId));
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
                                [playerFieldHash(redditPlayerId)]: rawGuestPb,
                            });
                        } else if (replace) {
                            await transaction.hDel(redditCompetition.pbHashKey, [playerFieldHash(redditPlayerId)]);
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
                            playerFieldHash(guestPlayerId),
                        );
                    if (!rawGuestPb) {
                        throw new Error(`Campaign guest PB disappeared during promotion: ${stage.raceId}`);
                    }
                    await redisCompressed.hSet(redditCompetition.pbHashKey, {
                        [playerFieldHash(redditPlayerId)]: rawGuestPb,
                    });
                } else if (replace) {
                    await redisCompressed.hDel(redditCompetition.pbHashKey, [playerFieldHash(redditPlayerId)]);
                }
            }
        }

        if (!hasGuestEvidence && !replace) return { merged: false, mergedRaceIds: [] };

        await confirmMergeOwnership();
        const nowIso = new Date().toISOString();
        for (const series of CAMPAIGN_SERIES) {
            const guestProgress = guestProgressBySeries.get(series.id)!;
            const redditProgress = redditProgressBySeries.get(series.id)!;
            const mergedResults = mergedResultsBySeries.get(series.id)!;
            const hasRecord = (progress: CampaignProgress) => Boolean(
                progress.startedAt || Object.keys(progress.resultsByRaceId).length,
            );
            // Numbers is always written, as before. A later series is written
            // only when one of the two players has a record in it.
            const touched = series.id === CAMPAIGN_NUMBERS_SERIES_ID
                || hasRecord(guestProgress)
                || (replace && hasRecord(redditProgress))
                || Object.keys(mergedResults).length !== Object.keys(redditProgress.resultsByRaceId).length
                || mergedRaceIds.some((raceId) => getCampaignStage(raceId)?.seriesId === series.id);
            if (!touched) continue;
            const redditProgressLock = locks.find((lock) => (
                lock.key === progressLockKey(redditPlayerId, series.id)
            ))!;
            await writeProgressWithOwnedLock(redditPlayerId, {
                campaignId: series.id,
                startedAt: replace
                    ? (guestProgress.startedAt || null)
                    : (redditProgress.startedAt || guestProgress.startedAt || nowIso),
                resultsByRaceId: mergedResults,
                updatedAt: nowIso,
            }, redditProgressLock, transactionRunner ? runMutation : undefined);
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

export async function cleanupGuestCampaignProgress({
    guestPlayerId,
}: {
    guestPlayerId: string;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const locks: RedisLock[] = [];
    let lease: RedisLockLease | null = null;
    try {
        for (const key of CAMPAIGN_LIVE_STAGES.flatMap((stage) => {
            const competition = competitionFor(stage);
            return [competitionSubmissionLockKey(competition, guestPlayerId)];
        }).concat(allProgressLockKeys(guestPlayerId)).sort()) {
            const lock = await acquireRedisLock(key, SUBMISSION_LOCK_TTL_MS, redis);
            if (!lock) throw new CampaignProgressBusyError('Campaign cleanup is already in progress.');
            locks.push(lock);
            lease ??= startRedisLockGroupLeaseRenewal(
                locks,
                CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS,
                redis,
            );
        }
        const progressLockKeys = new Set(allProgressLockKeys(guestPlayerId));
        if (locks.filter((lock) => progressLockKeys.has(lock.key)).length !== progressLockKeys.size) {
            throw new CampaignProgressBusyError('Campaign cleanup lock was lost.');
        }
        const hadProgress = await guestHasAnyProgress(guestPlayerId);
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
        for (const stage of CAMPAIGN_LIVE_STAGES) {
            const competition = competitionFor(stage);
            await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
            await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
            await transaction.hDel(competition.pbHashKey, [playerFieldHash(guestPlayerId)]);
            await transaction.incrBy(competition.standingsRevisionKey, 1);
        }
        for (const series of CAMPAIGN_SERIES) await transaction.del(progressKey(guestPlayerId, series.id));
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
        for (const key of CAMPAIGN_LIVE_STAGES.flatMap((stage) => {
            const competition = competitionFor(stage);
            return [
                competitionSubmissionLockKey(competition, guestPlayerId),
            ];
        }).concat(allProgressLockKeys(guestPlayerId)).sort()) {
            const lock = await acquireRedisLock(key, SUBMISSION_LOCK_TTL_MS, redis);
            if (!lock) throw new CampaignProgressBusyError('Campaign discard is already in progress.');
            locks.push(lock);
            lease ??= startRedisLockGroupLeaseRenewal(
                locks,
                CAMPAIGN_TRANSFER_LOCK_RENEWAL_INTERVAL_MS,
                redis,
            );
        }
        const progressLockKeys = new Set(allProgressLockKeys(guestPlayerId));
        if (locks.filter((lock) => progressLockKeys.has(lock.key)).length !== progressLockKeys.size) {
            throw new CampaignProgressBusyError('Campaign discard lock was lost.');
        }
        const hadProgress = await guestHasAnyProgress(guestPlayerId);
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

        const stagesToClear = (await Promise.all(CAMPAIGN_LIVE_STAGES.map(async (stage) => {
            const holdsRows = await competitionHoldsPlayerRows(
                competitionFor(stage),
                guestPlayerId,
            );
            return holdsRows ? stage : null;
        }))).filter((stage): stage is CampaignStage => stage !== null);

        for (const stage of stagesToClear) {
            await keepLocksFresh();
            const competition = competitionFor(stage);
            await commit(async (transaction) => {
                await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
                await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
                await transaction.hDel(competition.pbHashKey, [playerFieldHash(guestPlayerId)]);
                await transaction.incrBy(competition.standingsRevisionKey, 1);
            });
        }

        await keepLocksFresh();
        await commit(async (transaction) => {
            for (const series of CAMPAIGN_SERIES) await transaction.del(progressKey(guestPlayerId, series.id));
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
