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
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
    writeEntry,
} from './competition-leaderboard.js';
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
} from './competition-submit.js';
import { getPlayerTrackPbRecord } from './pb-ghost-store.js';
import { redisCompressed } from '@devvit/redis';
import {
    getCarUnlockSnapshot,
    readGuestPromotionTarget,
    recordCompletedRace,
} from './car-unlock-store.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    startRedisLockGroupLeaseRenewal,
    type RedisLock,
    type RedisLockLease,
} from './redis-lock.js';
import { recordAnalyticsRaceBestEffort } from './analytics-store.js';

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

class CampaignProgressBusyError extends Error {}

async function writeProgressWithOwnedLock(
    playerId: string,
    progress: CampaignProgress,
    lock: RedisLock,
): Promise<void> {
    const transaction = await beginOwnedRedisLockTransaction(lock, redis);
    if (!transaction) throw new CampaignProgressBusyError('Campaign progress lock was lost.');
    const expiresAt = guestExpiresAt();
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
    const results = await transaction.exec();
    if (!Array.isArray(results) || results.length === 0) {
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

export async function getCampaignProgressForSelection(playerId: string): Promise<CampaignProgress> {
    return readProgress(playerId);
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
    let guestPromotionPending = false;
    let campaignProgressPromotionPending = false;
    await cleanupExpiredCampaignGuestsBestEffort();

    if (canonicalPlayerId?.startsWith('reddit:')) {
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
    if (identity.guestStatus === 'guest_promotion_pending') {
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
    recordAnalyticsRaceBestEffort('campaign', 'start', identity.canonicalPlayerId);
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
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) {
        return {
            status: 401,
            body: { accepted: false, error: 'Player identity is required to submit Campaign results.' },
        };
    }
    if (identity.guestStatus === 'guest_promotion_pending') {
        return {
            status: 409,
            body: {
                accepted: false,
                error: 'Choose which progress to keep before submitting a ranked Campaign result.',
                reason: 'progress_selection_required',
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
    });
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

        const [carUnlocks] = await Promise.all([
            getCarUnlockSnapshot(
                canonicalPlayerId,
                savedProgress.resultsByRaceId,
                redis,
                true,
            ),
            recordCompletedRace(canonicalPlayerId),
            outcome.releaseLock,
        ]);

        return {
            status: 200,
            body: {
                ...outcome.body as Record<string, unknown>,
                progress: publicProgress(savedProgress),
                carUnlocks,
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

export async function getServerHeadToHeadSource({
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
    const stage = getCampaignStage(raceId);
    if (!identity.canonicalPlayerId || !stage) return null;
    await cleanupExpiredCampaignGuestsBestEffort();
    const competition = competitionFor(stage, identity.canonicalPlayerId);
    const personalBest = await getPlayerTrackPbRecord({
        playerId: identity.canonicalPlayerId,
        competition,
        track: TRACKS[stage.trackKey],
    });
    if (!personalBest?.ghost) return null;
    const result = (await readProgress(identity.canonicalPlayerId))
        .resultsByRaceId[stage.raceId] ?? null;
    return {
        sourceKind: 'campaign' as const,
        sourceId: stage.raceId,
        campaignId: CAMPAIGN_ID,
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        bestTimeMs: personalBest.bestTimeMs,
        medal: result?.medal ?? null,
        rulesRevision: stage.rulesRevision,
        trackFingerprint: personalBest.trackFingerprint,
        ghost: personalBest.ghost,
    };
}

export async function mergeGuestCampaignProgress({
    guestPlayerId,
    redditPlayerId,
    replace = false,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    replace?: boolean;
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

        const guestProgressLock = locks.find((lock) => lock.key === progressLockKey(guestPlayerId))!;
        const redditProgressLock = locks.find((lock) => lock.key === progressLockKey(redditPlayerId))!;
        const [guestProgress, redditProgress] = await Promise.all([
            readProgress(guestPlayerId),
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
            const [guestEntry, redditEntry, guestPb, redditPb, redditRankedScore] = await Promise.all([
                readEntryByPlayerId(guestCompetition, guestPlayerId),
                readEntryByPlayerId(redditCompetition, redditPlayerId),
                getPlayerTrackPbRecord({
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
            if (entryToWrite || replace) {
                const accountEntryLock = locks.find((lock) => (
                    lock.key === competitionSubmissionLockKey(redditCompetition, redditPlayerId)
                ));
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
                const results = await transaction.exec();
                if (!Array.isArray(results) || results.length === 0) {
                    throw new CampaignProgressBusyError('Campaign leaderboard copy was interrupted.');
                }
            }
            if (guestCanSupplyWinningPb) {
                const rawGuestPb = await redisCompressed.hGet(
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
        }, redditProgressLock);

        // Delete the guest only after every copy succeeded, so an earlier failure leaves a complete retry source.
        await confirmMergeOwnership();
        const cleanup = await beginOwnedRedisLockTransaction(guestProgressLock, redis);
        if (!cleanup) throw new CampaignProgressBusyError('Campaign merge ownership was lost.');
        for (const stage of CAMPAIGN_STAGES) {
            const competition = competitionFor(stage, guestPlayerId);
            await cleanup.hDel(competition.entryHashKey, [guestPlayerId]);
            await cleanup.zRem(competition.leaderboardKey, [guestPlayerId]);
            await cleanup.hDel(competition.pbHashKey, [playerField(guestPlayerId)]);
            await cleanup.incrBy(competition.standingsRevisionKey, 1);
        }
        await cleanup.del(progressKey(guestPlayerId));
        await cleanup.zRem(CAMPAIGN_GUEST_EXPIRY_KEY, [guestPlayerId]);
        const cleanupResults = await cleanup.exec();
        if (!Array.isArray(cleanupResults) || cleanupResults.length === 0) {
            throw new CampaignProgressBusyError('Campaign guest cleanup was interrupted.');
        }
        return { merged: mergedRaceIds.length > 0, mergedRaceIds };
    } finally {
        if (lease) {
            await lease.stop().catch((error) => {
                console.error('Campaign merge lease cleanup failed:', error);
            });
        }
        for (const lock of [...locks].reverse()) {
            await releaseRedisLock(lock, redis).catch((error) => {
                console.error('Campaign merge lock cleanup failed:', error);
            });
        }
    }
}

export async function discardGuestCampaignProgress({
    guestPlayerId,
}: {
    guestPlayerId: string;
}): Promise<boolean> {
    if (!guestPlayerId.startsWith('guest:')) return false;
    const locks: RedisLock[] = [];
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
        }
        const progressLock = locks.find((lock) => lock.key === progressLockKey(guestPlayerId));
        if (!progressLock) throw new CampaignProgressBusyError('Campaign discard lock was lost.');
        const hadProgress = Boolean(await redis.get(progressKey(guestPlayerId)));
        const transaction = await beginOwnedRedisLockTransaction(progressLock, redis);
        if (!transaction) throw new CampaignProgressBusyError('Campaign discard lock was lost.');
        for (const stage of CAMPAIGN_STAGES) {
            const competition = competitionFor(stage, guestPlayerId);
            await transaction.hDel(competition.entryHashKey, [guestPlayerId]);
            await transaction.zRem(competition.leaderboardKey, [guestPlayerId]);
            await transaction.hDel(competition.pbHashKey, [playerField(guestPlayerId)]);
            await transaction.incrBy(competition.standingsRevisionKey, 1);
        }
        await transaction.del(progressKey(guestPlayerId));
        await transaction.zRem(CAMPAIGN_GUEST_EXPIRY_KEY, [guestPlayerId]);
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) {
            throw new CampaignProgressBusyError('Campaign discard was interrupted.');
        }
        return hadProgress;
    } finally {
        for (const lock of [...locks].reverse()) {
            await releaseRedisLock(lock, redis).catch((error) => {
                console.error('Campaign discard lock cleanup failed:', error);
            });
        }
    }
}
