import { redis } from '@devvit/redis';
import { CAMPAIGN_LIVE_STAGES, getCampaignStage } from '../../../game/campaign/manifest.js';
import { toCampaignCompetition } from '../competition/competition.js';
import { challengeCollectionKey } from '../competition/pb-ghost-store.js';
import {
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
} from '../daily/daily-gp-model.js';
import { acquireRedisLock, releaseRedisLock } from '../redis/redis-lock.js';
import {
    DAILY_GUEST_EXPIRY_KEY,
    DAILY_GUEST_ROW_KEEP_SECONDS,
    GUEST_RACED_LIST_TTL_SECONDS,
    racedListKey,
} from './raced-list.js';

// A one-time walk that adds every row stored before the raced lists existed.
// It goes through every live Campaign stage and every stored Daily day, and
// through the entries, the rankings and the personal bests of each. Rows
// written since the lists exist are already listed, so a row the walk sees
// twice costs nothing. Each run does a bounded amount of work, saves where it
// stopped, and the next run goes on from there. The last run writes the ready
// record; only then may a transfer trust the lists.
//
// Every install has its own storage, so every install runs its own fill.
export const RACED_LIST_FILL_READY_KEY = 'miniracer:raced:v1:fill-ready';
const RACED_LIST_FILL_STATE_KEY = 'miniracer:raced:v1:fill-state';
const RACED_LIST_FILL_LOCK_KEY = 'miniracer:raced:v1:fill-lock';
const RACED_LIST_FILL_LOCK_TTL_MS = 55_000;
const RACED_LIST_FILL_ROWS_PER_RUN = 1_000;
const RACED_LIST_FILL_PAGE_SIZE = 200;
const RACED_LIST_FILL_WRITE_CONCURRENCY = 25;
// While a deploy rolls out, a request still running on the old version can
// write a row without listing it. The walk waits this long after its first
// run, so every such row exists before the walk reaches its board.
const RACED_LIST_FILL_START_DELAY_MS = 10 * 60 * 1000;

const PARTS = ['entries', 'ranks', 'pbs'] as const;
type FillPart = (typeof PARTS)[number];

type FillState = {
    // The walk starts at this time, not before (see RACED_LIST_FILL_START_DELAY_MS).
    notBeforeMs?: number;
    boards: string[];
    boardIndex: number;
    part: FillPart;
    cursor: number;
};

type BoardKeys = { entryHashKey: string; leaderboardKey: string; pbHashKey: string };

export function dailyBoardKeys(challengeId: string): BoardKeys {
    return {
        entryHashKey: createRedisChallengeEntryHashKey(challengeId),
        leaderboardKey: createRedisChallengeLeaderboardKey(challengeId),
        pbHashKey: challengeCollectionKey(challengeId),
    };
}

function boardKeys(board: string): BoardKeys | null {
    const [mode, id] = [board.slice(0, board.indexOf(':')), board.slice(board.indexOf(':') + 1)];
    if (mode === 'daily') return dailyBoardKeys(id);
    const stage = mode === 'campaign' ? getCampaignStage(id) : null;
    if (!stage) return null;
    const competition = toCampaignCompetition(stage.seriesId, stage);
    return {
        entryHashKey: competition.entryHashKey,
        leaderboardKey: competition.leaderboardKey,
        pbHashKey: competition.pbHashKey,
    };
}

async function listBoards(): Promise<string[]> {
    const days = (await redis.hKeys(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY))
        .filter((id) => id.startsWith('daily-gp-'))
        .sort();
    return [
        ...CAMPAIGN_LIVE_STAGES.map((stage) => `campaign:${stage.raceId}`),
        ...days.map((id) => `daily:${id}`),
    ];
}

function parseFillState(raw: string | null | undefined): FillState | null {
    if (!raw) return null;
    try {
        const state = JSON.parse(raw);
        const valid = (state?.notBeforeMs === undefined || Number.isFinite(state.notBeforeMs))
            && Array.isArray(state?.boards)
            && state.boards.every((board: unknown) => typeof board === 'string')
            && Number.isInteger(state.boardIndex)
            && PARTS.includes(state.part)
            && Number.isInteger(state.cursor);
        return valid ? state : null;
    } catch (_error) {
        return null;
    }
}

// Adds one board to one owner's list. `owner` is a player ID, or the coded name
// when the row is a personal best. A guest's list keeps its guest expiry, and
// a guest's Daily row enters the guest clean-up a year from now.
async function addOwner(board: string, owner: string, coded: boolean, nowMs: number): Promise<void> {
    const key = coded ? `miniracer:raced:v1:${owner}` : racedListKey(owner);
    await redis.hSet(key, { [board]: '1' });
    if (coded || !owner.startsWith('guest:')) return;
    await redis.expire(key, GUEST_RACED_LIST_TTL_SECONDS);
    if (board.startsWith('daily:')) {
        await redis.zAdd(DAILY_GUEST_EXPIRY_KEY, {
            member: owner,
            score: nowMs + DAILY_GUEST_ROW_KEEP_SECONDS * 1000,
        });
    }
}

async function readPage(keys: BoardKeys, part: FillPart, cursor: number): Promise<{ owners: string[]; cursor: number }> {
    if (part === 'ranks') {
        const page = await redis.zScan(keys.leaderboardKey, cursor, undefined, RACED_LIST_FILL_PAGE_SIZE);
        return { owners: page.members.map((member) => member.member), cursor: page.cursor };
    }
    const page = await redis.hScan(
        part === 'entries' ? keys.entryHashKey : keys.pbHashKey,
        cursor,
        undefined,
        RACED_LIST_FILL_PAGE_SIZE,
    );
    return { owners: page.fieldValues.map((row) => row.field), cursor: page.cursor };
}

export async function runRacedListFill(
    nowMs = Date.now(),
    rowsPerRun = RACED_LIST_FILL_ROWS_PER_RUN,
): Promise<{ status: 'ready' | 'busy' | 'working'; rows: number }> {
    if (await redis.get(RACED_LIST_FILL_READY_KEY)) return { status: 'ready', rows: 0 };
    const lock = await acquireRedisLock(RACED_LIST_FILL_LOCK_KEY, RACED_LIST_FILL_LOCK_TTL_MS, redis);
    if (!lock) return { status: 'busy', rows: 0 };
    try {
        const stored = parseFillState(await redis.get(RACED_LIST_FILL_STATE_KEY));
        if (!stored) {
            await redis.set(RACED_LIST_FILL_STATE_KEY, JSON.stringify({
                notBeforeMs: nowMs + RACED_LIST_FILL_START_DELAY_MS,
                boards: [],
                boardIndex: 0,
                part: 'entries',
                cursor: 0,
            } satisfies FillState));
            return { status: 'working', rows: 0 };
        }
        if (stored.notBeforeMs !== undefined && nowMs < stored.notBeforeMs) {
            return { status: 'working', rows: 0 };
        }
        // The boards are listed once, when the walk starts.
        const state: FillState = stored.notBeforeMs !== undefined
            ? { boards: await listBoards(), boardIndex: 0, part: 'entries', cursor: 0 }
            : stored;
        let rows = 0;
        while (state.boardIndex < state.boards.length && rows < rowsPerRun) {
            const board = state.boards[state.boardIndex];
            const keys = boardKeys(board);
            const page = keys ? await readPage(keys, state.part, state.cursor) : { owners: [], cursor: 0 };
            for (let index = 0; index < page.owners.length; index += RACED_LIST_FILL_WRITE_CONCURRENCY) {
                await Promise.all(page.owners
                    .slice(index, index + RACED_LIST_FILL_WRITE_CONCURRENCY)
                    .map((owner) => addOwner(board, owner, state.part === 'pbs', nowMs)));
            }
            rows += page.owners.length;
            if (page.cursor !== 0) {
                state.cursor = page.cursor;
            } else if (keys && state.part !== 'pbs') {
                state.part = PARTS[PARTS.indexOf(state.part) + 1];
                state.cursor = 0;
            } else {
                state.boardIndex += 1;
                state.part = 'entries';
                state.cursor = 0;
            }
            await redis.set(RACED_LIST_FILL_STATE_KEY, JSON.stringify(state));
        }
        if (state.boardIndex < state.boards.length) return { status: 'working', rows };
        await redis.set(RACED_LIST_FILL_READY_KEY, JSON.stringify({
            completedAt: new Date(nowMs).toISOString(),
            boards: state.boards.length,
        }));
        await redis.del(RACED_LIST_FILL_STATE_KEY);
        return { status: 'ready', rows };
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Raced list fill lock cleanup failed:', error);
        });
    }
}

export async function isRacedListFillReady(): Promise<boolean> {
    return Boolean(await redis.get(RACED_LIST_FILL_READY_KEY));
}

export type TransferBoards = {
    // Live Campaign stages, in stage order.
    campaignRaceIds: string[];
    // Daily days, oldest first.
    dailyChallengeIds: string[];
};

// The boards any of the players holds a row on, from their raced lists. It
// returns null until the fill is ready: then the lists may miss old rows.
export async function readTransferBoards(playerIds: readonly string[]): Promise<TransferBoards | null> {
    if (!await isRacedListFillReady()) return null;
    const lists = await Promise.all(playerIds.map((playerId) => redis.hKeys(racedListKey(playerId))));
    const fields = new Set(lists.flat());
    return {
        campaignRaceIds: CAMPAIGN_LIVE_STAGES
            .filter((stage) => fields.has(`campaign:${stage.raceId}`))
            .map((stage) => stage.raceId),
        dailyChallengeIds: [...fields]
            .filter((field) => field.startsWith('daily:'))
            .map((field) => field.slice('daily:'.length))
            .sort(),
    };
}
