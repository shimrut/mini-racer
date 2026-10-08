import type { Competition } from '../competition/competition.js';
import { writeEntry } from '../competition/competition-leaderboard.js';
import type { PlayerTrackPbRecord } from '../competition/pb-ghost-store.js';
import type { DailyGpLeaderboardEntry } from '../daily/daily-gp-model.js';
import { queueRacedBoard } from '../player/raced-list.js';
import type { RedisLockMutation } from '../redis/redis-lock.js';
import { playerFieldHash } from '../redis/redis-names.js';

// One transfer board (Campaign stage or Daily day); both use the same faster-time rule.

export type BoardShape = {
    trackKey: string;
    lapCount: number;
};

// A time counts only for the same player, track and lap count; July 2026 rows without a lap count still count.
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

// The faster fitting time wins, a tie keeps the account's; an out-of-step account ranking is rewritten too.
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

// One board's writes, or null; at most 5 commands (entry 4 with the raced list, PB 1; a PB alone 3).
// Every row change raises the standings revision, which the Daily ghost move reads.
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
