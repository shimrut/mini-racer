import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';

// Freezes the stored names and the commands of the raced-board lists. The
// names are written out in full, so a change to the name rules fails here
// even when the code and its other tests change together.

const redis = new RedisTestDouble();

vi.mock('@devvit/redis', () => ({
    redis,
    redisCompressed: redis,
}));

const {
    DAILY_GUEST_EXPIRY_KEY,
    DAILY_GUEST_ROW_KEEP_SECONDS,
    GUEST_RACED_LIST_TTL_SECONDS,
    listRacedBoard,
    queueRacedBoard,
    racedListField,
    racedListKey,
} = await import('../src/server/player/raced-list.ts');
const { RACED_LIST_FILL_READY_KEY, runRacedListFill } = await import('../src/server/player/raced-list-fill.ts');

const ACCOUNT = 'reddit:t2_racer';
const ACCOUNT_LIST = 'miniracer:raced:v1:mL-TGe5RLJniP_3SCYKBjxbFZBUqEQwQz_225GjQUwA';
const GUEST = 'guest:4f9c2d';
const GUEST_LIST = 'miniracer:raced:v1:HhvjHw1ZYKGxX6RgqINyzDkbs72kwEqMxjIu00U3REc';
const NOW_MS = Date.parse('2026-09-27T12:00:00.000Z');
const DAY_SECONDS = 24 * 60 * 60;

function recorder() {
    const calls = [];
    const record = (name) => async (...args) => {
        calls.push([name, ...args]);
    };
    return { calls, hSet: record('hSet'), expire: record('expire'), zAdd: record('zAdd') };
}

describe('raced-board list names', () => {
    beforeEach(() => {
        redis.reset();
    });

    it('keeps the list key and the board fields', () => {
        expect(racedListKey(ACCOUNT)).toBe(ACCOUNT_LIST);
        expect(racedListKey(GUEST)).toBe(GUEST_LIST);
        expect(racedListField({ mode: 'campaign', id: 'numbered-v1-00' })).toBe('campaign:numbered-v1-00');
        expect(racedListField({ mode: 'daily', id: 'daily-gp-2026-09-26' })).toBe('daily:daily-gp-2026-09-26');
    });

    it('keeps the guest clean-up key, the fill key and the two times', () => {
        expect(DAILY_GUEST_EXPIRY_KEY).toBe('dailygp:guest-expiry:v1');
        expect(RACED_LIST_FILL_READY_KEY).toBe('miniracer:raced:v1:fill-ready');
        expect(GUEST_RACED_LIST_TTL_SECONDS).toBe(400 * DAY_SECONDS);
        expect(DAILY_GUEST_ROW_KEEP_SECONDS).toBe(365 * DAY_SECONDS);
    });

    it('queues the same commands for each kind of race save', async () => {
        const account = recorder();
        await queueRacedBoard(account, ACCOUNT, { mode: 'daily', id: 'daily-gp-2026-09-26' }, NOW_MS);
        expect(account.calls).toEqual([
            ['hSet', ACCOUNT_LIST, { 'daily:daily-gp-2026-09-26': '1' }],
        ]);

        const guestStage = recorder();
        await queueRacedBoard(guestStage, GUEST, { mode: 'campaign', id: 'numbered-v1-00' }, NOW_MS);
        expect(guestStage.calls).toEqual([
            ['hSet', GUEST_LIST, { 'campaign:numbered-v1-00': '1' }],
            ['expire', GUEST_LIST, 400 * DAY_SECONDS],
        ]);

        const guestDay = recorder();
        await queueRacedBoard(guestDay, GUEST, { mode: 'daily', id: 'daily-gp-2026-09-26' }, NOW_MS);
        expect(guestDay.calls).toEqual([
            ['hSet', GUEST_LIST, { 'daily:daily-gp-2026-09-26': '1' }],
            ['expire', GUEST_LIST, 400 * DAY_SECONDS],
            ['zAdd', 'dailygp:guest-expiry:v1', { member: GUEST, score: NOW_MS + 365 * DAY_SECONDS * 1000 }],
        ]);
    });

    it('lists a board before a race save checks the transfer marks', async () => {
        const account = recorder();
        await listRacedBoard(account, ACCOUNT, { mode: 'campaign', id: 'numbered-v1-00' });
        expect(account.calls).toEqual([
            ['hSet', ACCOUNT_LIST, { 'campaign:numbered-v1-00': '1' }],
        ]);

        const guest = recorder();
        await listRacedBoard(guest, GUEST, { mode: 'daily', id: 'daily-gp-2026-09-26' });
        expect(guest.calls).toEqual([
            ['hSet', GUEST_LIST, { 'daily:daily-gp-2026-09-26': '1' }],
            ['expire', GUEST_LIST, 400 * DAY_SECONDS],
        ]);
    });

    it('puts a personal-best-only row on the same list as a race save', async () => {
        const day = 'daily-gp-2026-01-01';
        await redis.hSet('dailygp:challenges', { [day]: '{}' });
        // A personal best names its owner only by the coded name.
        await redis.hSet(`dailygp:challenge-pbs:${day}`, {
            'HhvjHw1ZYKGxX6RgqINyzDkbs72kwEqMxjIu00U3REc': '{}',
        });

        await runRacedListFill(NOW_MS, 1000);
        for (let run = 0; run < 50; run += 1) {
            const result = await runRacedListFill(NOW_MS + 11 * 60 * 1000, 1000);
            if (result.status === 'ready') break;
        }

        expect(await redis.hGetAll(GUEST_LIST)).toEqual({ [`daily:${day}`]: '1' });
    });
});
