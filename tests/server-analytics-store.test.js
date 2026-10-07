import { beforeEach, describe, expect, it, vi } from 'vitest';

const hashes = new Map();
const strings = new Map();
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
    hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field)),
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
    hScan: vi.fn(async (key, cursor, _pattern, count = 10) => {
        const entries = [...(hashes.get(key) ?? new Map())];
        const next = cursor + count;
        return {
            cursor: next >= entries.length ? 0 : next,
            fieldValues: entries.slice(cursor, next).map(([field, value]) => ({ field, value })),
        };
    }),
    hDel: vi.fn(async (key, fields) => {
        const hash = hashes.get(key);
        if (!hash) return 0;
        let removed = 0;
        for (const field of fields) {
            if (hash.delete(field)) removed += 1;
        }
        return removed;
    }),
    set: vi.fn(async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, String(value));
        return 'OK';
    }),
    del: vi.fn(async (...keys) => {
        for (const key of keys) strings.delete(key);
    }),
    expire: vi.fn(async () => true),
    exists: vi.fn(async (...keys) => keys.filter((key) => hashes.has(key) || strings.has(key)).length),
};

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('../src/server/request/request-context.ts', () => ({
    readContextSubredditName: () => 'mini_racer',
}));

const profiles = new Map();
vi.mock('../src/server/competition/competition-identity.ts', () => ({
    readPlayerProfile: async (playerId) => profiles.get(playerId) ?? null,
}));

const SUBREDDIT = 'mini_racer';
const day = (iso) => new Date(iso);

async function store() {
    return import('../src/server/moderator/analytics-store.ts');
}

function dayFor(summary, date) {
    return summary.days.find((entry) => entry.date === date);
}

function modeFor(bucket, mode) {
    return bucket.modes.find((entry) => entry.mode === mode);
}

describe('server analytics store', () => {
    beforeEach(async () => {
        hashes.clear();
        strings.clear();
        profiles.clear();
        vi.clearAllMocks();
        const { clearAnalyticsMaintenanceMemory } = await store();
        clearAnalyticsMaintenanceMemory();
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
        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:beta',
            subredditName: SUBREDDIT,
            now: day('2026-08-03T09:00:00.000Z'),
        });
        for (const playerId of ['reddit:alpha', 'reddit:beta']) {
            await recordAnalyticsRace({
                mode: 'campaign',
                action: 'start',
                playerId,
                subredditName: SUBREDDIT,
                now: day('2026-08-04T09:00:00.000Z'),
            });
        }
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
            playerId: 'reddit:beta',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });
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
            d2: { retained: 1, rate: 50 },
            d3: { retained: 2, rate: 100 },
            d7: { retained: 2, rate: 100 },
            d14: { retained: 1, rate: 50 },
            d30: { retained: 1, rate: 50 },
        });
    });

    it('counts first races and returns in the summary hash when players race', async () => {
        const { recordAnalyticsRace, summaryKey } = await store();
        const race = (playerId, iso) => recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId,
            subredditName: SUBREDDIT,
            now: day(iso),
        });

        await race('reddit:alpha', '2026-08-01T09:00:00.000Z');
        await race('reddit:alpha', '2026-08-01T10:00:00.000Z');
        await race('reddit:beta', '2026-08-01T11:00:00.000Z');
        await race('guest:visitor', '2026-08-01T12:00:00.000Z');
        await race('reddit:alpha', '2026-08-02T09:00:00.000Z');
        await race('reddit:alpha', '2026-08-02T10:00:00.000Z');
        await race('reddit:alpha', '2026-08-05T09:00:00.000Z');
        await race('reddit:beta', '2026-08-08T09:00:00.000Z');
        await race('guest:visitor', '2026-08-08T09:00:00.000Z');

        const summary = Object.fromEntries(hashes.get(summaryKey(SUBREDDIT)));
        const cohortFields = Object.fromEntries(
            Object.entries(summary).filter(([field]) => field.includes(':cohort')),
        );
        expect(cohortFields).toEqual({
            'd:2026-08-01:cohort': '2',
            'd:2026-08-01:cohort:d1': '1',
            'd:2026-08-01:cohort:d7': '1',
        });
    });

    it('trims cohort counts with the other expired day counts', async () => {
        const { recordAnalyticsPodiumEvent, summaryKey } = await store();
        await mockRedis.hSet(summaryKey(SUBREDDIT), {
            'd:2025-08-15:cohort': '4',
            'd:2025-08-15:cohort:d30': '1',
            'd:2026-08-01:cohort': '2',
        });

        await recordAnalyticsPodiumEvent({
            action: 'play',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });

        const fields = [...hashes.get(summaryKey(SUBREDDIT)).keys()];
        expect(fields).toContain('d:2026-08-01:cohort');
        expect(fields).not.toContain('d:2025-08-15:cohort');
        expect(fields).not.toContain('d:2025-08-15:cohort:d30');
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
            d2: { retained: null, rate: null },
            d3: { retained: null, rate: null },
            d7: { retained: null, rate: null },
            d14: { retained: null, rate: null },
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

    it('refreshes expiry once per day on this server, and only for keys that event wrote', async () => {
        const {
            recordAnalyticsPodiumEvent,
            recordAnalyticsRace,
            summaryKey,
            dayPlayersKey,
            dayModePlayersKey,
            monthPlayersKey,
            monthModePlayersKey,
            firstSeenKey,
            cohortStartsKey,
        } = await store();
        const now = day('2026-08-15T09:00:00.000Z');
        const scope = SUBREDDIT;

        await recordAnalyticsPodiumEvent({ action: 'play', subredditName: scope, now });

        expect(mockRedis.expire.mock.calls.map((call) => call[0])).toEqual([summaryKey(scope)]);
        expect(mockRedis.hDel).toHaveBeenCalledTimes(1);

        mockRedis.expire.mockClear();
        mockRedis.hDel.mockClear();
        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:racefan',
            subredditName: scope,
            now,
        });

        expect(mockRedis.expire.mock.calls.map((call) => call[0]).sort()).toEqual([
            cohortStartsKey(scope),
            dayModePlayersKey(scope, '2026-08-15'),
            dayPlayersKey(scope, '2026-08-15'),
            firstSeenKey(scope),
            monthModePlayersKey(scope, '2026-08'),
            monthPlayersKey(scope, '2026-08'),
        ].sort());
        expect(mockRedis.hDel).not.toHaveBeenCalled();

        mockRedis.expire.mockClear();
        await recordAnalyticsRace({
            mode: 'daily',
            action: 'finish',
            playerId: 'reddit:racefan',
            subredditName: scope,
            now,
        });
        expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('keeps older per-day counters when the summary hash takes over', async () => {
        const {
            dayCountersKey,
            getServerAnalyticsSummary,
            recordAnalyticsRace,
        } = await store();

        await mockRedis.hSet(dayCountersKey(SUBREDDIT, '2026-08-15'), { 'daily:start': '3' });
        const first = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });
        expect(modeFor(first.today, 'daily').starts).toBe(3);

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:racefan',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T09:00:00.000Z'),
        });
        const second = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });

        expect(modeFor(second.today, 'daily').starts).toBe(4);
        expect(second.today.players).toBe(1);
    });

    it('reads only the summary hash once the cohort counts are filled', async () => {
        const { recordAnalyticsRace, getServerAnalyticsSummary, summaryKey } = await store();
        const now = day('2026-08-15T12:00:00.000Z');

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:racefan',
            subredditName: SUBREDDIT,
            now,
        });
        await getServerAnalyticsSummary({ subredditName: SUBREDDIT, now });
        mockRedis.hGetAll.mockClear();
        mockRedis.hScan.mockClear();
        mockRedis.hMGet.mockClear();
        mockRedis.hSetNX.mockClear();

        const summary = await getServerAnalyticsSummary({ subredditName: SUBREDDIT, now });

        expect(summary.today.players).toBe(1);
        expect(summary.cohorts.map((cohort) => cohort.date)).toEqual(['2026-08-15']);
        expect(mockRedis.hGetAll.mock.calls.map((call) => call[0])).toEqual([summaryKey(SUBREDDIT)]);
        expect(mockRedis.hScan).not.toHaveBeenCalled();
        expect(mockRedis.hMGet.mock.calls.map((call) => call[0])).toEqual([summaryKey(SUBREDDIT)]);
        expect(mockRedis.hSetNX).not.toHaveBeenCalled();
    });

    it('counts cohorts once from the day lists that older code saved', async () => {
        const {
            cohortStartsKey,
            dayPlayersKey,
            getServerAnalyticsSummary,
            summaryKey,
        } = await store();
        await mockRedis.hSet(summaryKey(SUBREDDIT), { ready: '1' });
        await mockRedis.hSet(cohortStartsKey(SUBREDDIT), {
            'reddit:alpha': '2026-08-01',
            'reddit:beta': '2026-08-01',
            'reddit:gamma': '2026-08-03',
        });
        const dayList = (date, entries) => mockRedis.hSet(dayPlayersKey(SUBREDDIT, date), entries);
        await dayList('2026-08-01', { 'reddit:alpha': 'n', 'reddit:beta': 'n', 'guest:visitor': 'g' });
        await dayList('2026-08-02', { 'reddit:alpha': 'r' });
        await dayList('2026-08-03', { 'reddit:gamma': 'n', 'reddit:beta': 'r' });
        await dayList('2026-08-08', { 'reddit:alpha': 'r', 'reddit:beta': 'r', 'reddit:gamma': 'r' });
        const scan = mockRedis.hScan.getMockImplementation();
        mockRedis.hScan.mockImplementation(async (key, ...rest) => {
            const page = await scan(key, ...rest);
            return key === dayPlayersKey(SUBREDDIT, '2026-08-01')
                ? { ...page, fieldValues: [...page.fieldValues, ...page.fieldValues] }
                : page;
        });

        try {
            const summary = await getServerAnalyticsSummary({
                subredditName: SUBREDDIT,
                now: day('2026-08-10T12:00:00.000Z'),
            });

            expect(summary.cohorts).toEqual([
                {
                    date: '2026-08-01',
                    players: 2,
                    d1: { retained: 1, rate: 50 },
                    d2: { retained: 1, rate: 50 },
                    d3: { retained: 0, rate: 0 },
                    d7: { retained: 2, rate: 100 },
                    d14: { retained: null, rate: null },
                    d30: { retained: null, rate: null },
                },
                {
                    date: '2026-08-03',
                    players: 1,
                    d1: { retained: 0, rate: 0 },
                    d2: { retained: 0, rate: 0 },
                    d3: { retained: 0, rate: 0 },
                    d7: { retained: 0, rate: 0 },
                    d14: { retained: null, rate: null },
                    d30: { retained: null, rate: null },
                },
            ]);
            const wholeReads = mockRedis.hGetAll.mock.calls.map((call) => call[0]);
            expect(wholeReads).not.toContain(cohortStartsKey(SUBREDDIT));
            expect(wholeReads.some((key) => key.endsWith(':players'))).toBe(false);
        } finally {
            mockRedis.hScan.mockImplementation(scan);
        }
    });

    it('counts the first day of the new counting again from its day list the next day', async () => {
        const {
            cohortStartsKey,
            dayPlayersKey,
            getServerAnalyticsSummary,
            recordAnalyticsRace,
            summaryKey,
        } = await store();
        await mockRedis.hSet(summaryKey(SUBREDDIT), { ready: '1' });
        await mockRedis.hSet(cohortStartsKey(SUBREDDIT), {
            'reddit:alpha': '2026-08-14',
            'reddit:early': '2026-08-15',
        });
        await mockRedis.hSet(dayPlayersKey(SUBREDDIT, '2026-08-14'), { 'reddit:alpha': 'n' });
        await mockRedis.hSet(dayPlayersKey(SUBREDDIT, '2026-08-15'), {
            'reddit:alpha': 'r',
            'reddit:early': 'n',
        });

        await recordAnalyticsRace({
            mode: 'daily',
            action: 'start',
            playerId: 'reddit:late',
            subredditName: SUBREDDIT,
            now: day('2026-08-15T18:00:00.000Z'),
        });
        const sameDay = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-15T23:00:00.000Z'),
        });
        const nextDay = await getServerAnalyticsSummary({
            subredditName: SUBREDDIT,
            now: day('2026-08-16T09:00:00.000Z'),
        });

        expect(sameDay.cohorts.map(({ date, players }) => ({ date, players }))).toEqual([
            { date: '2026-08-14', players: 1 },
            { date: '2026-08-15', players: 1 },
        ]);
        expect(nextDay.cohorts.map(({ date, players, d1 }) => ({ date, players, d1 }))).toEqual([
            { date: '2026-08-14', players: 1, d1: { retained: 1, rate: 100 } },
            { date: '2026-08-15', players: 2, d1: { retained: 0, rate: 0 } },
        ]);
    });

    it('hides days the fill has not counted and continues the fill on the next load', async () => {
        const {
            cohortStartsKey,
            dayPlayersKey,
            getServerAnalyticsSummary,
            summaryKey,
        } = await store();
        const now = day('2026-08-10T12:00:00.000Z');
        await mockRedis.hSet(summaryKey(SUBREDDIT), { ready: '1' });
        await mockRedis.hSet(cohortStartsKey(SUBREDDIT), { 'reddit:alpha': '2026-08-01' });
        await mockRedis.hSet(dayPlayersKey(SUBREDDIT, '2026-08-01'), { 'reddit:alpha': 'n' });
        await mockRedis.hSet(dayPlayersKey(SUBREDDIT, '2026-08-02'), { 'reddit:alpha': 'r' });
        const scan = mockRedis.hScan.getMockImplementation();
        mockRedis.hScan.mockImplementation(async (key, ...rest) => {
            if (key === dayPlayersKey(SUBREDDIT, '2026-08-02')) throw new Error('redis busy');
            return scan(key, ...rest);
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const first = await getServerAnalyticsSummary({ subredditName: SUBREDDIT, now });
            expect(first.cohorts.find((cohort) => cohort.date === '2026-08-01')?.d1.retained ?? null)
                .toBeNull();
            expect(errors.mock.calls.some(([message]) => String(message).includes('cohort fill'))).toBe(true);
        } finally {
            mockRedis.hScan.mockImplementation(scan);
        }

        const second = await getServerAnalyticsSummary({ subredditName: SUBREDDIT, now });
        expect(second.cohorts).toEqual([{
            date: '2026-08-01',
            players: 1,
            d1: { retained: 1, rate: 100 },
            d2: { retained: 0, rate: 0 },
            d3: { retained: 0, rate: 0 },
            d7: { retained: 0, rate: 0 },
            d14: { retained: null, rate: null },
            d30: { retained: null, rate: null },
        }]);
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
