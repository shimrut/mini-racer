/**
 * Campaign: a fixed, permanent ladder of races whose stages unlock on medals.
 *
 * The racing itself — validating a replay, ranking the time, keeping a personal
 * best and its ghost, picking an opponent — is the shared competition pipeline.
 * What lives here is the part that is genuinely Campaign's own: per-player
 * progress, and the medal gate that decides which stage a player may enter.
 */
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
import {
    readEntryByPlayerId,
    readPlayerRank,
    readSnapshot,
} from './competition-leaderboard.js';
import { prepareCompetitionOpponentRace } from './competition-opponent-race.js';
import { resolveAuthorizedPlayerIdentity } from './competition-identity.js';
import { verifyGuestPlayerToken } from './player-token.js';
import {
    competitionSubmissionLockKey,
    submitCompetitionRun,
    SUBMISSION_LOCK_TTL_MS,
} from './competition-submit.js';
import { getPlayerTrackPbRecord } from './pb-ghost-store.js';
import { redisCompressed } from '@devvit/redis';
import {
    getCarUnlockSnapshot,
    mergeGuestCarUnlockProgress,
    recordCompletedRace,
} from './car-unlock-store.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from './redis-lock.js';

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

/**
 * Progress is per player, with permanent signed-in records and rolling guest
 * retention, so it gets its own key rather than a field in one campaign-wide
 * hash that would grow without bound.
 */
function progressKey(playerId: string): string {
    return `campaign:${CAMPAIGN_ID}:progress:${playerField(playerId)}`;
}

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
        const next = mutate(await readProgress(playerId));
        await writeProgressWithOwnedLock(playerId, next, lock);
        return next;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Campaign progress lock cleanup failed:', error);
        });
    }
}

/**
 * Removes a small batch of inactive guests before Campaign reads. WATCHing the
 * global ledger makes a concurrent activity refresh cancel the cleanup rather
 * than delete a returning player's rows.
 */
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

/**
 * Where the player sits on every stage's board, in one pass. The lobby shows a
 * rank per stage, and a zRank each is far cheaper than a snapshot request per
 * stage from the client.
 */
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
    await cleanupExpiredCampaignGuestsBestEffort();

    // Signing in is the moment a guest's ladder would otherwise be stranded, so
    // it is claimed here, before the bootstrap reports what they own.
    if (canonicalPlayerId?.startsWith('reddit:')) {
        const guestPlayerId = await verifyGuestPlayerToken(guestToken);
        if (guestPlayerId) {
            try {
                await Promise.all([
                    mergeGuestCampaignProgress({
                        guestPlayerId: `guest:${guestPlayerId}`,
                        redditPlayerId: canonicalPlayerId,
                    }),
                    mergeGuestCarUnlockProgress({
                        guestPlayerId: `guest:${guestPlayerId}`,
                        redditPlayerId: canonicalPlayerId,
                    }),
                ]);
            } catch (error) {
                // A failed claim must not cost the player their bootstrap; the
                // guest keys survive, so the next load tries again.
                console.error('Campaign guest progress claim failed:', error);
            }
        }
    }

    const [progress, standingsByRaceId] = await Promise.all([
        canonicalPlayerId ? readProgress(canonicalPlayerId) : Promise.resolve(emptyProgress()),
        readCampaignStandingsByRaceId(canonicalPlayerId),
    ]);
    const carUnlocks = canonicalPlayerId
        ? await getCarUnlockSnapshot(canonicalPlayerId, progress.resultsByRaceId)
        : null;
    return {
        status: 200,
        body: {
            campaignId: CAMPAIGN_ID,
            // Whether the player is ranked is what gates racing; being signed in
            // with Reddit is now only about how they are named and whether their
            // progress is permanent. Guests are ranked too.
            ranked: Boolean(canonicalPlayerId),
            signedIn: Boolean(canonicalPlayerId?.startsWith('reddit:')),
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
}: {
    raceId?: unknown;
    trackKey?: unknown;
    replay?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    requestRateLimitIdentity?: unknown;
} = {}) {
    const identity = await identityFor({ playerId, redditUsername, guestToken });
    if (!identity.canonicalPlayerId) {
        return {
            status: 401,
            body: { accepted: false, error: 'Player identity is required to submit Campaign results.' },
        };
    }
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { accepted: false, error: 'Campaign race not found.' } };

    const canonicalPlayerId = identity.canonicalPlayerId;
    const progress = await readProgress(canonicalPlayerId);
    // The medal gate is Campaign's own rule, so it is checked before the run
    // reaches the shared pipeline rather than inside it.
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
        return outcome;
    }

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
        // Reconcile every accepted response, including an unchanged board. A
        // retry can therefore repair progress after an earlier partial save.
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

    await recordCompletedRace(canonicalPlayerId);

    return {
        status: 200,
        body: {
            ...outcome.body as Record<string, unknown>,
            progress: publicProgress(savedProgress),
            carUnlocks: await getCarUnlockSnapshot(
                canonicalPlayerId,
                savedProgress.resultsByRaceId,
            ),
        },
    };
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

/**
 * Moves a guest's Campaign standing onto their Reddit account at sign-in —
 * unlike Daily, Campaign progress gates stage entry, so it cannot be stranded
 * on the guest id. Per stage the better time wins, and its progress entry,
 * leaderboard row, and PB+ghost move independently when each source is better.
 * Guest keys are dropped only after every copy succeeds, so a repeated call is
 * a safe retry.
 */
export async function mergeGuestCampaignProgress({
    guestPlayerId,
    redditPlayerId,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
}): Promise<{ merged: boolean; mergedRaceIds: string[] }> {
    if (!guestPlayerId.startsWith('guest:') || !redditPlayerId.startsWith('reddit:')) {
        return { merged: false, mergedRaceIds: [] };
    }

    const locks: RedisLock[] = [];
    const acquireAll = async (keys: string[], ttlMs: number) => {
        for (const key of [...new Set(keys)].sort()) {
            const lock = await acquireRedisLock(key, ttlMs, redis);
            if (!lock) throw new CampaignProgressBusyError('Campaign merge is already in progress.');
            locks.push(lock);
        }
    };
    try {
        // Match submission's lock order: stage writes finish before either
        // progress record is claimed, so a concurrent finish cannot be deleted.
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

        const guestProgressLock = locks.find((lock) => lock.key === progressLockKey(guestPlayerId))!;
        const redditProgressLock = locks.find((lock) => lock.key === progressLockKey(redditPlayerId))!;
        const [guestProgress, redditProgress] = await Promise.all([
            readProgress(guestPlayerId),
            readProgress(redditPlayerId),
        ]);
        const guestResults = Object.values(guestProgress.resultsByRaceId);
        if (!guestResults.length) return { merged: false, mergedRaceIds: [] };

        const mergedResults = { ...redditProgress.resultsByRaceId };
        const mergedRaceIds: string[] = [];
        for (const guestResult of guestResults) {
            const stage = getCampaignStage(guestResult.raceId);
            if (!stage) continue;
            const guestCompetition = competitionFor(stage, guestPlayerId);
            const redditCompetition = competitionFor(stage, redditPlayerId);
            const [guestEntry, redditEntry, guestPb, redditPb] = await Promise.all([
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
            ]);
            let existingResult = mergedResults[guestResult.raceId];
            if (redditEntry && (!existingResult || redditEntry.bestTimeMs < existingResult.bestTimeMs)) {
                existingResult = {
                    raceId: stage.raceId,
                    trackKey: stage.trackKey,
                    lapCount: stage.lapCount,
                    rulesRevision: stage.rulesRevision,
                    bestTimeMs: redditEntry.bestTimeMs,
                    medal: getMedalForRaceTime(
                        stage.trackKey,
                        redditEntry.bestTimeMs / 1000,
                        stage.lapCount,
                    ),
                    checkpointTimesSec: redditEntry.checkpointTimesSec ?? null,
                    updatedAt: redditEntry.updatedAt,
                };
                mergedResults[guestResult.raceId] = existingResult;
            }
            const guestWins = !existingResult || guestResult.bestTimeMs < existingResult.bestTimeMs;
            const guestCanSupplyWinningPb = Boolean(
                guestPb && (!redditPb || guestPb.bestTimeMs < redditPb.bestTimeMs),
            );
            if (guestWins) {
                mergedResults[guestResult.raceId] = guestResult;
                mergedRaceIds.push(guestResult.raceId);
            }
            if (guestEntry && (!redditEntry || guestEntry.bestTimeMs < redditEntry.bestTimeMs)) {
                await redis.hSet(redditCompetition.entryHashKey, {
                    [redditPlayerId]: JSON.stringify({ ...guestEntry, playerId: redditPlayerId }),
                });
                await redis.zAdd(redditCompetition.leaderboardKey, {
                    member: redditPlayerId,
                    score: guestEntry.bestTimeMs,
                });
                await redis.incrBy(redditCompetition.standingsRevisionKey, 1);
            }
            if (guestCanSupplyWinningPb) {
                const rawGuestPb = await redisCompressed.hGet(
                    guestCompetition.pbHashKey,
                    playerField(guestPlayerId),
                );
                if (rawGuestPb) {
                    await redisCompressed.hSet(redditCompetition.pbHashKey, {
                        [playerField(redditPlayerId)]: rawGuestPb,
                    });
                }
            }
        }

        const nowIso = new Date().toISOString();
        await writeProgressWithOwnedLock(redditPlayerId, {
            campaignId: CAMPAIGN_ID,
            startedAt: redditProgress.startedAt || guestProgress.startedAt || nowIso,
            resultsByRaceId: mergedResults,
            updatedAt: nowIso,
        }, redditProgressLock);

        // Delete the guest only after every copy and the account progress save
        // succeeded. Any earlier failure leaves a complete retry source.
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
        for (const lock of [...locks].reverse()) {
            await releaseRedisLock(lock, redis).catch((error) => {
                console.error('Campaign merge lock cleanup failed:', error);
            });
        }
    }
}
