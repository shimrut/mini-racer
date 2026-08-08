/**
 * One ranked board, shared across modes — lifted from Daily's implementation
 * unchanged and re-parameterised on a Competition, so Campaign reports the
 * same snapshot shape instead of a second payload the client has to adapt.
 * Redis keys arrive pre-built on the descriptor; nothing here templates one.
 */
import { redis } from '@devvit/redis';
import {
    DAILY_GP_NEARBY_RADIUS,
    encodeDailyGpLeaderboardScore,
    formatRankLabel,
    type DailyGpLeaderboardEntry,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { createSharedStandingsCacheKey, type Competition } from './competition.js';
import { readPlayerProfileMap } from './competition-identity.js';
import { getPlayerTrackPbRecord, type PlayerTrackPbRecord } from './pb-ghost-store.js';
import { normalizeCheckpointTimesSec } from '../../game/shared/checkpoint-times.js';
import { resolveLeaderboardDisplayName } from '../../game/shared/leaderboard-identity.js';
import { TRACKS } from '../../game/track/tracks.js';
import { cacheSharedJson } from './shared-cache.js';

const SHARED_STANDINGS_PAGE_TTL_SECONDS = 10;

export type SnapshotRow = {
    rank: number;
    rankLabel: string;
    displayName: string;
    bestTime: number;
    bestTimeMs: number;
    updatedAt: string;
    isCurrentPlayer: boolean;
    completedLaps: number | null;
    checkpointTimesSec: number[] | null;
    opponentRaceAvailable: boolean;
};

export function parseStoredEntry(
    raw: string | null | undefined,
    expectedTrackKey?: string,
): DailyGpLeaderboardEntry | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (
            !parsed
            || typeof parsed !== 'object'
            || typeof parsed.playerId !== 'string'
            || !parsed.playerId
            || !Number.isFinite(parsed.bestTimeMs)
            || typeof parsed.updatedAt !== 'string'
            || !parsed.updatedAt
        ) {
            return null;
        }

        const parsedTrackKey = typeof parsed.trackKey === 'string' && parsed.trackKey
            ? parsed.trackKey
            : null;
        if (expectedTrackKey && parsedTrackKey && parsedTrackKey !== expectedTrackKey) {
            return null;
        }

        const bestTimeMs = Number(parsed.bestTimeMs);
        const checkpointTimesSec = normalizeCheckpointTimesSec(
            bestTimeMs / 1000,
            parsed.checkpointTimesSec,
        );

        return {
            playerId: parsed.playerId,
            trackKey: parsedTrackKey || expectedTrackKey || '',
            bestTimeMs,
            updatedAt: parsed.updatedAt,
            completedLaps: parsed.completedLaps === 1
                || parsed.completedLaps === 2
                || parsed.completedLaps === 3
                ? parsed.completedLaps
                : null,
            checkpointTimesSec,
            validationMethod: parsed.validationMethod === 'strict-replay'
                ? parsed.validationMethod
                : undefined,
            strictReplayFailureReason: typeof parsed.strictReplayFailureReason === 'string'
                ? parsed.strictReplayFailureReason
                : null,
        };
    } catch (_error) {
        return null;
    }
}

export function toSnapshotRow(
    entry: DailyGpLeaderboardEntry,
    rank: number,
    currentPlayerId: string | null,
    profileMap: Map<string, DailyGpPlayerProfile>,
    opponentRaceAvailable = false,
): SnapshotRow {
    const profile = profileMap.get(entry.playerId);
    const isCurrentPlayer = entry.playerId === currentPlayerId;
    return {
        rank,
        rankLabel: formatRankLabel(rank) || '--',
        displayName: resolveLeaderboardDisplayName({
            playerId: entry.playerId,
            preference: profile?.leaderboardIdentity,
            redditUsername: profile?.redditUsername,
        }),
        bestTime: entry.bestTimeMs / 1000,
        bestTimeMs: entry.bestTimeMs,
        updatedAt: entry.updatedAt,
        isCurrentPlayer,
        completedLaps: entry.completedLaps,
        checkpointTimesSec: entry.checkpointTimesSec ?? null,
        opponentRaceAvailable: !isCurrentPlayer && opponentRaceAvailable,
    };
}

/**
 * The leaderboard entry and the PB record are written by two concurrent writes,
 * and before they shared a timestamp they always disagreed by a few
 * milliseconds. The run identity that matters is the time itself: an exact
 * best-time match on both the record and its trace pins the ghost to this
 * leaderboard row without stranding every entry set before that fix.
 */
export function isCompleteOpponentRecord(
    entry: DailyGpLeaderboardEntry,
    record: PlayerTrackPbRecord | null,
    competition: Competition,
): boolean {
    const checkpointCount = (TRACKS[competition.trackKey]?.checkpoints?.length || 0)
        * competition.lapCount;
    return Boolean(
        record?.ghost
        && record.bestTimeMs === entry.bestTimeMs
        && record.ghost.finishTimeMs === entry.bestTimeMs
        && Array.isArray(record.checkpointTimesSec)
        && record.checkpointTimesSec.length === checkpointCount,
    );
}

export async function readEntryByPlayerId(
    competition: Competition,
    playerId: string,
): Promise<DailyGpLeaderboardEntry | null> {
    const rawEntry = await redis.hGet(competition.entryHashKey, playerId);
    return parseStoredEntry(rawEntry, competition.trackKey);
}

export async function readRowsByRankRange(
    competition: Competition,
    start: number,
    stop: number,
    currentPlayerId: string | null,
): Promise<SnapshotRow[]> {
    if (stop < start || start < 0) {
        return [];
    }

    const rankedMembers = await redis.zRange(competition.leaderboardKey, start, stop);
    return readRowsForRankedMembers(competition, rankedMembers, start, currentPlayerId);
}

async function readRowsForRankedMembers(
    competition: Competition,
    rankedMembers: Array<{ member: string }>,
    start: number,
    currentPlayerId: string | null,
): Promise<SnapshotRow[]> {
    if (!rankedMembers.length) {
        return [];
    }

    const rawEntries = await redis.hMGet(
        competition.entryHashKey,
        rankedMembers.map((member) => member.member),
    );
    const profileMap = await readPlayerProfileMap(
        rankedMembers.map((member) => member.member),
    );

    const rows = await Promise.all(rankedMembers
        .map(async (member, index) => {
            const storedEntry = parseStoredEntry(rawEntries[index], competition.trackKey);
            if (!storedEntry) return null;
            const record = member.member === currentPlayerId
                ? null
                : await getPlayerTrackPbRecord({
                    playerId: member.member,
                    competition,
                    track: TRACKS[competition.trackKey],
                });
            return toSnapshotRow(
                storedEntry,
                start + index + 1,
                currentPlayerId,
                profileMap,
                isCompleteOpponentRecord(storedEntry, record, competition),
            );
        }));
    return rows
        .filter((entry): entry is SnapshotRow => Boolean(entry));
}

export async function readPlayerRank(
    competition: Competition,
    playerId: string | null,
): Promise<number | null> {
    if (!playerId) return null;
    const rankZeroBased = await redis.zRank(competition.leaderboardKey, playerId);
    return Number.isFinite(rankZeroBased) ? Number(rankZeroBased) + 1 : null;
}

/**
 * Adds the row to the board inside the caller's transaction. A permanent
 * competition carries no TTL, so the expiry calls are skipped rather than
 * written with a sentinel that would quietly delete the board.
 */
export async function writeEntry(
    competition: Competition,
    playerId: string,
    entry: DailyGpLeaderboardEntry,
    transaction: {
        hSet(key: string, values: Record<string, string>): Promise<unknown>;
        zAdd(key: string, member: { member: string; score: number }): Promise<unknown>;
        incrBy(key: string, value: number): Promise<unknown>;
        expire(key: string, seconds: number): Promise<unknown>;
    },
): Promise<void> {
    await transaction.hSet(competition.entryHashKey, {
        [playerId]: JSON.stringify(entry),
    });
    await transaction.zAdd(competition.leaderboardKey, {
        member: playerId,
        score: encodeDailyGpLeaderboardScore(entry.bestTimeMs),
    });
    // This is intentionally in the same transaction as the ranked write: a
    // snapshot can never use a pre-write cache generation after this succeeds.
    await transaction.incrBy(competition.standingsRevisionKey, 1);
    if (
        playerId.startsWith('guest:')
        && competition.guestExpiryKey
        && competition.guestRetentionSeconds
    ) {
        await transaction.zAdd(competition.guestExpiryKey, {
            member: playerId,
            score: Date.now() + competition.guestRetentionSeconds * 1000,
        });
    }
    if (competition.ttlSeconds != null) {
        await transaction.expire(competition.leaderboardKey, competition.ttlSeconds);
        await transaction.expire(competition.entryHashKey, competition.ttlSeconds);
        await transaction.expire(competition.standingsRevisionKey, competition.ttlSeconds);
    }
}

export type SnapshotPayload = {
    topRows: SnapshotRow[];
    nearbyRows: SnapshotRow[];
    currentPlayerRow: SnapshotRow | null;
    totalCount: number;
    leaderboardEntryCount: number;
    objectiveType: string;
    playerRank: number | null;
    playerRankLabel: string | null;
    pageOffset: number;
    pageLimit: number;
    hasMore: boolean;
    nextOffset: number | null;
};

export function createEmptySnapshot(
    competition: Competition,
    pageLimit = 0,
): SnapshotPayload {
    return {
        topRows: [],
        nearbyRows: [],
        currentPlayerRow: null,
        totalCount: 0,
        leaderboardEntryCount: 0,
        objectiveType: competition.objectiveType,
        playerRank: null,
        playerRankLabel: null,
        pageOffset: 0,
        pageLimit,
        hasMore: false,
        nextOffset: null,
    };
}

type SharedStandingsRow = {
    playerId: string;
    row: SnapshotRow;
};

type SharedStandingsPage = {
    leaderboardEntryCount: number;
    rows: SharedStandingsRow[];
};

function isSharedStandingsPage(value: unknown): value is SharedStandingsPage {
    if (!value || typeof value !== 'object') return false;
    const page = value as { leaderboardEntryCount?: unknown; rows?: unknown };
    if (!Number.isInteger(page.leaderboardEntryCount) || page.leaderboardEntryCount! < 0) {
        return false;
    }
    return Array.isArray(page.rows) && page.rows.every((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const candidate = entry as { playerId?: unknown; row?: unknown };
        return typeof candidate.playerId === 'string'
            && Boolean(candidate.playerId)
            && isSnapshotRow(candidate.row);
    });
}

function isSnapshotRow(value: unknown): value is SnapshotRow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<SnapshotRow>;
    return Number.isInteger(row.rank)
        && typeof row.rankLabel === 'string'
        && typeof row.displayName === 'string'
        && Number.isFinite(row.bestTime)
        && Number.isFinite(row.bestTimeMs)
        && typeof row.updatedAt === 'string'
        && typeof row.isCurrentPlayer === 'boolean'
        && (row.completedLaps === null || row.completedLaps === 1 || row.completedLaps === 2 || row.completedLaps === 3)
        && (row.checkpointTimesSec === null || (
            Array.isArray(row.checkpointTimesSec)
            && row.checkpointTimesSec.every((time) => Number.isFinite(time))
        ))
        && typeof row.opponentRaceAvailable === 'boolean';
}

async function readSharedStandingsPageSource(
    competition: Competition,
    offset: number,
    limit: number,
): Promise<SharedStandingsPage> {
    const leaderboardEntryCount = await redis.zCard(competition.leaderboardKey);
    if (leaderboardEntryCount === 0) {
        return { leaderboardEntryCount: 0, rows: [] };
    }
    const rankedMembers = await redis.zRange(
        competition.leaderboardKey,
        offset,
        offset + limit - 1,
    );
    const rows = await readRowsForRankedMembers(competition, rankedMembers, offset, null);
    return {
        leaderboardEntryCount,
        // Redis' sorted-set response is the authority for row ownership. Invalid
        // stored entries are omitted from rows just as they were before caching.
        rows: rows.map((row) => ({
            playerId: rankedMembers[row.rank - offset - 1]?.member ?? '',
            row: { ...row, isCurrentPlayer: false },
        })).filter((entry) => Boolean(entry.playerId)),
    };
}

async function readSharedStandingsPage(
    competition: Competition,
    offset: number,
    limit: number,
): Promise<SharedStandingsPage> {
    const rawRevision = await redis.get(competition.standingsRevisionKey);
    const revision = Number.isSafeInteger(Number(rawRevision)) && Number(rawRevision) >= 0
        ? Number(rawRevision)
        : 0;
    const cached = await cacheSharedJson(
        async () => readSharedStandingsPageSource(competition, offset, limit) as never,
        {
            key: createSharedStandingsCacheKey(competition, offset, limit, revision),
            ttl: SHARED_STANDINGS_PAGE_TTL_SECONDS,
        },
    );
    return isSharedStandingsPage(cached)
        ? cached
        : readSharedStandingsPageSource(competition, offset, limit);
}

export async function readSnapshot({
    competition,
    playerId,
    limit,
    offset,
}: {
    competition: Competition;
    playerId: string | null;
    limit: number;
    offset: number;
}): Promise<SnapshotPayload> {
    const sharedPage = await readSharedStandingsPage(competition, offset, limit);
    const { leaderboardEntryCount } = sharedPage;
    const totalCount = leaderboardEntryCount;

    if (leaderboardEntryCount === 0) {
        return createEmptySnapshot(competition, limit);
    }

    let topRows = sharedPage.rows.map(({ row }) => ({ ...row, isCurrentPlayer: false }));
    const playerRank = leaderboardEntryCount
        ? await readPlayerRank(competition, playerId)
        : null;

    let currentPlayerRow: SnapshotRow | null = null;
    if (playerId && playerRank) {
        const storedEntry = await readEntryByPlayerId(competition, playerId);
        if (storedEntry) {
            const profileMap = await readPlayerProfileMap([playerId]);
            currentPlayerRow = toSnapshotRow(storedEntry, playerRank, playerId, profileMap);
            currentPlayerRow.isCurrentPlayer = true;
            const playerRowIndex = sharedPage.rows.findIndex((row) => row.playerId === playerId);
            if (playerRowIndex >= 0) {
                topRows[playerRowIndex] = { ...currentPlayerRow };
            }
        }
    }

    const paging = {
        pageOffset: offset,
        pageLimit: limit,
        hasMore: offset + limit < leaderboardEntryCount,
        nextOffset: offset + limit < leaderboardEntryCount ? offset + limit : null,
    };

    if (currentPlayerRow && sharedPage.rows.some((row) => row.playerId === playerId)) {
        return {
            topRows,
            nearbyRows: [],
            currentPlayerRow,
            totalCount,
            leaderboardEntryCount,
            objectiveType: competition.objectiveType,
            playerRank,
            playerRankLabel: formatRankLabel(playerRank),
            ...paging,
        };
    }

    let nearbyRows: SnapshotRow[] = [];
    const playerOutsidePage = Boolean(
        playerRank && (playerRank <= offset || playerRank > offset + limit),
    );
    if (playerOutsidePage && leaderboardEntryCount) {
        const nearbyStart = Math.max(0, (playerRank as number) - DAILY_GP_NEARBY_RADIUS - 1);
        const nearbyStop = nearbyStart + (DAILY_GP_NEARBY_RADIUS * 2);
        nearbyRows = await readRowsByRankRange(competition, nearbyStart, nearbyStop, playerId);
    }

    return {
        topRows,
        nearbyRows,
        currentPlayerRow,
        totalCount,
        leaderboardEntryCount,
        objectiveType: competition.objectiveType,
        playerRank,
        playerRankLabel: formatRankLabel(playerRank),
        ...paging,
    };
}
