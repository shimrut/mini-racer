import { describe, expect, it } from 'vitest';
import { boardMergeWrite, decideBoardMerge, timeFitsBoard } from '../src/server/guest-transfer/board-merge.ts';

const BOARD = { trackKey: 'circuit', lapCount: 2 };
const GUEST = 'guest:board';
const ACCOUNT = 'reddit:board';

function time(playerId, bestTimeMs, extra = {}) {
    return {
        playerId,
        trackKey: 'circuit',
        bestTimeMs,
        updatedAt: '2026-09-27T12:00:00.000Z',
        completedLaps: 2,
        checkpointTimesSec: null,
        validationMethod: 'strict-replay',
        ...extra,
    };
}

function pb(bestTimeMs) {
    return { bestTimeMs };
}

function decide(input) {
    return decideBoardMerge({
        board: BOARD,
        guestPlayerId: GUEST,
        redditPlayerId: ACCOUNT,
        guestEntry: null,
        guestPb: null,
        redditEntry: null,
        redditPb: null,
        redditRankedScore: null,
        ...input,
    });
}

describe('one board in a guest transfer', () => {
    it('counts a time of the same player, track and lap count', () => {
        expect(timeFitsBoard(time(ACCOUNT, 30000), BOARD, ACCOUNT)).toBe(true);
        expect(timeFitsBoard(time(ACCOUNT, 30000), BOARD, GUEST)).toBe(false);
        expect(timeFitsBoard(time(ACCOUNT, 30000, { trackKey: 'kettleRun' }), BOARD, ACCOUNT)).toBe(false);
        expect(timeFitsBoard(time(ACCOUNT, 30000, { completedLaps: 1 }), BOARD, ACCOUNT)).toBe(false);
        expect(timeFitsBoard(time(ACCOUNT, 0), BOARD, ACCOUNT)).toBe(false);
        expect(timeFitsBoard(null, BOARD, ACCOUNT)).toBe(false);
    });

    it('counts an old time saved without a lap count or a check label', () => {
        const old = time(ACCOUNT, 30000, { completedLaps: null, validationMethod: undefined });
        expect(timeFitsBoard(old, BOARD, ACCOUNT)).toBe(true);
    });

    it('keeps the faster time, and the account time on a tie', () => {
        expect(decide({
            guestEntry: time(GUEST, 29000),
            redditEntry: time(ACCOUNT, 30000),
            redditRankedScore: 30000,
        })).toMatchObject({ guestEntryWins: true, entryToWrite: { playerId: ACCOUNT, bestTimeMs: 29000 } });

        expect(decide({
            guestEntry: time(GUEST, 31000),
            redditEntry: time(ACCOUNT, 30000),
            redditRankedScore: 30000,
        })).toEqual({ guestEntryWins: false, entryToWrite: null, guestPbWins: false });

        expect(decide({
            guestEntry: time(GUEST, 30000),
            redditEntry: time(ACCOUNT, 30000),
            redditRankedScore: 30000,
        })).toEqual({ guestEntryWins: false, entryToWrite: null, guestPbWins: false });
    });

    it('keeps an old account time that is faster than the guest time', () => {
        const old = time(ACCOUNT, 30000, { completedLaps: null, validationMethod: undefined });
        expect(decide({
            guestEntry: time(GUEST, 33000),
            redditEntry: old,
            redditRankedScore: 30000,
        })).toEqual({ guestEntryWins: false, entryToWrite: null, guestPbWins: false });
    });

    it('lets the guest time win over an account time that does not fit the board', () => {
        expect(decide({
            guestEntry: time(GUEST, 33000),
            redditEntry: time(ACCOUNT, 30000, { completedLaps: 1 }),
            redditRankedScore: 30000,
        })).toMatchObject({ guestEntryWins: true, entryToWrite: { playerId: ACCOUNT, bestTimeMs: 33000 } });
    });

    it('writes the account time again when its ranking lost step, also where the guest never raced', () => {
        const account = time(ACCOUNT, 30000);
        expect(decide({ redditEntry: account, redditRankedScore: 35000 }))
            .toEqual({ guestEntryWins: false, entryToWrite: account, guestPbWins: false });
        expect(decide({ redditEntry: time(ACCOUNT, 30000, { completedLaps: 1 }), redditRankedScore: 35000 }))
            .toEqual({ guestEntryWins: false, entryToWrite: null, guestPbWins: false });
    });

    it('moves only a strictly faster personal best', () => {
        expect(decide({ guestPb: pb(29000), redditPb: pb(30000) }).guestPbWins).toBe(true);
        expect(decide({ guestPb: pb(30000), redditPb: pb(30000) }).guestPbWins).toBe(false);
        expect(decide({ guestPb: pb(29000) }).guestPbWins).toBe(true);
        expect(decide({ redditPb: pb(29000) }).guestPbWins).toBe(false);
    });
});

describe('the writes of one board', () => {
    const COMPETITION = {
        mode: 'daily',
        id: 'daily-gp-2026-09-27',
        trackKey: 'circuit',
        entryHashKey: 'board:entries',
        leaderboardKey: 'board:ranks',
        standingsRevisionKey: 'board:revision',
        pbHashKey: 'board:pbs',
    };

    async function queued(mutate) {
        const commands = [];
        const transaction = new Proxy({}, {
            get: (_target, name) => async (key) => {
                commands.push([name, key]);
            },
        });
        await mutate(transaction);
        return commands;
    }

    // The Daily ghost move reads the revision, so a PB copied alone must raise it too.
    it('raises the standings revision when it copies a personal best without an entry', async () => {
        const commands = await queued(boardMergeWrite(COMPETITION, ACCOUNT, null, 'pb'));
        expect(commands).toHaveLength(3);
        expect(commands).toContainEqual(['hSet', 'board:pbs']);
        expect(commands).toContainEqual(['incrBy', 'board:revision']);
    });

    it('raises the revision once and queues at most 5 commands with an entry', async () => {
        const commands = await queued(boardMergeWrite(COMPETITION, ACCOUNT, time(ACCOUNT, 30000), 'pb'));
        expect(commands.length).toBeLessThanOrEqual(5);
        expect(commands.filter(([name]) => name === 'incrBy')).toEqual([['incrBy', 'board:revision']]);
    });
});
