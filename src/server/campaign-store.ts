import { redis, redisCompressed } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
    isCampaignStageUnlocked,
} from '../../game/campaign/manifest.js';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { sanitizeRedditUsername } from '../../game/shared/leaderboard-identity.js';
import { TRACKS } from '../../game/track/tracks.js';
import { normalizeCheckpointTimesSec } from '../../game/shared/checkpoint-times.js';
import { normalizeLapCompletionTimesSec } from '../../game/shared/lap-completion-times.js';
import {
    createTrackFingerprint,
    isValidPbGhostTrace,
    PB_GHOST_SCHEMA_VERSION,
    PB_GHOST_SIMULATION_REVISION,
    type PbGhostTrace,
} from './pb-ghost-trace.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
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

type CampaignLeaderboardEntry = CampaignBestResult & {
    playerId: string;
    displayName: string;
};

type CampaignPbRecord = CampaignBestResult & {
    schemaVersion: typeof PB_GHOST_SCHEMA_VERSION;
    simulationRevision: typeof PB_GHOST_SIMULATION_REVISION;
    trackFingerprint: string;
    lapCompletionTimesSec: number[] | null;
    ghost: PbGhostTrace | null;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60;
const SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 12;
const SUBMISSION_LOCK_TTL_MS = 30_000;

function playerIdForUsername(username: string): string {
    return `reddit:${username.toLowerCase()}`;
}

function playerField(playerId: string): string {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

/**
 * Progress is per player and permanent, so it gets its own key rather than a
 * field in one campaign-wide hash that would grow without bound.
 */
function progressKey(playerId: string): string {
    return `campaign:${CAMPAIGN_ID}:progress:${playerField(playerId)}`;
}

function leaderboardKey(raceId: string): string {
    return `campaign:${CAMPAIGN_ID}:leaderboard:${raceId}`;
}

function entryHashKey(raceId: string): string {
    return `campaign:${CAMPAIGN_ID}:leaderboard:${raceId}:entries`;
}

function pbHashKey(raceId: string): string {
    return `campaign:${CAMPAIGN_ID}:pbs:${raceId}`;
}

function submissionRateLimitKey(raceId: string, playerId: string): string {
    return `campaign:${CAMPAIGN_ID}:submit-rate-limit:${raceId}:${playerField(playerId)}`;
}

function submissionLockKey(raceId: string, playerId: string): string {
    return `campaign:${CAMPAIGN_ID}:submit-lock:${raceId}:${playerField(playerId)}`;
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

function parseLeaderboardEntry(raw: string | null | undefined, raceId: string): CampaignLeaderboardEntry | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<CampaignLeaderboardEntry>;
        const result = parseBestResult(value, raceId);
        if (!result || typeof value.playerId !== 'string' || typeof value.displayName !== 'string') return null;
        return { ...result, playerId: value.playerId, displayName: value.displayName };
    } catch (_error) {
        return null;
    }
}

function parsePbRecord(raw: string | null | undefined, raceId: string): CampaignPbRecord | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<CampaignPbRecord>;
        const result = parseBestResult(value, raceId);
        const stage = getCampaignStage(raceId);
        const track = stage ? TRACKS[stage.trackKey] : null;
        if (
            !result
            || !track
            || value.schemaVersion !== PB_GHOST_SCHEMA_VERSION
            || value.simulationRevision !== PB_GHOST_SIMULATION_REVISION
            || value.trackFingerprint !== createTrackFingerprint(track)
        ) {
            return null;
        }
        return {
            ...result,
            schemaVersion: PB_GHOST_SCHEMA_VERSION,
            simulationRevision: PB_GHOST_SIMULATION_REVISION,
            trackFingerprint: value.trackFingerprint,
            lapCompletionTimesSec: normalizeLapCompletionTimesSec(
                result.bestTimeMs / 1000,
                value.lapCompletionTimesSec,
                result.lapCount,
            ),
            ghost: isValidPbGhostTrace(value.ghost) ? value.ghost : null,
        };
    } catch (_error) {
        return null;
    }
}

function isCompleteCampaignOpponentRecord(
    entry: CampaignLeaderboardEntry,
    record: CampaignPbRecord | null,
): boolean {
    const stage = getCampaignStage(entry.raceId);
    const checkpointCount = stage
        ? (TRACKS[stage.trackKey]?.checkpoints?.length || 0) * stage.lapCount
        : 0;
    // Matches Daily: the exact best time on both the record and its trace is
    // what ties this ghost to the leaderboard row, not a stored timestamp.
    return Boolean(
        record?.ghost
        && record.bestTimeMs === entry.bestTimeMs
        && record.ghost.finishTimeMs === entry.bestTimeMs
        && Array.isArray(record.checkpointTimesSec)
        && record.checkpointTimesSec.length === checkpointCount,
    );
}

async function readCampaignPbRecord(raceId: string, playerId: string): Promise<CampaignPbRecord | null> {
    return parsePbRecord(
        await redisCompressed.hGet(pbHashKey(raceId), playerField(playerId)),
        raceId,
    );
}

async function readProgress(playerId: string): Promise<CampaignProgress> {
    return parseCampaignProgress(await redis.get(progressKey(playerId)));
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

function signedInIdentity(redditUsername: unknown) {
    const username = sanitizeRedditUsername(redditUsername);
    return username
        ? { username, playerId: playerIdForUsername(username) }
        : null;
}

function unauthorized() {
    return {
        status: 401,
        body: { error: 'Sign in with Reddit to use Campaign competition.' },
    };
}

/**
 * Where the player sits on every stage's board, in one pass. The lobby shows a
 * rank per stage, and a zRank each is far cheaper than a snapshot request per
 * stage from the client.
 */
async function readCampaignStandingsByRaceId(playerId: string | null) {
    const entries = await Promise.all(CAMPAIGN_STAGES.map(async (stage) => {
        const key = leaderboardKey(stage.raceId);
        const [totalCount, rankZeroBased] = await Promise.all([
            redis.zCard(key),
            playerId ? redis.zRank(key, playerId) : Promise.resolve(undefined),
        ]);
        const rank = Number.isFinite(rankZeroBased) ? Number(rankZeroBased) + 1 : null;
        return [stage.raceId, { rank, totalCount: totalCount || 0 }] as const;
    }));
    return Object.fromEntries(entries);
}

export async function getServerCampaignBootstrap({ redditUsername }: { redditUsername?: unknown } = {}) {
    const identity = signedInIdentity(redditUsername);
    const [progress, standingsByRaceId] = await Promise.all([
        identity ? readProgress(identity.playerId) : Promise.resolve(emptyProgress()),
        readCampaignStandingsByRaceId(identity?.playerId ?? null),
    ]);
    return {
        status: 200,
        body: {
            campaignId: CAMPAIGN_ID,
            signedIn: Boolean(identity),
            stages: CAMPAIGN_STAGES,
            progress: publicProgress(progress),
            standingsByRaceId,
        },
    };
}

export async function startServerCampaignRace({
    raceId,
    redditUsername,
}: {
    raceId?: unknown;
    redditUsername?: unknown;
} = {}) {
    const identity = signedInIdentity(redditUsername);
    if (!identity) return unauthorized();
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const progress = await readProgress(identity.playerId);
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { error: 'Campaign race is locked.' } };
    }
    let startedProgress = progress;
    if (!progress.startedAt) {
        const nowIso = new Date().toISOString();
        startedProgress = { ...progress, startedAt: nowIso, updatedAt: nowIso };
        await redis.set(progressKey(identity.playerId), JSON.stringify(startedProgress));
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
    redditUsername,
    limit,
    offset,
}: {
    raceId?: unknown;
    redditUsername?: unknown;
    limit?: unknown;
    offset?: unknown;
} = {}) {
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const identity = signedInIdentity(redditUsername);
    const safeLimit = normalizeLimit(limit);
    const safeOffset = normalizeOffset(offset);
    const totalCount = await redis.zCard(leaderboardKey(stage.raceId));
    const ranked = totalCount
        ? await redis.zRange(leaderboardKey(stage.raceId), safeOffset, safeOffset + safeLimit - 1)
        : [];
    const rawEntries = ranked.length
        ? await redis.hMGet(entryHashKey(stage.raceId), ranked.map((row) => row.member))
        : [];
    const rows = (await Promise.all(ranked.map(async (rankedRow, index) => {
        const entry = parseLeaderboardEntry(rawEntries[index], stage.raceId);
        if (!entry) return null;
        const isCurrentPlayer = entry.playerId === identity?.playerId;
        const pb = isCurrentPlayer
            ? null
            : await readCampaignPbRecord(stage.raceId, entry.playerId);
        return {
            rank: safeOffset + index + 1,
            displayName: entry.displayName,
            bestTimeMs: entry.bestTimeMs,
            medal: entry.medal,
            updatedAt: entry.updatedAt,
            isCurrentPlayer,
            opponentRaceAvailable: !isCurrentPlayer && isCompleteCampaignOpponentRecord(entry, pb),
        };
    }))).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const playerRankZeroBased = identity
        ? await redis.zRank(leaderboardKey(stage.raceId), identity.playerId)
        : undefined;
    const playerRank = Number.isFinite(playerRankZeroBased) ? Number(playerRankZeroBased) + 1 : null;
    const playerEntry = identity
        ? parseLeaderboardEntry(
            await redis.hGet(entryHashKey(stage.raceId), identity.playerId),
            stage.raceId,
        )
        : null;
    return {
        status: 200,
        body: {
            race: stage,
            rows,
            currentPlayerRow: playerEntry && playerRank ? {
                rank: playerRank,
                displayName: playerEntry.displayName,
                bestTimeMs: playerEntry.bestTimeMs,
                medal: playerEntry.medal,
                updatedAt: playerEntry.updatedAt,
                isCurrentPlayer: true,
                opponentRaceAvailable: false,
            } : null,
            totalCount,
            pageOffset: safeOffset,
            pageLimit: safeLimit,
            hasMore: safeOffset + safeLimit < totalCount,
            nextOffset: safeOffset + safeLimit < totalCount ? safeOffset + safeLimit : null,
        },
    };
}

type CampaignOpponentSelection = {
    kind: 'row';
    rank: number;
    displayName: string;
    bestTimeMs: number;
    updatedAt: string;
} | {
    kind: 'next-faster';
    benchmarkTimeMs?: number;
};

function normalizeCampaignOpponentSelection(value: unknown): CampaignOpponentSelection | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const selection = value as Record<string, unknown>;
    if (selection.kind === 'row') {
        if (
            !Number.isInteger(selection.rank)
            || Number(selection.rank) < 1
            || typeof selection.displayName !== 'string'
            || !selection.displayName
            || !Number.isSafeInteger(selection.bestTimeMs)
            || Number(selection.bestTimeMs) <= 0
            || typeof selection.updatedAt !== 'string'
            || !selection.updatedAt
        ) return null;
        return {
            kind: 'row',
            rank: Number(selection.rank),
            displayName: selection.displayName,
            bestTimeMs: Number(selection.bestTimeMs),
            updatedAt: selection.updatedAt,
        };
    }
    if (selection.kind === 'next-faster') {
        const benchmarkTimeMs = Number(selection.benchmarkTimeMs);
        return {
            kind: 'next-faster',
            benchmarkTimeMs: Number.isSafeInteger(benchmarkTimeMs) && benchmarkTimeMs > 0
                ? benchmarkTimeMs
                : undefined,
        };
    }
    return null;
}

export async function prepareServerCampaignLeaderboardRace({
    raceId,
    redditUsername,
    selection: rawSelection,
}: {
    raceId?: unknown;
    redditUsername?: unknown;
    selection?: unknown;
}) {
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.', reason: 'race_not_found' } };
    const identity = signedInIdentity(redditUsername);
    if (identity) {
        const progress = await readProgress(identity.playerId);
        if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
            return { status: 403, body: { error: 'Campaign race is locked.', reason: 'race_locked' } };
        }
    }
    const selection = normalizeCampaignOpponentSelection(rawSelection);
    if (!selection) {
        return { status: 400, body: { error: 'Opponent selection is invalid.', reason: 'invalid_selection' } };
    }

    const key = leaderboardKey(stage.raceId);
    let rankedCandidates: Array<{ member: string; rank: number }> = [];
    let benchmarkTimeMs: number | undefined;
    if (selection.kind === 'row') {
        const ranked = await redis.zRange(key, selection.rank - 1, selection.rank - 1);
        rankedCandidates = ranked.map((row) => ({ member: row.member, rank: selection.rank }));
    } else {
        const ownRankZeroBased = identity
            ? await redis.zRank(key, identity.playerId)
            : undefined;
        const ownEntry = identity
            ? parseLeaderboardEntry(
                await redis.hGet(entryHashKey(stage.raceId), identity.playerId),
                stage.raceId,
            )
            : null;
        benchmarkTimeMs = ownEntry?.bestTimeMs ?? selection.benchmarkTimeMs;
        if (!Number.isFinite(benchmarkTimeMs)) {
            return { status: 409, body: { error: 'Set a time before choosing the next opponent.', reason: 'benchmark_required' } };
        }
        const totalCount = await redis.zCard(key);
        const stop = Number.isFinite(ownRankZeroBased)
            ? Number(ownRankZeroBased) - 1
            : totalCount - 1;
        const ranked = stop >= 0 ? await redis.zRange(key, 0, stop) : [];
        rankedCandidates = ranked
            .map((row, index) => ({ member: row.member, rank: index + 1 }))
            .reverse();
    }

    for (const candidate of rankedCandidates) {
        if (candidate.member === identity?.playerId) {
            if (selection.kind === 'row') {
                return { status: 409, body: { error: 'Choose another player to race.', reason: 'self_selection' } };
            }
            continue;
        }
        const entry = parseLeaderboardEntry(
            await redis.hGet(entryHashKey(stage.raceId), candidate.member),
            stage.raceId,
        );
        if (!entry) continue;
        if (selection.kind === 'next-faster' && (!benchmarkTimeMs || entry.bestTimeMs >= benchmarkTimeMs)) {
            continue;
        }
        if (
            selection.kind === 'row'
            && (
                entry.displayName !== selection.displayName
                || entry.bestTimeMs !== selection.bestTimeMs
                || entry.updatedAt !== selection.updatedAt
            )
        ) {
            return { status: 409, body: { error: 'Leaderboard row changed. Refresh and choose again.', reason: 'selection_changed' } };
        }
        const record = await readCampaignPbRecord(stage.raceId, candidate.member);
        if (!isCompleteCampaignOpponentRecord(entry, record)) {
            if (selection.kind === 'row') {
                return { status: 409, body: { error: 'That opponent ghost is unavailable.', reason: 'ghost_unavailable' } };
            }
            continue;
        }
        return {
            status: 200,
            body: {
                mode: 'campaign',
                race: stage,
                target: {
                    rank: candidate.rank,
                    displayName: entry.displayName,
                    bestTimeMs: entry.bestTimeMs,
                    checkpointTimesSec: record!.checkpointTimesSec,
                    lapCompletionTimesSec: record!.lapCompletionTimesSec,
                    updatedAt: entry.updatedAt,
                    ghost: record!.ghost,
                },
            },
        };
    }
    return { status: 404, body: { error: 'No faster opponent ghost is available.', reason: 'no_faster_opponent' } };
}

async function checkRateLimit(raceId: string, playerId: string) {
    const key = submissionRateLimitKey(raceId, playerId);
    const count = await redis.incrBy(key, 1);
    if (count === 1) await redis.expire(key, SUBMISSION_RATE_LIMIT_WINDOW_SECONDS);
    if (count <= SUBMISSION_RATE_LIMIT_MAX_REQUESTS) return { allowed: true as const };
    const expiresAt = await redis.expireTime(key);
    return {
        allowed: false as const,
        retryAfterSeconds: Number.isFinite(expiresAt) && expiresAt > 0
            ? Math.max(1, expiresAt - Math.floor(Date.now() / 1000))
            : SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
    };
}

export async function submitServerCampaignRun({
    raceId,
    trackKey,
    replay,
    redditUsername,
}: {
    raceId?: unknown;
    trackKey?: unknown;
    replay?: unknown;
    redditUsername?: unknown;
    requestRateLimitIdentity?: unknown;
} = {}) {
    const identity = signedInIdentity(redditUsername);
    if (!identity) return { ...unauthorized(), body: { accepted: false, error: 'Sign in with Reddit to submit Campaign results.' } };
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { accepted: false, error: 'Campaign race not found.' } };
    if (trackKey !== stage.trackKey) {
        return { status: 422, body: { accepted: false, error: 'Submission track does not match Campaign race.', reason: 'track_mismatch' } };
    }
    const progress = await readProgress(identity.playerId);
    if (!isCampaignStageUnlocked(stage.raceId, progress.resultsByRaceId)) {
        return { status: 403, body: { accepted: false, error: 'Campaign race is locked.' } };
    }
    const rateLimit = await checkRateLimit(stage.raceId, identity.playerId);
    if (!rateLimit.allowed) {
        return {
            status: 429,
            body: {
                accepted: false,
                error: 'Too many submission attempts. Try again soon.',
                retryAfterSeconds: rateLimit.retryAfterSeconds,
            },
        };
    }
    const replayChallenge = {
        id: stage.raceId,
        challengeDate: CAMPAIGN_ID,
        trackKey: stage.trackKey,
        startsAt: '1970-01-01T00:00:00.000Z',
        endsAt: '9999-12-31T23:59:59.999Z',
        availableUntil: '9999-12-31T23:59:59.999Z',
        status: 'active' as const,
        rulesRevision: stage.rulesRevision as 1,
        objectiveType: stage.lapCount === 1 ? 'single_lap_fastest' as const : 'multi_lap_total' as const,
        objectiveParams: { lapCount: stage.lapCount },
        skin: 'default' as const,
    };
    const validation = validateDailyGpReplayDetailed({ challenge: replayChallenge, replay });
    if (!validation.ok) {
        return {
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: validation.failure.reason,
            },
        };
    }
    if (validation.run.completedLaps !== stage.lapCount) {
        return {
            status: 422,
            body: { accepted: false, error: 'Campaign race was not completed.', reason: 'lap_count_mismatch' },
        };
    }
    const track = TRACKS[stage.trackKey];
    if (!track) return { status: 500, body: { accepted: false, error: 'Campaign track is unavailable.' } };
    const bestTimeMs = validation.run.bestTimeMs;
    const checkpointTimesSec = normalizeCheckpointTimesSec(
        validation.run.bestTimeSec,
        validation.run.checkpointTimesSec,
    ) ?? validation.run.checkpointTimesSec ?? null;
    const medal = getMedalForRaceTime(stage.trackKey, validation.run.bestTimeSec, stage.lapCount);
    const nowIso = new Date().toISOString();
    const result: CampaignBestResult = {
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        rulesRevision: stage.rulesRevision,
        bestTimeMs,
        medal,
        checkpointTimesSec,
        updatedAt: nowIso,
    };
    const lock = await acquireRedisLock(
        submissionLockKey(stage.raceId, identity.playerId),
        SUBMISSION_LOCK_TTL_MS,
        redis,
    );
    if (!lock) {
        return {
            status: 429,
            body: { accepted: false, error: 'Submission already in progress. Try again in a moment.', retryAfterSeconds: 1 },
        };
    }
    let storedResult = result;
    let improved = false;
    try {
        const freshProgress = await readProgress(identity.playerId);
        const previous = freshProgress.resultsByRaceId[stage.raceId] ?? null;
        if (previous && previous.bestTimeMs <= bestTimeMs) {
            storedResult = previous;
        } else {
            improved = true;
            const nextProgress: CampaignProgress = {
                campaignId: CAMPAIGN_ID,
                startedAt: freshProgress.startedAt || nowIso,
                resultsByRaceId: { ...freshProgress.resultsByRaceId, [stage.raceId]: result },
                updatedAt: nowIso,
            };
            const entry: CampaignLeaderboardEntry = {
                ...result,
                playerId: identity.playerId,
                displayName: identity.username,
            };
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) {
                return { status: 503, body: { accepted: false, error: 'Submission save was interrupted. Try again.' } };
            }
            await transaction.set(
                progressKey(identity.playerId),
                JSON.stringify(nextProgress),
            );
            await transaction.hSet(entryHashKey(stage.raceId), {
                [identity.playerId]: JSON.stringify(entry),
            });
            await transaction.zAdd(leaderboardKey(stage.raceId), {
                member: identity.playerId,
                score: bestTimeMs,
            });
            const transactionResults = await transaction.exec();
            if (!Array.isArray(transactionResults) || transactionResults.length === 0) {
                return { status: 503, body: { accepted: false, error: 'Submission save was interrupted. Try again.' } };
            }
        }
        let ghostPersistenceStatus: 'stored' | 'unchanged' | 'unavailable' = 'unchanged';
        if (improved) {
            try {
                const pb: CampaignPbRecord = {
                    ...result,
                    schemaVersion: PB_GHOST_SCHEMA_VERSION,
                    simulationRevision: PB_GHOST_SIMULATION_REVISION,
                    trackFingerprint: createTrackFingerprint(track),
                    lapCompletionTimesSec: normalizeLapCompletionTimesSec(
                        validation.run.bestTimeSec,
                        validation.run.lapCompletionTimesSec,
                        stage.lapCount,
                    ),
                    ghost: validation.run.ghost ?? null,
                };
                await redisCompressed.hSet(pbHashKey(stage.raceId), {
                    [playerField(identity.playerId)]: JSON.stringify(pb),
                });
                ghostPersistenceStatus = 'stored';
            } catch (error) {
                ghostPersistenceStatus = 'unavailable';
                console.error('Campaign PB ghost persistence failed after accepted result:', error);
            }
        }
        const finalProgress = await readProgress(identity.playerId);
        return {
            status: 200,
            body: {
                accepted: true,
                improved,
                result: storedResult,
                progress: publicProgress(finalProgress),
                ghostPersistenceStatus,
            },
        };
    } finally {
        try {
            await releaseRedisLock(lock, redis);
        } catch (error) {
            console.error('Campaign submission lock cleanup failed:', error);
        }
    }
}

export async function getServerCampaignPbGhost({
    raceId,
    redditUsername,
}: {
    raceId?: unknown;
    redditUsername?: unknown;
} = {}) {
    const identity = signedInIdentity(redditUsername);
    if (!identity) return unauthorized();
    const stage = getCampaignStage(raceId);
    if (!stage) return { status: 404, body: { error: 'Campaign race not found.' } };
    const raw = await redisCompressed.hGet(pbHashKey(stage.raceId), playerField(identity.playerId));
    const personalBest = parsePbRecord(raw, stage.raceId);
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

export async function getServerCampaignChallengeSource({
    raceId,
    redditUsername,
}: {
    raceId?: unknown;
    redditUsername?: unknown;
} = {}) {
    const identity = signedInIdentity(redditUsername);
    const stage = getCampaignStage(raceId);
    if (!identity || !stage) return null;
    const personalBest = parsePbRecord(
        await redisCompressed.hGet(pbHashKey(stage.raceId), playerField(identity.playerId)),
        stage.raceId,
    );
    if (!personalBest?.ghost) return null;
    return {
        sourceKind: 'campaign' as const,
        sourceId: stage.raceId,
        campaignId: CAMPAIGN_ID,
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        bestTimeMs: personalBest.bestTimeMs,
        medal: personalBest.medal,
        rulesRevision: stage.rulesRevision,
        trackFingerprint: personalBest.trackFingerprint,
        ghost: personalBest.ghost,
    };
}
