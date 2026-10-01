import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';

const strings = new Map();
const hashes = new Map();
const known = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (...keys) => { keys.flat().forEach((key) => strings.delete(key)); }),
    mGet: vi.fn(async (keys) => keys.map((key) => strings.get(key) ?? null)),
    hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? new Map())),
    hSet: vi.fn(async (key, fields) => {
        const hash = hashes.get(key) ?? new Map();
        Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
        hashes.set(key, hash);
        return 1;
    }),
    hSetNX: vi.fn(async (key, field, value) => {
        const hash = hashes.get(key) ?? new Map();
        if (hash.has(field)) return 0;
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
    }),
    hDel: vi.fn(async (key, fields) => { fields.forEach((field) => hashes.get(key)?.delete(field)); return 1; }),
    incrBy: vi.fn(async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next));
        return next;
    }),
    expire: vi.fn(async () => true),
    hScan: vi.fn(async () => ({ cursor: 0, fieldValues: [] })),
};
const redis = new Proxy(known, { get: (target, name) => target[name] ?? (async () => null) });
vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));
vi.mock('@devvit/web/server', () => ({ redis, context: { subredditId: 't5_copies' } }));

const tracks = await import('../src/server/tracks/track-store.ts');
const series = await import('../src/server/campaign/series-store.ts');
const { buildLockedTrackCopy } = await import('../src/server/tracks/track-copy.ts');
const { runPlayedDailyCopy, runLiveCampaignCopy } = await import('../src/server/tracks/track-migration.ts');
const { runCopyCheck, readCopyCheck } = await import('../src/server/tracks/copy-check.ts');
const seriesData = (await import('../game/campaign/series.json', { with: { type: 'json' } })).default;
const { DAILY_GP_CHALLENGE_HISTORY_HASH_KEY } = await import('../src/server/daily/daily-gp-model.ts');
const { BUILT_IN_TRACKS } = await import('../game/track/tracks.js');
const { TRACK_SCHEDULE_KEYS } = await import('../game/track/catalog.js');
const { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } = await import('../game/shared/daily-gp-history-backfill.js');

const noon = new Date('2030-03-10T12:00:00.000Z');
const copyLiveSeries = (options) => series.copyLiveAppSeries(options);
const numbers = seriesData.series.find((entry) => entry.id === 'numbered-v1');
const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };

function addDaily(date, trackKey) {
    const hash = hashes.get(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY) ?? new Map();
    const startsAt = new Date(`${date}T00:00:00.000Z`);
    hash.set(`daily-gp-${date}`, JSON.stringify({
        id: `daily-gp-${date}`, challengeDate: date, trackKey,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 86_400_000).toISOString(),
        availableUntil: new Date(startsAt.getTime() + 7 * 86_400_000).toISOString(),
    }));
    hashes.set(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, hash);
}

let logs;
let errors;
beforeEach(() => {
    strings.clear(); hashes.clear(); vi.clearAllMocks();
    installTrackRedisTransactions(redis, strings, hashes);
    tracks.clearStoredTrackCacheForTests();
    series.clearStoredSeriesCacheForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(noon);
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the copy check', () => {
    it('finds every copy exact after the copies, and logs one line', async () => {
        addDaily('2030-02-01', 'smallSteps');
        await runPlayedDailyCopy({ username: 'Mod', now: noon });
        await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.tracks.problems).toEqual([]);
        expect(check.series.problems).toEqual([]);
        expect(check.tracks.exact).toContain('smallSteps');
        expect(check.tracks.exact).toEqual(expect.arrayContaining(numbers.stages.map((stage) => stage.trackKey)));
        expect(check.tracks.locked).toBe(check.tracks.exact.length);
        expect(check.tracks.notCopied).toEqual([]);
        expect(check.series.exact).toContain('numbered-v1');
        expect(check.dailyList).toBe('app');
        expect(await readCopyCheck()).toEqual(check);
        expect(logs.mock.calls.map(([line]) => line)).toContainEqual(expect.stringMatching(/^\[track-copy\] check by u\/Mod: .* 0 problems\.$/));
        expect(errors).not.toHaveBeenCalled();
    });

    it('lists a copy changed in the Creator before anyone raced it, and raced tracks with no copy', async () => {
        addDaily('2030-02-01', 'smallSteps');
        const raced = new Set([...Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE),
            ...seriesData.series.flatMap((entry) => (entry.stages ?? []).map((stage) => stage.trackKey)), 'smallSteps']);
        const unraced = Object.keys(BUILT_IN_TRACKS).find((key) => !raced.has(key));
        await tracks.saveStoredTrack(unraced, {
            track: { ...BUILT_IN_TRACKS[unraced], name: 'Changed Copy' }, medalRow,
        }, { username: 'Mod', origin: 'migrated', trusted: true, now: noon });
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.tracks.changed).toEqual([unraced]);
        expect(check.tracks.problems).toEqual([]);
        expect(check.tracks.notCopied).toContain('smallSteps');
        expect(check.series.notCopied).toContain('numbered-v1');
    });

    it('reports a copy that differs from the app track that players raced', async () => {
        addDaily('2030-02-01', 'smallSteps');
        const copy = buildLockedTrackCopy('smallSteps', { username: 'Mod', reason: 'daily', now: noon });
        await tracks.saveLockedTrackCopy({ ...copy, track: { ...copy.track, cornerRadius: (copy.track.cornerRadius ?? 1) + 1 } });
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.tracks.problems).toEqual([{ key: 'smallSteps', problem: expect.stringContaining('differs') }]);
        expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[track-copy\] problem smallSteps: /));
    });

    it('reports a live series copy whose live stages changed', async () => {
        await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        const key = 'dailygp:campaign:series:v1:series:numbered-v1';
        const record = JSON.parse(strings.get(key));
        record.stages[0] = { ...record.stages[0], laps: record.stages[0].laps + 1 };
        strings.set(key, JSON.stringify(record));
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.series.problems.map((problem) => problem.key)).toEqual(['numbered-v1']);
    });

    it('compares a stored Daily list with the app list', async () => {
        const schedule = (keys) => strings.set('dailygp:daily:schedule:v1', JSON.stringify({
            version: 1, keys, revision: 1, updatedAt: noon.toISOString(), updatedBy: 'Mod' }));
        schedule([...TRACK_SCHEDULE_KEYS]);
        expect((await runCopyCheck({ username: 'Mod', now: noon })).dailyList).toBe('exact');
        schedule([...TRACK_SCHEDULE_KEYS].reverse());
        expect((await runCopyCheck({ username: 'Mod', now: noon })).dailyList).toBe('changed');
    });
});
