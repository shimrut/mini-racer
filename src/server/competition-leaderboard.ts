import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    DAILY_GP_NEARBY_RADIUS,
    encodeDailyGpLeaderboardScore,
    formatRankLabel,
    type DailyGpLeaderboardEntry,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { createSharedStandingsCacheKey, type Competition } from './competition.js';
import { readPlayerProfileMap, type LoadedPlayerProfile } from './competition-identity.js';
import { getPlayerTrackPbRecords } from './pb-ghost-store.js';
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
            opponentRaceReady: parsed.opponentRaceReady === true
                ? true
                : parsed.opponentRaceReady === false ? false : undefined,
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

/** The leaderboard row and the PB record are written concurrently, so an exact best-time match on both is what pins a ghost to a row. */
export function isCompleteOpponentRecord(
    entry: DailyGpLeaderboardEntry,
    record: {
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        ghost?: { finishTimeMs: number } | null;
    } | null,
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

export function withOpponentRaceReady(
    entry: DailyGpLeaderboardEntry,
    record: {
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        ghost?: { finishTimeMs: number } | null;
    } | null,
    competition: Competition,
): DailyGpLeaderboardEntry {
    return {
        ...entry,
        opponentRaceReady: isCompleteOpponentRecord(entry, record, competition),
    };
}

/**
 * Does this identity still hold anything on this board: a stored entry, a ranking, or a stored
 * personal best. Presence is read raw and unparsed on purpose — a cleanup has to remove a row it
 * cannot parse just as surely as one it can, and a ranking can outlive the entry it came from.
 */
export async function competitionHoldsPlayerRows(
    competition: Competition,
    playerId: string,
): Promise<boolean> {
    const [rawEntry, rawPb, score] = await Promise.all([
        redis.hGet(competition.entryHashKey, playerId),
        redis.hGet(
            competition.pbHashKey,
            createHash('sha256').update(playerId, 'utf8').digest('base64url'),
        ),
        typeof redis.zScore === 'function'
            ? redis.zScore(competition.leaderboardKey, playerId)
            : Promise.resolve(undefined),
    ]);
    // Presence, not truthiness: hGet answers undefined for a field that is not there, so an
    // empty stored value is a row that exists and still has to go.
    const isStored = (value: unknown): boolean => value !== undefined && value !== null;
    const isRanked = isStored(score) && Number.isFinite(Number(score));
    return isStored(rawEntry) || isStored(rawPb) || isRanked;
}

export async function readEntryByPlayerId(
    competition: Competition,
    playerId: string,
): Promise<DailyGpLeaderboardEntry | null> {
    const rawEntry = await redis.hGet(competition.entryHashKey, playerId);
    return parseStoredEntry(rawEntry, competition.trackKey);
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

    const [rawEntries, profileMap] = await Promise.all([
        redis.hMGet(
            competition.entryHashKey,
            rankedMembers.map((member) => member.member),
        ),
        readPlayerProfileMap(rankedMembers.map((member) => member.member)),
    ]);
    const storedEntries = rankedMembers.map((member, index) => ({
        member,
        entry: parseStoredEntry(rawEntries[index], competition.trackKey),
    }));
    const unmarkedOpponentIds = storedEntries
        .filter(({ member, entry }) => (
            entry
            && member.member !== currentPlayerId
            && typeof entry.opponentRaceReady !== 'boolean'
        ))
        .map(({ member }) => member.member);
    const pbRecords = unmarkedOpponentIds.length
        ? await getPlayerTrackPbRecords({
            playerIds: unmarkedOpponentIds,
            competition,
            track: TRACKS[competition.trackKey],
        })
        : new Map();

    const rows = storedEntries.map(({ member, entry }, index) => {
        if (!entry) return null;
        const opponentRaceAvailable = member.member === currentPlayerId
            ? false
            : typeof entry.opponentRaceReady === 'boolean'
                ? entry.opponentRaceReady
                : isCompleteOpponentRecord(
                    entry,
                    pbRecords.get(member.member) ?? null,
                    competition,
                );
        return toSnapshotRow(
            entry,
            start + index + 1,
            currentPlayerId,
            profileMap,
            opponentRaceAvailable,
        );
    });
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

export async function markStoredEntryOpponentRaceReady(
    competition: Competition,
    playerId: string,
    entry: DailyGpLeaderboardEntry,
): Promise<DailyGpLeaderboardEntry> {
    if (entry.opponentRaceReady === true) return entry;
    const nextEntry = { ...entry, opponentRaceReady: true };
    // Entries hash is uncompressed Redis. Do not mix redisCompressed onto this key.
    await redis.hSet(competition.entryHashKey, {
        [playerId]: JSON.stringify(nextEntry),
    });
    await redis.incrBy(competition.standingsRevisionKey, 1);
    return nextEntry;
}

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
    // Deliberately in the ranked write's transaction: no snapshot can use a pre-write cache generation once this succeeds.
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

function rowsFromSharedPage(
    page: SharedStandingsPage,
    playerId: string | null,
    currentPlayerRow: SnapshotRow | null,
): SnapshotRow[] {
    const rows = page.rows.map(({ row }) => ({ ...row, isCurrentPlayer: false }));
    if (!playerId || !currentPlayerRow) return rows;
    const index = page.rows.findIndex((entry) => entry.playerId === playerId);
    if (index >= 0) {
        rows[index] = { ...currentPlayerRow };
    }
    return rows;
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
    loadedProfile,
}: {
    competition: Competition;
    playerId: string | null;
    limit: number;
    offset: number;
    /** Set when this request already loaded the viewer's profile. Omit it to read the name here. */
    loadedProfile?: LoadedPlayerProfile;
}): Promise<SnapshotPayload> {
    const sharedPage = await readSharedStandingsPage(competition, offset, limit);
    const { leaderboardEntryCount } = sharedPage;
    const totalCount = leaderboardEntryCount;

    if (leaderboardEntryCount === 0) {
        return createEmptySnapshot(competition, limit);
    }

    const playerRank = leaderboardEntryCount
        ? await readPlayerRank(competition, playerId)
        : null;

    let currentPlayerRow: SnapshotRow | null = null;
    if (playerId && playerRank) {
        const storedEntry = await readEntryByPlayerId(competition, playerId);
        if (storedEntry) {
            const profileMap = loadedProfile
                ? new Map(loadedProfile.profile ? [[playerId, loadedProfile.profile]] : [])
                : await readPlayerProfileMap([playerId]);
            currentPlayerRow = toSnapshotRow(storedEntry, playerRank, playerId, profileMap);
            currentPlayerRow.isCurrentPlayer = true;
        }
    }
    const topRows = rowsFromSharedPage(sharedPage, playerId, currentPlayerRow);

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
        const nearbyLimit = (DAILY_GP_NEARBY_RADIUS * 2) + 1;
        const nearbyPage = await readSharedStandingsPage(competition, nearbyStart, nearbyLimit);
        nearbyRows = rowsFromSharedPage(nearbyPage, playerId, currentPlayerRow);
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
