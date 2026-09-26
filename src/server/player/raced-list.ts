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

// A guest's list outlives the year after its last write, so the guest
// clean-up can still read it. Each write sets the time again.
export const GUEST_RACED_LIST_TTL_SECONDS = 400 * 24 * 60 * 60;

// Daily boards stay for the archive, so a guest's Daily rows need their own
// clean-up. Each Daily row a guest writes sets the time when that clean-up may
// remove them: one year after the guest's last Daily write.
export const DAILY_GUEST_EXPIRY_KEY = 'dailygp:guest-expiry:v1';
export const DAILY_GUEST_ROW_KEEP_SECONDS = 365 * 24 * 60 * 60;

// Queues 1 command for an account, 2 for a guest on a Campaign stage, and 3
// for a guest on a Daily day.
export async function queueRacedBoard(
    transaction: {
        hSet(key: string, values: Record<string, string>): Promise<unknown>;
        expire(key: string, seconds: number): Promise<unknown>;
        zAdd(key: string, member: { member: string; score: number }): Promise<unknown>;
    },
    playerId: string,
    board: { mode: string; id: string },
    nowMs = Date.now(),
): Promise<void> {
    const key = racedListKey(playerId);
    await transaction.hSet(key, { [racedListField(board)]: '1' });
    if (!playerId.startsWith('guest:')) return;
    await transaction.expire(key, GUEST_RACED_LIST_TTL_SECONDS);
    if (board.mode === 'daily') {
        await transaction.zAdd(DAILY_GUEST_EXPIRY_KEY, {
            member: playerId,
            score: nowMs + DAILY_GUEST_ROW_KEEP_SECONDS * 1000,
        });
    }
}
