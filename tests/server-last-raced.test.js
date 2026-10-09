import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';

const redis = new RedisTestDouble();

vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));

const { bumpLastRaced, lastRacedBucketKey, readLastRacedDays } = await import('../src/server/player/last-raced.ts');
const {
    LAST_RACED_FILL_READY_KEY,
    readLastRacedFillStatus,
    runLastRacedFill,
} = await import('../src/server/player/last-raced-fill.ts');
const { analyticsScope, dayPlayersKey, recordAnalyticsRace } = await import('../src/server/moderator/analytics-store.ts');
const { playerFieldHash } = await import('../src/server/redis/redis-names.ts');
const { runRacedListFill } = await import('../src/server/player/raced-list-fill.ts');

const SUBREDDIT = 'MiniRacerGame';
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const MINUTE = 60 * 1000;

async function dayOf(playerId) {
    return (await readLastRacedDays([playerFieldHash(playerId)])).get(playerFieldHash(playerId));
}

async function seedDayList(date, playerIds) {
    await redis.hSet(dayPlayersKey(analyticsScope(SUBREDDIT), date), Object.fromEntries(playerIds.map((id) => [id, 'r'])));
}

async function runFillToEnd(nowMs) {
    for (let tick = 0; tick < 5; tick += 1) {
        const result = await runLastRacedFill({ nowMs, subredditName: SUBREDDIT });
        if (result.status === 'ready') return result;
    }
    throw new Error('The fill did not finish.');
}

beforeEach(() => {
    redis.reset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('last race day', () => {
    it('raises the day and never lowers it', async () => {
        expect(await bumpLastRaced('reddit:ann', '2026-10-05')).toBe(true);
        expect(await bumpLastRaced('reddit:ann', '2026-10-03')).toBe(false);
        expect(await bumpLastRaced('reddit:ann', '2026-10-05')).toBe(false);
        expect(await dayOf('reddit:ann')).toBe('2026-10-05');
        expect(await bumpLastRaced('reddit:ann', '2026-10-09')).toBe(true);
        expect(await dayOf('reddit:ann')).toBe('2026-10-09');
    });

    it('keeps a newer day written between its read and its commit', async () => {
        const field = playerFieldHash('reddit:ann');
        const key = lastRacedBucketKey(field);
        redis.setBeforeExec(() => {
            redis.hashes.set(key, new Map([[field, '2026-10-09']]));
            redis.touch(key);
            redis.setBeforeExec(null);
        });
        expect(await bumpLastRaced('reddit:ann', '2026-10-08')).toBe(false);
        expect(await dayOf('reddit:ann')).toBe('2026-10-09');
    });

    it('records the full player id, which ghost rows use, not the 120-character analytics id', async () => {
        // The test double has no hIncrBy, so the analytics counters fail; the day is written on its own.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const longId = `reddit:${'x'.repeat(130)}`;
        await recordAnalyticsRace({
            mode: 'campaign',
            action: 'start',
            playerId: longId,
            subredditName: SUBREDDIT,
            now: new Date(NOW),
        });
        expect(await dayOf(longId)).toBe('2026-10-09');
        expect(await dayOf(longId.slice(0, 120))).toBeNull();
    });
});

describe('last race day fill', () => {
    it('waits out the rollout, then gives each player the newest day and keeps live days', async () => {
        await seedDayList('2026-10-09', ['reddit:ann']);
        await seedDayList('2026-10-08', ['reddit:bob']);
        await seedDayList('2026-10-06', ['reddit:ann', 'reddit:cid', 'reddit:dee']);
        await bumpLastRaced('reddit:dee', '2026-10-09');

        expect(await readLastRacedFillStatus()).toEqual({ state: 'waiting' });
        await expect(runLastRacedFill({ nowMs: NOW, subredditName: SUBREDDIT })).resolves.toMatchObject({ status: 'working' });
        await expect(runLastRacedFill({ nowMs: NOW + 5 * MINUTE, subredditName: SUBREDDIT }))
            .resolves.toMatchObject({ status: 'working', players: 0 });
        expect(await dayOf('reddit:ann')).toBeNull();

        await runFillToEnd(NOW + 11 * MINUTE);
        expect(await dayOf('reddit:ann')).toBe('2026-10-09');
        expect(await dayOf('reddit:bob')).toBe('2026-10-08');
        expect(await dayOf('reddit:cid')).toBe('2026-10-06');
        expect(await dayOf('reddit:dee')).toBe('2026-10-09');
        expect(await redis.get(LAST_RACED_FILL_READY_KEY)).toBeTruthy();
        expect(await readLastRacedFillStatus()).toEqual({ state: 'done' });
        await expect(runLastRacedFill({ nowMs: NOW + 12 * MINUTE })).resolves.toEqual({ status: 'ready', players: 0 });
    });

    it('stops before the shared deadline and continues from its saved place', async () => {
        const players = Array.from({ length: 450 }, (_, index) => `reddit:p${index}`);
        await seedDayList('2026-10-09', players);
        await runLastRacedFill({ nowMs: NOW, subredditName: SUBREDDIT });

        let clock = NOW + 11 * MINUTE;
        let pages = 0;
        const scan = redis.hScan.bind(redis);
        vi.spyOn(redis, 'hScan').mockImplementation(async (...args) => {
            pages += 1;
            // The second page uses up the request's time; the first one is saved.
            if (pages === 2) clock += 10_000;
            return scan(...args);
        });
        const cut = await runLastRacedFill({
            nowMs: NOW + 11 * MINUTE,
            clockMs: () => clock,
            deadlineMs: NOW + 11 * MINUTE + 5_000,
            subredditName: SUBREDDIT,
        });
        expect(cut.status).toBe('working');
        expect(await readLastRacedFillStatus()).toEqual({ state: 'working', date: '2026-10-09' });

        await runFillToEnd(NOW + 12 * MINUTE);
        const days = await readLastRacedDays(players.map(playerFieldHash));
        expect([...days.values()].every((day) => day === '2026-10-09')).toBe(true);
    });

    it('does nothing in a raced-list run that has no time left', async () => {
        await expect(runRacedListFill(NOW, undefined, Date.now() - 1)).resolves.toEqual({ status: 'working', rows: 0 });
        expect(redis.strings.size).toBe(0);
    });
});
