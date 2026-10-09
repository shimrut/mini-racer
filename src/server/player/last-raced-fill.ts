import { redis } from '@devvit/redis';
import { analyticsRetentionWindow, analyticsScope, dayPlayersKey } from '../moderator/analytics-store.js';
import { playerFieldHash } from '../redis/redis-names.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    commitOwnedRedisLockTransaction,
    releaseRedisLock,
} from '../redis/redis-lock.js';
import { readContextSubredditName } from '../request/request-context.js';
import { LAST_RACED_KEY_PREFIX, lastRacedBucketKey } from './last-raced.js';

// One-time fill of the last race days from the analytics day lists, which hold every racer of each day.

export const LAST_RACED_FILL_READY_KEY = `${LAST_RACED_KEY_PREFIX}:fill-ready`;
const FILL_STATE_KEY = `${LAST_RACED_KEY_PREFIX}:fill-state`;
const FILL_LOCK_KEY = `${LAST_RACED_KEY_PREFIX}:fill-lock`;
const FILL_LOCK_TTL_MS = 55_000;
// Wait out a deploy rollout, so no old server still writes a day list without this record.
const FILL_START_DELAY_MS = 10 * 60 * 1000;
const FILL_PAGE_SIZE = 200;
const FILL_WRITE_GROUP = 25;
// Time kept after the last step for the progress save.
export const FILL_CHECKPOINT_RESERVE_MS = 2_000;

type FillState = {
    // The walk starts at this time, not before (see FILL_START_DELAY_MS).
    notBeforeMs?: number;
    date?: string;
    cursor?: number;
    players?: number;
};

function parseFillState(raw: string | null | undefined): FillState | null {
    if (!raw) return null;
    try {
        const state = JSON.parse(raw);
        return state && typeof state === 'object' ? state as FillState : null;
    } catch (_error) {
        return null;
    }
}

function readScope(subredditName?: string | null): string {
    let name = subredditName ?? null;
    if (name === null) {
        try {
            name = readContextSubredditName();
        } catch (_error) {
            name = null;
        }
    }
    return analyticsScope(name);
}

export type LastRacedFillResult = { status: 'ready' | 'busy' | 'working'; players: number };

// One-time fill from the analytics day lists, newest day first; `hSetNX` never covers a live day.
// It stops before the deadline and keeps its place; a cut page is read again (the writes repeat harmlessly).
export async function runLastRacedFill({
    deadlineMs = Number.POSITIVE_INFINITY,
    nowMs = Date.now(),
    clockMs = Date.now,
    subredditName,
}: {
    deadlineMs?: number;
    nowMs?: number;
    clockMs?: () => number;
    subredditName?: string | null;
} = {}): Promise<LastRacedFillResult> {
    if (await redis.get(LAST_RACED_FILL_READY_KEY)) return { status: 'ready', players: 0 };
    const hasTime = () => clockMs() + FILL_CHECKPOINT_RESERVE_MS <= deadlineMs;
    if (!hasTime()) return { status: 'working', players: 0 };
    const lock = await acquireRedisLock(FILL_LOCK_KEY, FILL_LOCK_TTL_MS, redis);
    if (!lock) return { status: 'busy', players: 0 };
    try {
        const stored = parseFillState(await redis.get(FILL_STATE_KEY));
        if (!stored) {
            await redis.set(FILL_STATE_KEY, JSON.stringify({ notBeforeMs: nowMs + FILL_START_DELAY_MS }));
            return { status: 'working', players: 0 };
        }
        if (stored.notBeforeMs !== undefined && nowMs < stored.notBeforeMs) return { status: 'working', players: 0 };
        const dates = analyticsRetentionWindow(new Date(nowMs)).dates;
        const state: Required<Omit<FillState, 'notBeforeMs'>> = {
            date: stored.date ?? dates[dates.length - 1],
            cursor: stored.cursor ?? 0,
            players: stored.players ?? 0,
        };
        const scope = readScope(subredditName);
        let written = 0;
        // A day that left the analytics window while the walk paused ends the walk.
        let index = dates.indexOf(state.date);
        if (index < 0) {
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) return { status: 'busy', players: 0 };
            await transaction.set(LAST_RACED_FILL_READY_KEY, JSON.stringify({
                completedAt: new Date(clockMs()).toISOString(),
                players: state.players,
            }));
            await transaction.del(FILL_STATE_KEY);
            if (!await commitOwnedRedisLockTransaction(transaction)) return { status: 'busy', players: 0 };
        }
        while (index >= 0) {
            if (!hasTime()) return { status: 'working', players: written };
            const page = await redis.hScan(dayPlayersKey(scope, state.date), state.cursor, undefined, FILL_PAGE_SIZE);
            const playerIds = page.fieldValues.map(({ field }) => field);
            for (let start = 0; start < playerIds.length; start += FILL_WRITE_GROUP) {
                if (!hasTime()) return { status: 'working', players: written };
                await Promise.all(playerIds.slice(start, start + FILL_WRITE_GROUP).map((playerId) => {
                    const field = playerFieldHash(playerId);
                    return redis.hSetNX(lastRacedBucketKey(field), field, state.date);
                }));
            }
            written += playerIds.length;
            state.players += playerIds.length;
            if (page.cursor !== 0) {
                state.cursor = page.cursor;
            } else {
                index -= 1;
                state.cursor = 0;
                if (index >= 0) state.date = dates[index];
            }
            const transaction = await beginOwnedRedisLockTransaction(lock, redis);
            if (!transaction) return { status: 'busy', players: written };
            if (index >= 0) {
                await transaction.set(FILL_STATE_KEY, JSON.stringify(state));
            } else {
                await transaction.set(LAST_RACED_FILL_READY_KEY, JSON.stringify({
                    completedAt: new Date(clockMs()).toISOString(),
                    players: state.players,
                }));
                await transaction.del(FILL_STATE_KEY);
            }
            if (!await commitOwnedRedisLockTransaction(transaction)) return { status: 'busy', players: written };
        }
        console.log('Last race day fill ready:', JSON.stringify({ players: state.players }));
        return { status: 'ready', players: written };
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Last race day fill lock cleanup failed:', error);
        });
    }
}

export type LastRacedFillStatus = { state: 'done' } | { state: 'working'; date: string | null } | { state: 'waiting' };

export async function readLastRacedFillStatus(): Promise<LastRacedFillStatus> {
    const [ready, rawState] = await redis.mGet([LAST_RACED_FILL_READY_KEY, FILL_STATE_KEY]);
    if (ready) return { state: 'done' };
    const state = parseFillState(rawState);
    return state?.date ? { state: 'working', date: state.date } : { state: 'waiting' };
}
