import type { Competition } from '../competition/competition.js';
import { writeEntry } from '../competition/competition-leaderboard.js';
import type { PlayerTrackPbRecord } from '../competition/pb-ghost-store.js';
import type { DailyGpLeaderboardEntry } from '../daily/daily-gp-model.js';
import { queueRacedBoard } from '../player/raced-list.js';
import type { RedisLockMutation } from '../redis/redis-lock.js';
import { playerFieldHash } from '../redis/redis-names.js';

// One board in a guest transfer: a Campaign stage or a Daily day. Campaign
// and Daily use the same rule, so that the faster time wins the same way.

export type BoardShape = {
    trackKey: string;
    lapCount: number;
};

// A time counts on a board only if it fits the board: the same player, the
// same track, and the board's lap count. A time saved before the lap count was
// stored (Daily and Campaign rows from July 2026) has no lap count, and still
// counts: the server checked it on the day it was driven.
export function timeFitsBoard(
    entry: DailyGpLeaderboardEntry | null,
    board: BoardShape,
    playerId: string,
): entry is DailyGpLeaderboardEntry {
    return Boolean(
        entry
        && entry.playerId === playerId
        && entry.trackKey === board.trackKey
        && Number.isFinite(entry.bestTimeMs)
        && entry.bestTimeMs > 0
        && (entry.completedLaps === null
            || entry.completedLaps === undefined
            || entry.completedLaps === board.lapCount),
    );
}

export type BoardMergeDecision = {
    // The guest's time takes the account's place on the board.
    guestEntryWins: boolean;
    // The entry to write for the account, or null to leave it.
    entryToWrite: DailyGpLeaderboardEntry | null;
    // The guest's personal best is faster, so it replaces the account's.
    guestPbWins: boolean;
};

// The faster fitting time wins; a tie keeps the account's time. The account's
// own entry is written again when its ranking lost step with it, also on a
// board the guest never raced.
export function decideBoardMerge({
    board,
    guestPlayerId,
    redditPlayerId,
    guestEntry,
    guestPb,
    redditEntry,
    redditPb,
    redditRankedScore,
}: {
    board: BoardShape;
    guestPlayerId: string;
    redditPlayerId: string;
    guestEntry: DailyGpLeaderboardEntry | null;
    guestPb: PlayerTrackPbRecord | null;
    redditEntry: DailyGpLeaderboardEntry | null;
    redditPb: PlayerTrackPbRecord | null;
    redditRankedScore: number | null | undefined;
}): BoardMergeDecision {
    const guestFits = timeFitsBoard(guestEntry, board, guestPlayerId);
    const accountFits = timeFitsBoard(redditEntry, board, redditPlayerId);
    const guestEntryWins = guestFits
        && (!accountFits || guestEntry.bestTimeMs < redditEntry.bestTimeMs);
    let entryToWrite: DailyGpLeaderboardEntry | null = null;
    if (guestEntryWins) {
        entryToWrite = { ...guestEntry, playerId: redditPlayerId };
    } else if (accountFits && Number(redditRankedScore) !== redditEntry.bestTimeMs) {
        entryToWrite = redditEntry;
    }
    const guestPbWins = Boolean(
        guestPb && (!redditPb || guestPb.bestTimeMs < redditPb.bestTimeMs),
    );
    return { guestEntryWins, entryToWrite, guestPbWins };
}

// The writes of one board, or null when the board needs none. It queues at
// most 5 commands: an account entry is never a guest's, so writeEntry queues
// 4 (with the raced list), and the personal best queues 1. A personal best
// copied without an entry queues 3.
//
// Every write that changes a board's rows raises its standings revision.
// writeEntry does it for an entry; a personal best copied alone does it here.
// The move of old Daily ghosts reads the revision to know that a day changed.
export function boardMergeWrite(
    competition: Competition,
    redditPlayerId: string,
    entryToWrite: DailyGpLeaderboardEntry | null,
    guestPbValue: string | undefined,
): RedisLockMutation | null {
    if (!entryToWrite && !guestPbValue) return null;
    return async (transaction) => {
        if (entryToWrite) {
            await writeEntry(competition, redditPlayerId, entryToWrite, transaction);
        }
        if (guestPbValue) {
            await transaction.hSet(competition.pbHashKey, {
                [playerFieldHash(redditPlayerId)]: guestPbValue,
            });
            if (!entryToWrite) {
                await queueRacedBoard(transaction, redditPlayerId, competition);
                await transaction.incrBy(competition.standingsRevisionKey, 1);
            }
        }
    };
}
