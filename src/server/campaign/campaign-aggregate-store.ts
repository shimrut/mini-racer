import { redis, type TxClientLike } from '@devvit/redis';
import { getCampaignFinalStage } from '../../../game/campaign/manifest.js';
import { getCampaignAggregateTotalTimeMs } from '../../../game/campaign/aggregate.js';
import { toCampaignCompetition } from '../competition/competition.js';
import { readPlayerProfileMap } from '../competition/competition-identity.js';
import { type SnapshotRow } from '../competition/competition-leaderboard.js';
import { DAILY_GP_NEARBY_RADIUS, formatRankLabel } from '../daily/daily-gp-model.js';
import { resolveLeaderboardDisplayName } from '../../../game/shared/leaderboard-identity.js';
import { cacheSharedJson } from '../redis/shared-cache.js';
import {
    acquireRedisLock, beginOwnedRedisLockTransaction, commitOwnedRedisLockTransaction,
    releaseRedisLock,
} from '../redis/redis-lock.js';

// A sealed Campaign has one permanent ranked stage set and one derived board.
export function campaignAggregateKeys(seriesId: string) {
    const prefix = `campaign:${seriesId}:aggregate:v1`;
    return {
        leaderboard: `${prefix}:leaderboard`, revision: `${prefix}:revision`,
        fillState: `${prefix}:fill-state`, fillReady: `${prefix}:fill-ready`, fillLock: `${prefix}:fill-lock`,
    };
}

export async function campaignAggregateNeedsUpdate(
    playerId: string, seriesId: string, resultsByRaceId: Record<string, unknown>,
): Promise<boolean> {
    const total = getCampaignAggregateTotalTimeMs(seriesId, resultsByRaceId);
    const score = await redis.zScore(campaignAggregateKeys(seriesId).leaderboard, playerId);
    return total === null ? score !== null && score !== undefined : Number(score) !== total;
}

// Runs inside the source progress's owned transaction, including guest merge.
export async function queueCampaignAggregate(
    transaction: TxClientLike, playerId: string, seriesId: string, resultsByRaceId: Record<string, unknown>,
): Promise<void> {
    if (!await campaignAggregateNeedsUpdate(playerId, seriesId, resultsByRaceId)) return;
    const keys = campaignAggregateKeys(seriesId);
    const total = getCampaignAggregateTotalTimeMs(seriesId, resultsByRaceId);
    if (total === null) await transaction.zRem(keys.leaderboard, [playerId]);
    else await transaction.zAdd(keys.leaderboard, { member: playerId, score: total });
    await transaction.incrBy(keys.revision, 1);
}

export async function queueRemoveCampaignAggregate(
    transaction: TxClientLike, seriesId: string, playerIds: string[],
): Promise<boolean> {
    const keys = campaignAggregateKeys(seriesId);
    const scores = await Promise.all(playerIds.map((playerId) => redis.zScore(keys.leaderboard, playerId)));
    const members = playerIds.filter((_playerId, index) => scores[index] !== null && scores[index] !== undefined);
    if (!members.length) return false;
    await transaction.zRem(keys.leaderboard, members);
    await transaction.incrBy(keys.revision, 1);
    return true;
}

const FILL_PAGE_SIZE = 10;
const FILL_LOCK_TTL_MS = 55_000;
type FillState = { finalStageId: string; cursor: number; scanned: boolean; pending: string[]; queued: string[] };

function parseFillState(raw: string | null | undefined, finalStageId: string): FillState | null {
    try {
        const state = raw ? JSON.parse(raw) : null;
        return state?.finalStageId === finalStageId && Number.isInteger(state.cursor)
            && state.cursor >= 0 && typeof state.scanned === 'boolean'
            && Array.isArray(state.pending) && state.pending.every((id: unknown) => typeof id === 'string')
            && (state.queued === undefined || (Array.isArray(state.queued) && state.queued.every((id: unknown) => typeof id === 'string')))
            // Older builds persisted a rollout delay. Keep their cursor and
            // retry work, but resume the inventory immediately.
            ? { finalStageId, cursor: state.cursor, scanned: state.scanned,
                pending: state.pending, queued: state.queued ?? [] } : null;
    } catch (_error) { return null; }
}

// Candidate reconciliation owns the same player progress lock and transfer
// fences as online saves. false means retry later; it never loses that owner
// by advancing a cursor after a busy save or account transfer.
export async function runCampaignAggregateFill(
    seriesId: string, reconcile: (playerId: string) => Promise<boolean>,
): Promise<boolean> {
    const finalStage = getCampaignFinalStage(seriesId);
    if (!finalStage) return false;
    const keys = campaignAggregateKeys(seriesId);
    if (await redis.get(keys.fillReady) === finalStage.raceId) return true;
    const lock = await acquireRedisLock(keys.fillLock, FILL_LOCK_TTL_MS, redis);
    if (!lock) return false;
    try {
        const stored = parseFillState(await redis.get(keys.fillState), finalStage.raceId);
        const state: FillState = stored ?? {
            finalStageId: finalStage.raceId, cursor: 0, scanned: false, pending: [], queued: [],
        };
        // Reserve part of the hard budget for fresh candidates, so one busy
        // owner cannot starve later pages. HSCAN COUNT is only a hint: overflow
        // stays in queued rather than causing an unbounded request.
        const hasNewWork = !state.scanned || state.queued.length > 0;
        const retry = state.pending.splice(0, hasNewWork ? Math.floor(FILL_PAGE_SIZE / 2) : FILL_PAGE_SIZE);
        if (!state.scanned && state.queued.length === 0) {
            const competition = toCampaignCompetition(seriesId, finalStage);
            const page = await redis.hScan(competition.entryHashKey, state.cursor, undefined, FILL_PAGE_SIZE);
            state.queued = [...new Set(page.fieldValues.map(({ field }) => field))]
                .filter((id) => !state.pending.includes(id) && !retry.includes(id));
            state.cursor = page.cursor;
            state.scanned = page.cursor === 0;
        }
        const candidates = state.queued.splice(0, FILL_PAGE_SIZE - retry.length);
        for (const playerId of [...retry, ...candidates]) {
            if (!await reconcile(playerId) && !state.pending.includes(playerId)) state.pending.push(playerId);
        }
        const ready = state.scanned && state.pending.length === 0 && state.queued.length === 0;
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) return false;
        if (ready) {
            await transaction.set(keys.fillReady, finalStage.raceId);
            await transaction.del(keys.fillState);
        } else await transaction.set(keys.fillState, JSON.stringify(state));
        return await commitOwnedRedisLockTransaction(transaction) && ready;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => console.error('Campaign aggregate fill lock cleanup failed:', error));
    }
}

type SharedPage = { leaderboardEntryCount: number; rows: { playerId: string; row: SnapshotRow }[] };

async function readPage(seriesId: string, offset: number, limit: number): Promise<SharedPage> {
    const keys = campaignAggregateKeys(seriesId);
    const revision = await redis.get(keys.revision) ?? '0';
    return cacheSharedJson(async () => {
        const [leaderboardEntryCount, members] = await Promise.all([
            redis.zCard(keys.leaderboard), redis.zRange(keys.leaderboard, offset, offset + limit - 1),
        ]);
        const profiles = await readPlayerProfileMap(members.map((member) => member.member));
        return {
            leaderboardEntryCount,
            rows: members.map(({ member: playerId, score }, index) => {
                const profile = profiles.get(playerId);
                const rank = offset + index + 1;
                return { playerId, row: {
                    rank, rankLabel: formatRankLabel(rank) || '--',
                    displayName: resolveLeaderboardDisplayName({ playerId,
                        preference: profile?.leaderboardIdentity, redditUsername: profile?.redditUsername }),
                    bestTime: score / 1000, bestTimeMs: score, updatedAt: '',
                    isCurrentPlayer: false, completedLaps: null, checkpointTimesSec: null, opponentRaceAvailable: false,
                } };
            }),
        };
    }, { key: `${keys.leaderboard}:page:${revision}:${offset}:${limit}`, ttl: 10 });
}

export async function readCampaignAggregateSnapshot({ seriesId, playerId, totalTimeMs, limit, offset, ready }: {
    seriesId: string; playerId: string; totalTimeMs: number; limit: number; offset: number; ready: boolean;
}) {
    const base = {
        seriesId, finalStageId: getCampaignFinalStage(seriesId)?.raceId ?? null, totalTimeMs,
        topRows: [] as SnapshotRow[], nearbyRows: [] as SnapshotRow[], currentPlayerRow: null as SnapshotRow | null,
        totalCount: 0, leaderboardEntryCount: 0, playerRank: null as number | null, playerRankLabel: null as string | null,
        pageOffset: offset, pageLimit: limit, hasMore: false, nextOffset: null as number | null, ready,
    };
    if (!ready) return base;
    const keys = campaignAggregateKeys(seriesId);
    const [page, rankZero, indexedTotal] = await Promise.all([
        readPage(seriesId, offset, limit), redis.zRank(keys.leaderboard, playerId), redis.zScore(keys.leaderboard, playerId),
    ]);
    // Another accepted stage improvement may commit after the source repair.
    // Its derived score is canonical too; pair the live place with that score.
    const currentTotalTimeMs = Number.isSafeInteger(indexedTotal) && Number(indexedTotal) > 0
        ? Number(indexedTotal) : totalTimeMs;
    const playerRank = Number.isFinite(rankZero) ? Number(rankZero) + 1 : null;
    const profiles = playerRank ? await readPlayerProfileMap([playerId]) : new Map();
    const profile = profiles.get(playerId);
    const currentPlayerRow: SnapshotRow | null = playerRank ? {
        rank: playerRank, rankLabel: formatRankLabel(playerRank) || '--',
        displayName: resolveLeaderboardDisplayName({ playerId, preference: profile?.leaderboardIdentity,
            redditUsername: profile?.redditUsername }), bestTime: currentTotalTimeMs / 1000, bestTimeMs: currentTotalTimeMs,
        updatedAt: '', isCurrentPlayer: true, completedLaps: null, checkpointTimesSec: null, opponentRaceAvailable: false,
    } : null;
    const visibleRows = (source: SharedPage) => source.rows.map(({ playerId: owner, row }) => (
        owner === playerId && currentPlayerRow ? currentPlayerRow : row
    ));
    const outsidePage = playerRank && (playerRank <= offset || playerRank > offset + limit);
    const nearby = outsidePage ? await readPage(seriesId,
        Math.max(0, playerRank - DAILY_GP_NEARBY_RADIUS - 1), DAILY_GP_NEARBY_RADIUS * 2 + 1) : null;
    const hasMore = offset + limit < page.leaderboardEntryCount;
    return { ...base, totalTimeMs: currentTotalTimeMs,
        topRows: visibleRows(page), nearbyRows: nearby ? visibleRows(nearby) : [], currentPlayerRow,
        totalCount: page.leaderboardEntryCount, leaderboardEntryCount: page.leaderboardEntryCount,
        playerRank, playerRankLabel: formatRankLabel(playerRank), hasMore, nextOffset: hasMore ? offset + limit : null };
}
