import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import smallSteps from '../game/track/definitions/small-steps.js';
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
vi.mock('@devvit/web/server', () => ({ redis, context: { subredditId: 't5_placement' } }));

const tracks = await import('../src/server/tracks/track-store.ts');
const schedule = await import('../src/server/daily/daily-schedule-store.ts');
const series = await import('../src/server/campaign/series-store.ts');
const daily = await import('../src/server/daily/daily-gp-store.ts');
const { TRACK_SCHEDULE_KEYS } = await import('../game/track/catalog.js');
const { buildDailyGpChallengeForDayIndexWithTrack, getUtcDayIndex } = await import('../src/server/daily/daily-gp-model.ts');
const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };
const shape = { ...smallSteps, name: 'Placement Test' };
const trackKey = 'placementTest';
const recordKey = `dailygp:tracks:v1:track:${trackKey}`;
const placementLockKey = 'dailygp:tracks:v1:placement-write-lock:v1';
const planner = { name: 'Placement Series', ground: 'tarmac', stages: [{ trackKey, laps: 1, requiredMedals: 0 }] };

beforeEach(async () => {
    strings.clear(); hashes.clear(); vi.clearAllMocks();
    installTrackRedisTransactions(redis, strings, hashes);
    tracks.clearStoredTrackCacheForTests(); series.clearStoredSeriesCacheForTests();
    tracks.installStoredTrackResolver(); series.installStoredSeriesResolver();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-02-15T12:00:00.000Z'));
    await tracks.saveStoredTrack(trackKey, { track: shape, medalRow }, { username: 'Mod' });
    await tracks.ensureStoredTracksLoaded();
});
afterEach(() => vi.useRealTimers());

function rejectCommit(shouldReject) {
    const watch = redis.watch.getMockImplementation();
    redis.watch.mockImplementation(async (...keys) => {
        const transaction = await watch(...keys);
        const exec = transaction.exec.getMockImplementation();
        transaction.exec.mockImplementation(async () => shouldReject(transaction.commands) ? [] : exec());
        return transaction;
    });
}

function loseCommitReply(matches, commit = true) {
    const watch = redis.watch.getMockImplementation();
    redis.watch.mockImplementation(async (...keys) => {
        const transaction = await watch(...keys);
        const exec = transaction.exec.getMockImplementation();
        transaction.exec.mockImplementation(async () => {
            if (!matches(transaction.commands)) return exec();
            if (commit) await exec();
            throw new Error('EXEC reply unavailable');
        });
        return transaction;
    });
}

it.each([
    ['missing author', (record) => { record.medalRow.author = null; }],
    ['unordered times', (record) => { record.medalRow.gold = record.medalRow.silver; }],
    ['unfinished road', (record) => { record.draftLoop = [{ x: 1, y: 1 }]; }],
    ['geometry despite trusted flag', (record) => { record.track.outer = []; record.checksPassed = true; }],
])('refuses Daily and Campaign admission for %s', async (_name, damage) => {
    const record = JSON.parse(strings.get(recordKey)); damage(record);
    strings.set(recordKey, JSON.stringify(record));
    await expect(schedule.saveDailySchedule([trackKey], { username: 'Mod' })).rejects.toThrow();
    await expect(series.saveStoredSeries('placement-v1', planner, { username: 'Mod' })).rejects.toThrow();
    expect((await schedule.readDailySchedule()).source).toBe('app');
    expect(await series.readStoredSeries('placement-v1')).toBeNull();
});

it.each(['daily', 'campaign'])('keeps a %s assignment complete until explicitly removed', async (mode) => {
    if (mode === 'daily') await schedule.saveDailySchedule([trackKey], { username: 'Mod' });
    else await series.saveStoredSeries('placement-v1', planner, { username: 'Mod' });
    await expect(tracks.saveStoredTrack(trackKey, { track: shape, medalRow: null }, { username: 'Mod', baseRevision: 1 }))
        .rejects.toThrow('before saving unfinished work');
    expect((await tracks.readStoredTrack(trackKey)).medalRow).toEqual(medalRow);
    if (mode === 'daily') await schedule.saveDailySchedule(['circuit'], { username: 'Mod', baseRevision: 1 });
    else await series.deleteStoredSeries('placement-v1', { baseRevision: 1 });
    expect((await tracks.saveStoredTrack(trackKey, { track: shape }, { username: 'Mod', baseRevision: 1 })).medalRow).toBeNull();
});

it('does not acquire a per-track lock for every Daily list entry', async () => {
    redis.set.mockClear();
    await schedule.saveDailySchedule([...TRACK_SCHEDULE_KEYS].reverse(), { username: 'Mod' });
    expect(redis.set.mock.calls.filter(([key]) => key.includes(':write-lock:'))).toEqual([]);
});

it('refuses a new held-ground Daily entry and a listed track changing to a held ground', async () => {
    await tracks.saveStoredTrack(trackKey, { track: { ...shape, ground: 'snow' }, medalRow }, { username: 'Mod', baseRevision: 1 });
    await expect(schedule.saveDailySchedule([trackKey], { username: 'Mod' })).rejects.toThrow('not live');
    await tracks.saveStoredTrack(trackKey, { track: shape, medalRow }, { username: 'Mod', baseRevision: 2 });
    await schedule.saveDailySchedule([trackKey], { username: 'Mod' });
    await expect(tracks.saveStoredTrack(trackKey, { track: { ...shape, ground: 'snow' }, medalRow }, { username: 'Mod', baseRevision: 3 }))
        .rejects.toThrow('out of the Daily list');
});

it('serializes admission against an unfinished save, then checks the committed assignment', async () => {
    const get = redis.get.getMockImplementation();
    let finishRead;
    let reachedRead;
    const reached = new Promise((resolve) => { reachedRead = resolve; });
    redis.get.mockImplementation(async (key) => {
        if (key === recordKey && !finishRead) {
            reachedRead();
            await new Promise((resolve) => { finishRead = resolve; });
        }
        return get(key);
    });
    const admission = schedule.saveDailySchedule([trackKey], { username: 'Mod' });
    await reached;
    await expect(tracks.saveStoredTrack(trackKey, { track: shape }, { username: 'Mod', baseRevision: 1 }))
        .rejects.toThrow('Retry before racing');
    finishRead(); await admission;
    redis.get.mockImplementation(get);
    await expect(tracks.saveStoredTrack(trackKey, { track: shape }, { username: 'Mod', baseRevision: 1 }))
        .rejects.toThrow('before saving unfinished work');
});

it('aborts a stale save without releasing its successor placement lock', async () => {
    const get = redis.get.getMockImplementation();
    redis.get.mockImplementation(async (key) => {
        if (key === recordKey) strings.set(placementLockKey, 'successor');
        return get(key);
    });
    await expect(tracks.saveStoredTrack(trackKey, { track: { ...shape, name: 'Stale' }, medalRow }, { username: 'Mod', baseRevision: 1 }))
        .rejects.toThrow('Retry before racing');
    redis.get.mockImplementation(get);
    expect((await tracks.readStoredTrack(trackKey)).revision).toBe(1);
    expect(strings.get(placementLockKey)).toBe('successor');
});

it('commits Daily history and its track freeze together, and makes the first answer loadable', async () => {
    await schedule.saveDailySchedule([trackKey], { username: 'Mod' });
    rejectCommit((commands) => commands.some(([method]) => method === 'hSetNX'));
    await expect(daily.getServerDailyGpChallenge()).rejects.toThrow('Retry before racing');
    expect(hashes.get('dailygp:challenges')).toBeUndefined();
    expect((await tracks.readStoredTrack(trackKey)).lockedAt).toBeNull();
    installTrackRedisTransactions(redis, strings, hashes);
    const challenge = await daily.getServerDailyGpPlayableChallenge('daily-gp-2030-02-15');
    expect(challenge.trackKey).toBe(trackKey);
    expect(JSON.parse(hashes.get('dailygp:challenges').get(challenge.id)).trackKey).toBe(trackKey);
    expect(tracks.describePlacedStoredTracks([trackKey])).toHaveLength(1);
    await expect(tracks.saveStoredTrack(trackKey, { track: shape, medalRow }, { username: 'Mod', baseRevision: 2 })).rejects.toThrow('locked');
});

it('returns the committed winner to a Daily request that loses the midnight race', async () => {
    await schedule.saveDailySchedule([trackKey], { username: 'Mod' });
    const winner = buildDailyGpChallengeForDayIndexWithTrack(getUtcDayIndex(new Date()), 'circuit');
    strings.set(placementLockKey, 'winner');
    setTimeout(() => {
        hashes.set('dailygp:challenges', new Map([[winner.id, JSON.stringify(winner)]]));
        strings.delete(placementLockKey);
    }, 50);
    expect(await daily.getServerDailyGpChallenge()).toMatchObject({ id: winner.id, trackKey: 'circuit' });
    expect((await tracks.readStoredTrack(trackKey)).lockedAt).toBeNull();
});

it('selects the lap contract from the fresh medal row that it freezes', async () => {
    let date = new Date('2030-02-15T12:00:00.000Z');
    while (buildDailyGpChallengeForDayIndexWithTrack(getUtcDayIndex(date), trackKey).objectiveParams.lapCount !== 2) {
        date = new Date(date.getTime() + 86_400_000);
    }
    vi.setSystemTime(date);
    await schedule.saveDailySchedule([trackKey], { username: 'Mod' });
    await tracks.saveStoredTrack(trackKey, { track: shape, medalRow: { author: 12, gold: 13, silver: 14, bronze: 15 } }, { username: 'Mod', baseRevision: 1 });
    // The request overlay still has the previous author time.
    expect((await daily.getServerDailyGpChallenge()).objectiveParams.lapCount).toBe(1);
});

it('commits Campaign publication and every new stage freeze together', async () => {
    await series.saveStoredSeries('placement-v1', planner, { username: 'Mod' });
    rejectCommit((commands) => commands.some(([method, args]) => method === 'set' && args[0].includes(':series:') && JSON.parse(args[1]).status === 'published'));
    await expect(series.publishStoredSeries('placement-v1', { username: 'Mod', baseRevision: 1 })).rejects.toThrow('Retry before racing');
    expect((await series.readStoredSeries('placement-v1')).status).toBe('draft');
    expect((await tracks.readStoredTrack(trackKey)).lockedAt).toBeNull();
    installTrackRedisTransactions(redis, strings, hashes);
    await series.publishStoredSeries('placement-v1', { username: 'Mod', baseRevision: 1 });
    expect((await series.readStoredSeries('placement-v1')).publishedStageCount).toBe(1);
    expect((await tracks.readStoredTrack(trackKey)).lockReason).toBe('series');
});

it('confirms a track save whose committed EXEC reply is lost', async () => {
    loseCommitReply((commands) => commands.some(([method, args]) => method === 'set' && args[0] === recordKey));
    const saved = await tracks.saveStoredTrack(trackKey, { track: { ...shape, name: 'Confirmed Save' }, medalRow }, { username: 'Mod', baseRevision: 1 });
    expect(saved.revision).toBe(2);
    expect((await tracks.readStoredTrack(trackKey)).track.name).toBe('Confirmed Save');
});

it('confirms a Daily list save whose committed EXEC reply is lost', async () => {
    loseCommitReply((commands) => commands.some(([method, args]) => method === 'set' && args[0] === 'dailygp:daily:schedule:v1'));
    expect((await schedule.saveDailySchedule([trackKey], { username: 'Mod' })).revision).toBe(1);
    expect((await schedule.readDailySchedule()).keys).toEqual([trackKey]);
});

it('confirms Daily history and the exact frozen record after a lost EXEC reply', async () => {
    await schedule.saveDailySchedule([trackKey], { username: 'Mod' });
    loseCommitReply((commands) => commands.some(([method]) => method === 'hSetNX'));
    const challenge = await daily.getServerDailyGpChallenge();
    expect(challenge.trackKey).toBe(trackKey);
    expect((await tracks.readStoredTrack(trackKey)).lockedAt).toBeTruthy();
    expect(tracks.describePlacedStoredTracks([trackKey])).toHaveLength(1);
});

it('confirms published Campaign stages after a lost EXEC reply', async () => {
    await series.saveStoredSeries('placement-v1', planner, { username: 'Mod' });
    loseCommitReply((commands) => commands.some(([method, args]) => method === 'set' && args[0].includes(':series:') && JSON.parse(args[1]).status === 'published'));
    const published = await series.publishStoredSeries('placement-v1', { username: 'Mod', baseRevision: 1 });
    expect(published.status).toBe('published');
    expect(published.publishedStageCount).toBe(1);
    expect((await tracks.readStoredTrack(trackKey)).lockReason).toBe('series');
});

it('keeps an unconfirmed Campaign publication retryable when EXEC never committed', async () => {
    await series.saveStoredSeries('placement-v1', planner, { username: 'Mod' });
    loseCommitReply((commands) => commands.some(([method, args]) => method === 'set' && args[0].includes(':series:') && JSON.parse(args[1]).status === 'published'), false);
    await expect(series.publishStoredSeries('placement-v1', { username: 'Mod', baseRevision: 1 })).rejects.toThrow('could not be confirmed');
    expect((await series.readStoredSeries('placement-v1')).status).toBe('draft');
    expect((await tracks.readStoredTrack(trackKey)).lockedAt).toBeNull();
});
