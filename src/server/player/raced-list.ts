import { playerFieldHash } from '../redis/redis-names.js';

// Each player's list of the boards they hold a row on: one field for each
// Campaign stage or Daily day, such as `campaign:numbered-v1-00` or
// `daily:daily-gp-2026-09-26`. Every write that creates a row adds its board,
// so a transfer can work on the raced boards only. The list only grows: a
// board it names may hold no row any more.
//
// The key uses the same coded name as the personal bests, so the one-time fill
// can match a personal-best row to its owner.
export function racedListKey(playerId: string): string {
    return `miniracer:raced:v1:${playerFieldHash(playerId)}`;
}

export function racedListField(board: { mode: string; id: string }): string {
    return `${board.mode}:${board.id}`;
}

// A guest's list outlives a year without play, so the guest clean-up can still
// read it. Each write sets the time again.
export const GUEST_RACED_LIST_TTL_SECONDS = 400 * 24 * 60 * 60;

// Queues 1 command for an account, and 2 for a guest.
export async function queueRacedBoard(
    transaction: {
        hSet(key: string, values: Record<string, string>): Promise<unknown>;
        expire(key: string, seconds: number): Promise<unknown>;
    },
    playerId: string,
    board: { mode: string; id: string },
): Promise<void> {
    const key = racedListKey(playerId);
    await transaction.hSet(key, { [racedListField(board)]: '1' });
    if (playerId.startsWith('guest:')) {
        await transaction.expire(key, GUEST_RACED_LIST_TTL_SECONDS);
    }
}
