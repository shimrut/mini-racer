import { playerFieldHash } from '../redis/redis-names.js';

// Each player's boards with a row (`campaign:<stage>`, `daily:<day>`), so a transfer works only on those.
// It only grows, and uses the PB coded name so the one-time fill can match PB rows to owners.
export function racedListKey(playerId: string): string {
    return `miniracer:raced:v1:${playerFieldHash(playerId)}`;
}

export function racedListField(board: { mode: string; id: string }): string {
    return `${board.mode}:${board.id}`;
}

// A guest's list outlives its year, so the guest clean-up can still read it; each write renews it.
export const GUEST_RACED_LIST_TTL_SECONDS = 400 * 24 * 60 * 60;

// Each guest Daily write sets the clean-up time: a year after the last Daily write.
export const DAILY_GUEST_EXPIRY_KEY = 'dailygp:guest-expiry:v1';
export const DAILY_GUEST_ROW_KEEP_SECONDS = 365 * 24 * 60 * 60;

// Queues 1 command for an account, 2 for a guest stage, 3 for a guest Daily day.
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

// Saves list their board before checking the marks, so one transfer check finds every running save.
export async function listRacedBoard(
    client: {
        hSet(key: string, values: Record<string, string>): Promise<unknown>;
        expire(key: string, seconds: number): Promise<unknown>;
    },
    playerId: string,
    board: { mode: string; id: string },
): Promise<void> {
    const key = racedListKey(playerId);
    await client.hSet(key, { [racedListField(board)]: '1' });
    if (playerId.startsWith('guest:')) await client.expire(key, GUEST_RACED_LIST_TTL_SECONDS);
}
