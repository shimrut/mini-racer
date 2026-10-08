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
const { runCopyUndo, readCopyUndoReport } = await import('../src/server/tracks/copy-undo.ts');
const { runTrackMigration } = await import('../src/server/tracks/track-migration.ts');
const { readDailySchedule } = await import('../src/server/daily/daily-schedule-store.ts');
const { getTrackDefinitionIdentity } = await import('../game/track/definition-identity.js');
const { ensureStoredCatalogLoaded, loadStoredTracks } = await import('../src/server/tracks/stored-catalog.ts');
const { TRACKS } = await import('../game/track/tracks.js');
const appMedalTimes = (await import('../game/medals/medal-times.json', { with: { type: 'json' } })).default;
const smallSteps = (await import('../game/track/definitions/small-steps.js')).default;
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

    it('checks and keeps a copy whose designated endpoint differs from the app', async () => {
        await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        const key = 'dailygp:campaign:series:v1:series:numbered-v1';
        const record = JSON.parse(strings.get(key));
        record.finalStageId = null;
        record.publishedFinalStageId = null;
        strings.set(key, JSON.stringify(record));
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.series.problems).toContainEqual({ key: 'numbered-v1', problem: expect.stringContaining('final stage') });
        const undo = await runCopyUndo('live-campaign', { username: 'Mod', now: noon });
        expect(undo.removedSeries).toEqual([]);
        expect(await tracks.readStoredTrack(numbers.stages[0].trackKey)).not.toBeNull();
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

describe('the copy undo', () => {
    const stageKeys = numbers.stages.map((stage) => stage.trackKey);

    it('removes the locked copies of past Dailies, and keeps one that differs from the app', async () => {
        addDaily('2030-02-01', 'smallSteps');
        const copied = (await runPlayedDailyCopy({ username: 'Mod', now: noon })).copied;
        tracks.installStoredTrackResolver();
        await ensureStoredCatalogLoaded();
        await loadStoredTracks(['smallSteps']);
        expect(tracks.resolveStoredTrackForRequest('smallSteps')).not.toBeNull();
        const broken = copied.find((key) => key !== 'smallSteps');
        const record = JSON.parse(strings.get(`dailygp:tracks:v1:track:${broken}`));
        record.track.cornerRadius = (record.track.cornerRadius ?? 1) + 1;
        strings.set(`dailygp:tracks:v1:track:${broken}`, JSON.stringify(record));

        const preview = await runCopyUndo('played-dailies', { username: 'Mod', dryRun: true, now: noon });
        expect(preview.removed).toEqual(copied.filter((key) => key !== broken).sort());
        expect(await tracks.readStoredTrack('smallSteps')).not.toBeNull();

        const report = await runCopyUndo('played-dailies', { username: 'Mod', now: noon });
        expect(report.removed).toEqual(preview.removed);
        expect(report.kept).toEqual([{ key: broken, reason: expect.stringContaining('differs') }]);
        expect(await tracks.readStoredTrack('smallSteps')).toBeNull();
        expect(await readCopyUndoReport('played-dailies')).toEqual(report);
        expect(logs.mock.calls.map(([line]) => line))
            .toContainEqual(expect.stringMatching(/^\[track-copy\] undo played-dailies by u\/Mod: removed /));

        // The game reads the app track again, which races the same.
        tracks.installStoredTrackResolver();
        await ensureStoredCatalogLoaded();
        expect(tracks.resolveStoredTrackForRequest('smallSteps')).toBeNull();
        expect(getTrackDefinitionIdentity(TRACKS.smallSteps)).toBe(getTrackDefinitionIdentity(BUILT_IN_TRACKS.smallSteps));
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.tracks.notCopied).toContain('smallSteps');
        expect(check.tracks.problems.map((problem) => problem.key)).toEqual([broken]);
    });

    it('removes a live series copy with its stage tracks, and keeps a series that changed since', async () => {
        await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        const preview = await runCopyUndo('live-campaign', { username: 'Mod', dryRun: true, now: noon });
        expect(preview.removedSeries).toEqual(['numbered-v1']);
        expect(preview.removed).toEqual(stageKeys);

        const key = 'dailygp:campaign:series:v1:series:numbered-v1';
        const record = JSON.parse(strings.get(key));
        strings.set(key, JSON.stringify({ ...record, name: 'Numbers Renamed', revision: 2 }));
        const kept = await runCopyUndo('live-campaign', { username: 'Mod', now: noon });
        expect(kept.removedSeries).toEqual([]);
        expect(kept.kept).toEqual([{ key: 'numbered-v1', reason: expect.stringContaining('Changed') }]);
        expect(await tracks.readStoredTrack(stageKeys[0])).not.toBeNull();

        strings.set(key, JSON.stringify(record));
        const report = await runCopyUndo('live-campaign', { username: 'Mod', now: noon });
        expect(report).toMatchObject({ removedSeries: ['numbered-v1'], removed: stageKeys, kept: [] });
        expect(await series.readStoredSeries('numbered-v1')).toBeNull();
        for (const trackKey of stageKeys) expect(await tracks.readStoredTrack(trackKey), trackKey).toBeNull();
    });

    it('undoes the unplayed copy: the app Daily list, the hidden series, and the exact track copies', async () => {
        const copy = await runTrackMigration({ username: 'Mod', now: noon,
            hooks: { copySeries: (options) => series.copyAppSeriesDrafts(options) } });
        expect(copy.failed).toEqual([]);
        expect((await readDailySchedule()).source).toBe('stored');
        const [changedKey, lockedKey] = copy.copied;
        const changed = await tracks.readStoredTrack(changedKey);
        await tracks.saveStoredTrack(changedKey, { track: { ...changed.track, name: 'Changed In Creator' }, medalRow },
            { username: 'Mod', baseRevision: changed.revision, now: noon });
        expect(await tracks.lockStoredTrack(lockedKey, 'daily', noon)).toBe(true);

        const report = await runCopyUndo('unplayed', { username: 'Mod', now: noon });
        expect(report.dailyList).toBe('restored');
        expect((await readDailySchedule()).source).toBe('app');
        expect(report.removedSeries).toEqual(copy.extra.series.copied);
        expect(report.removed).toContain(lockedKey);
        expect(report.removed).not.toContain(changedKey);
        expect(report.kept).toEqual([{ key: changedKey, reason: expect.stringContaining('differs') }]);
        expect(await tracks.readStoredTrack(lockedKey)).toBeNull();
        expect(await tracks.readStoredTrack(changedKey)).not.toBeNull();
        expect(report.removed.length).toBe(copy.copied.length - 1);
    });

    it('keeps a Daily list that changed since the copy', async () => {
        strings.set('dailygp:daily:schedule:v1', JSON.stringify({
            version: 1, keys: [...TRACK_SCHEDULE_KEYS].reverse(), revision: 2, updatedAt: noon.toISOString(), updatedBy: 'Mod' }));
        const report = await runCopyUndo('unplayed', { username: 'Mod', now: noon });
        expect(report.dailyList).toBe('kept');
        expect(report.kept).toContainEqual({ key: 'dailyList', reason: expect.stringContaining('Changed') });
        expect((await readDailySchedule()).source).toBe('stored');
    });

    it('waits while the Daily changes at midnight UTC', async () => {
        await expect(runCopyUndo('played-dailies', { username: 'Mod', now: new Date('2030-03-10T23:58:00.000Z') }))
            .rejects.toThrow('midnight UTC');
    });
});

describe('copies that a moderator saved again', () => {
    // An unraced app track outside the Daily list, since listed tracks cannot keep an unfinished drawing.
    function unracedKey({ outsideDailyList = false } = {}) {
        const raced = new Set([...Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE),
            ...seriesData.series.flatMap((entry) => (entry.stages ?? []).map((stage) => stage.trackKey))]);
        return Object.keys(BUILT_IN_TRACKS).find((key) => !raced.has(key) && appMedalTimes[key]?.author
            && !(outsideDailyList && TRACK_SCHEDULE_KEYS.includes(key)));
    }

    async function copyThenSave(key, extra) {
        const copy = await tracks.saveStoredTrack(key, { track: BUILT_IN_TRACKS[key], medalRow: appMedalTimes[key] },
            { username: 'Mod', origin: 'migrated', trusted: true, now: noon });
        // A normal Creator save: the medal row goes through the authoring rules.
        await tracks.saveStoredTrack(key, { track: copy.track, medalRow: copy.medalRow, ...extra },
            { username: 'Mod', baseRevision: copy.revision, now: noon });
    }

    it('still finds a copy exact after a Creator save with the same medal times', async () => {
        const key = unracedKey();
        await copyThenSave(key, {});
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.tracks.exact).toContain(key);
        expect(check.tracks.changed).not.toContain(key);
        expect((await runCopyUndo('unplayed', { username: 'Mod', now: noon })).removed).toContain(key);
    });

    it('keeps a copy with an unfinished drawing, and lists it as changed', async () => {
        const key = unracedKey({ outsideDailyList: true });
        await copyThenSave(key, { draftLoop: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 5 }] });
        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.tracks.changed).toContain(key);
        const report = await runCopyUndo('unplayed', { username: 'Mod', now: noon });
        expect(report.removed).not.toContain(key);
        expect((await tracks.readStoredTrack(key)).draftLoop).toHaveLength(3);
    });
});

describe('a hidden app series that a moderator made live', () => {
    it('is a series changed in the Creator, not a problem', async () => {
        series.installStoredSeriesResolver();
        tracks.installStoredTrackResolver();
        for (const [key, name] of [['nightOne', 'Night One'], ['nightTwo', 'Night Two']]) {
            await tracks.saveStoredTrack(key, { track: { ...smallSteps, name }, medalRow },
                { username: 'Mod', now: noon });
        }
        await ensureStoredCatalogLoaded();
        const drafts = await series.copyAppSeriesDrafts({ dryRun: false, username: 'Mod', now: noon });
        const hidden = drafts.copied[0];
        const draft = await series.readStoredSeries(hidden);
        await series.saveStoredSeries(hidden, {
            name: draft.name, ground: 'tarmac',
            stages: [{ trackKey: 'nightOne', laps: 1, requiredMedals: 0 }, { trackKey: 'nightTwo', laps: 1, requiredMedals: 2 }],
        }, { username: 'Mod', baseRevision: draft.revision, now: noon });
        await series.publishStoredSeries(hidden, { username: 'Mod', baseRevision: draft.revision + 1, now: noon });
        await ensureStoredCatalogLoaded();

        const check = await runCopyCheck({ username: 'Mod', now: noon });
        expect(check.series.problems).toEqual([]);
        expect(check.series.changed).toContain(hidden);
        const undo = await runCopyUndo('live-campaign', { username: 'Mod', dryRun: true, now: noon });
        expect(undo.kept.map((entry) => entry.key)).not.toContain(hidden);
    });
});
