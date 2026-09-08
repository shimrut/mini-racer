import { beforeEach, describe, expect, it, vi } from 'vitest';

const hashes = new Map();
const mockRedis = {
    hSetNX: vi.fn(async (key, field, value) => {
        const hash = hashes.get(key) ?? new Map();
        if (hash.has(field)) return 0;
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
    }),
    hIncrBy: vi.fn(async (key, field, amount) => {
        const hash = hashes.get(key) ?? new Map();
        const next = Number(hash.get(field) || 0) + amount;
        hash.set(field, String(next));
        hashes.set(key, hash);
        return next;
    }),
    hSet: vi.fn(async (key, entries) => {
        const hash = hashes.get(key) ?? new Map();
        for (const [field, value] of Object.entries(entries)) hash.set(field, value);
        hashes.set(key, hash);
        return Object.keys(entries).length;
    }),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? [])),
    expire: vi.fn(async () => true),
};

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('../src/server/request-context.ts', () => ({
    readContextSubredditName: () => 'mini_racer',
}));

const profiles = new Map();
vi.mock('../src/server/competition-identity.ts', () => ({
    readPlayerProfile: async (playerId) => profiles.get(playerId) ?? null,
}));

const SUBREDDIT = 'mini_racer';
const day = (iso) => new Date(iso);

async function store() {
    return import('../src/server/analytics-store.ts');
}

function dayFor(summary, date) {
    return summary.days.find((entry) => entry.date === date);
}

function modeFor(bucket, mode) {
    return bucket.modes.find((entry) => entry.mode === mode);
}

describe('server analytics store', () => {
    beforeEach(() => {
        hashes.clear();
        profiles.clear();
        vi.clearAllMocks();
    });

    it('counts a signed-in player once per day however many races they start', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();

        for (let attempt = 0; attempt < 4; attempt += 1) {
            await recordAnalyticsRace({
                mode: 'daily',
                action: 'start',
                playerId: 'reddit:racefan',
                subredditName: SUBREDDIT,
                now: day('2026-08-15T09:00:00.000Z'),
            });
        }

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today).toMatchObject({ players: 1, newPlayers: 1, returningPlayers: 0 });
        expect(modeFor(summary.today, 'daily')).toMatchObject({ players: 1, starts: 4, finishes: 0 });
    });

    it('classifies a player as returning on any day after their first, from its own ledger', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:racefan',
            subredditName: SUBREDDIT,
            now: day('2026-08-14T09:00:00.000Z'),
        });
        await recordAnalyticsRace({
            mode: 'campaign',
            action: 'start',
            playerId: 'reddit:racefan',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(dayFor(summary, '2026-08-14')).toMatchObject({ newPlayers: 1, returningPlayers: 0 });
        expect(dayFor(summary, '2026-08-15')).toMatchObject({ newPlayers: 0, returningPlayers: 1 });
    });

    it('builds exact-day cohorts from first observed race activity across modes', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:alpha',
            subredditName: SUBREDDIT,
            now: day('2026-08-01T09:00:00.000Z'),
        });
        await recordAnalyticsRace({
            mode: 'campaign',
            action: 'start',
            playerId: 'reddit:beta',
            subredditName: SUBREDDIT,
            now: day('2026-08-01T10:00:00.000Z'),
        });
        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:alpha',
            subredditName: SUBREDDIT,
            now: day('2026-08-02T09:00:00.000Z'),
        });
        for (const playerId of ['reddit:alpha', 'reddit:beta']) {
            await recordAnalyticsRace({
                mode: 'challenge',
                action: 'start',
                playerId,
                subredditName: SUBREDDIT,
                now: day('2026-08-08T09:00:00.000Z'),
            });
        }
        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:alpha',
            subredditName: SUBREDDIT,
            now: day('2026-08-31T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-31T23:00:00.000Z'),
        });
        const cohort = summary.cohorts.find((entry) => entry.date === '2026-08-01');

        expect(cohort).toEqual({
            date: '2026-08-01',
            players: 2,
            d1: { retained: 1, rate: 50 },
            d7: { retained: 2, rate: 100 },
            d30: { retained: 1, rate: 50 },
        });
    });

    it('does not use a profile historical firstSeenAt as the cohort date', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();
        profiles.set('reddit:veteran', { firstSeenAt: '2026-06-02T10:00:00.000Z' });

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:veteran',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.cohorts).toEqual([{
            date: '2026-08-15',
            players: 1,
            d1: { retained: null, rate: null },
            d7: { retained: null, rate: null },
            d30: { retained: null, rate: null },
        }]);
    });

    it('keeps signed-out visitors out of the player count and reports them separately', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'guest:abc',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });
        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:racefan',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today).toMatchObject({ players: 1, guestPlayers: 1 });
        expect(modeFor(summary.today, 'daily').players).toBe(1);
    });

    it('ignores a raw storage id that is not a canonical identity', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: '0f8c-not-canonical',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today).toMatchObject({ players: 0, guestPlayers: 0 });
        expect(modeFor(summary.today, 'daily').starts).toBe(0);
    });

    it('reports the same start and finish events for every mode', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();
        const now = day('2026-08-15T09:00:00.000Z');

        for (const mode of ['daily', 'campaign', 'challenge']) {
            await recordAnalyticsRace({ mode, action: 'start', playerId: 'reddit:a', subredditName: SUBREDDIT, now });
            await recordAnalyticsRace({ mode, action: 'start', playerId: 'reddit:b', subredditName: SUBREDDIT, now });
            await recordAnalyticsRace({ mode, action: 'finish', playerId: 'reddit:a', subredditName: SUBREDDIT, now });
        }

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        for (const mode of ['daily', 'campaign', 'challenge']) {
            expect(modeFor(summary.today, mode)).toMatchObject({ players: 2, starts: 2, finishes: 1 });
        }
        expect(summary.today.players).toBe(2);
    });

    it('dedupes a player across the days of a month', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();

        for (const date of ['2026-08-10', '2026-08-11', '2026-08-15']) {
            await recordAnalyticsRace({
                mode: 'daily',
                action: 'start',
                playerId: 'reddit:racefan',
                subredditName: SUBREDDIT,
                now: day(`${date}T09:00:00.000Z`),
            });
        }

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });
        const august = summary.months.find((month) => month.month === '2026-08');

        expect(august).toMatchObject({ players: 1, newPlayers: 1, returningPlayers: 0 });
        expect(modeFor(august, 'daily').players).toBe(1);
    });

    it('keeps one subreddit out of another subreddit summary', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();
        const now = day('2026-08-15T09:00:00.000Z');

        await recordAnalyticsRace({ mode: 'daily', action: 'start', playerId: 'reddit:a', subredditName: 'mini_racer', now });
        await recordAnalyticsRace({ mode: 'daily', action: 'start', playerId: 'reddit:b', subredditName: 'other_sub', now });

        const summary = await getServerAnalyticsSummary({
            subredditName: 'mini_racer',
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today.players).toBe(1);
    });

    it('records a challenge creation without counting it as a race', async () => {
        const { recordAnalyticsChallengeCreate, getServerAnalyticsSummary } = await store();

        await recordAnalyticsChallengeCreate({
            playerId: 'reddit:racefan',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today.challengeCreates).toBe(1);
        expect(summary.today.players).toBe(0);
    });

    it('records podium Play Now and View Replays without counting a player', async () => {
        const { recordAnalyticsPodiumEvent, getServerAnalyticsSummary } = await store();

        await recordAnalyticsPodiumEvent({
            action: 'play',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });
        await recordAnalyticsPodiumEvent({
            action: 'play',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T10:00:00.000Z'),
        });
        await recordAnalyticsPodiumEvent({
            action: 'replay',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T11:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today).toMatchObject({ podiumPlays: 2, podiumReplays: 1, players: 0 });
    });

    it('treats an account that raced before the ledger existed as returning', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();
        profiles.set('reddit:veteran', { firstSeenAt: '2026-06-02T10:00:00.000Z' });

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:veteran',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today).toMatchObject({ players: 1, newPlayers: 0, returningPlayers: 1 });
    });

    it('still counts a genuinely first-time account as new', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary } = await store();
        profiles.set('reddit:rookie', { firstSeenAt: '2026-08-15T08:00:00.000Z' });

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:rookie',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const summary = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(summary.today).toMatchObject({ players: 1, newPlayers: 1, returningPlayers: 0 });
    });

    it('swallows redis failures so gameplay callers stay unblocked', async () => {
        const { recordAnalyticsRace } = await store();
        mockRedis.hSetNX.mockRejectedValueOnce(new Error('redis down'));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:racefan',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        })).resolves.toBeUndefined();
    });
});
