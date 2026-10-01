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
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
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
const { ensureStoredCatalogLoaded } = await import('../src/server/tracks/stored-catalog.ts');
const { buildLockedTrackCopy, matchesAppTrack } = await import('../src/server/tracks/track-copy.ts');
const { runPlayedDailyCopy, runLiveCampaignCopy, readLockedCopyReport } = await import('../src/server/tracks/track-migration.ts');
const series = await import('../src/server/campaign/series-store.ts');
const { readCreatorSeriesView } = await import('../src/server/campaign/series-view.ts');
const { campaignHasSeriesChoice, getCampaignSeries } = await import('../game/campaign/manifest.js');
const seriesData = (await import('../game/campaign/series.json', { with: { type: 'json' } })).default;
const { DAILY_GP_CHALLENGE_HISTORY_HASH_KEY } = await import('../src/server/daily/daily-gp-model.ts');
const { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } = await import('../game/shared/daily-gp-history-backfill.js');
const { BUILT_IN_TRACKS, TRACKS } = await import('../game/track/tracks.js');
const { getTrackDefinitionIdentity } = await import('../game/track/definition-identity.js');
const { getRaceMedalThresholds } = await import('../game/medals/medal-timing.js');
const { createTrackFingerprint } = await import('../src/server/competition/pb-ghost-trace.ts');

const noon = new Date('2030-03-10T12:00:00.000Z');

function addDaily(date, trackKey, { playableDays = 7 } = {}) {
    const hash = hashes.get(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY) ?? new Map();
    const startsAt = new Date(`${date}T00:00:00.000Z`);
    hash.set(`daily-gp-${date}`, JSON.stringify({
        id: `daily-gp-${date}`,
        challengeDate: date,
        trackKey,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 86_400_000).toISOString(),
        availableUntil: new Date(startsAt.getTime() + playableDays * 86_400_000).toISOString(),
    }));
    hashes.set(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, hash);
}

beforeEach(() => {
    strings.clear(); hashes.clear(); vi.clearAllMocks();
    installTrackRedisTransactions(redis, strings, hashes);
    tracks.clearStoredTrackCacheForTests();
    tracks.installStoredTrackResolver();
    series.clearStoredSeriesCacheForTests();
    series.installStoredSeriesResolver();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(noon);
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

const copyLiveSeries = (options) => series.copyLiveAppSeries(options);
const numbers = seriesData.series.find((entry) => entry.id === 'numbered-v1');

describe('exact copies of app tracks', () => {
    it('copies every app track exactly, with its fingerprint and medal times', () => {
        for (const trackKey of Object.keys(BUILT_IN_TRACKS)) {
            const record = buildLockedTrackCopy(trackKey, { username: 'Mod', reason: 'daily', now: noon });
            expect(matchesAppTrack(record), trackKey).toBe(true);
            expect(record.fingerprint).toBe(createTrackFingerprint(BUILT_IN_TRACKS[trackKey]));
            expect(record).toMatchObject({ lockedAt: noon.toISOString(), lockReason: 'daily', origin: 'migrated' });
        }
    });

    it('refuses a copy with other corner rounding, although its ghost fingerprint is the same', () => {
        const record = buildLockedTrackCopy('smallSteps', { username: 'Mod', reason: 'daily', now: noon });
        const rounder = { ...record, track: { ...record.track, cornerRadius: (record.track.cornerRadius ?? 3) + 1 } };
        expect(createTrackFingerprint(rounder.track)).toBe(record.fingerprint);
        expect(matchesAppTrack(rounder)).toBe(false);
        expect(matchesAppTrack({ ...record, medalRow: { ...record.medalRow, gold: record.medalRow.gold + 0.01 } })).toBe(false);
    });
});

describe('copy of played Dailies', () => {
    it('copies past Daily tracks locked, and leaves open Dailies and Campaign stages for later', async () => {
        addDaily('2030-02-01', 'smallSteps');
        addDaily('2030-02-02', 'numberOne');
        addDaily('2030-03-10', 'babylonRace');
        const identityBefore = getTrackDefinitionIdentity(TRACKS.smallSteps);
        const medalsBefore = getRaceMedalThresholds('smallSteps', 1);

        const preview = await runPlayedDailyCopy({ username: 'Mod', dryRun: true, now: noon });
        expect(preview.copied).toContain('smallSteps');
        expect(preview.copied).toEqual(expect.arrayContaining(Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE)));
        expect(preview.waiting).toEqual(['babylonRace']);
        expect(preview.copied).not.toContain('numberOne');
        expect(await tracks.readStoredTrack('smallSteps')).toBeNull();
        expect(await readLockedCopyReport('played-dailies')).toBeNull();

        const report = await runPlayedDailyCopy({ username: 'Mod', now: noon });
        expect(report.failed).toEqual([]);
        expect(report.copied).toEqual(preview.copied);
        const copy = await tracks.readStoredTrack('smallSteps');
        expect(copy).toMatchObject({ lockReason: 'daily', lockedAt: noon.toISOString(), origin: 'migrated' });
        expect(matchesAppTrack(copy)).toBe(true);
        expect(await tracks.readStoredTrack('babylonRace')).toBeNull();
        expect(await tracks.readStoredTrack('numberOne')).toBeNull();
        expect((await readLockedCopyReport('played-dailies')).copied).toEqual(report.copied);

        // Players read the locked copy, and it races and scores like the app track.
        expect(await tracks.readPlacedStoredTracks(['smallSteps'])).toHaveLength(1);
        await ensureStoredCatalogLoaded();
        expect(getTrackDefinitionIdentity(TRACKS.smallSteps)).toBe(identityBefore);
        expect(getRaceMedalThresholds('smallSteps', 1)).toEqual(medalsBefore);
        await expect(tracks.saveStoredTrack('smallSteps', { track: BUILT_IN_TRACKS.smallSteps }, {
            username: 'Mod', baseRevision: copy.revision,
        })).rejects.toThrow('locked');

        const again = await runPlayedDailyCopy({ username: 'Mod', now: noon });
        expect(again.copied).toEqual([]);
        expect(again.alreadyStored).toEqual(report.copied);
        expect(again.waiting).toEqual(['babylonRace']);
    });

    it('copies an open Daily track once players can no longer race it', async () => {
        addDaily('2030-03-10', 'babylonRace');
        expect((await runPlayedDailyCopy({ username: 'Mod', dryRun: true, now: noon })).waiting).toEqual(['babylonRace']);
        const later = new Date('2030-03-18T12:00:00.000Z');
        vi.setSystemTime(later);
        expect((await runPlayedDailyCopy({ username: 'Mod', dryRun: true, now: later })).copied).toContain('babylonRace');
    });

    it('waits while the Daily changes at midnight UTC', async () => {
        await expect(runPlayedDailyCopy({ username: 'Mod', now: new Date('2030-03-10T23:58:00.000Z') }))
            .rejects.toThrow('midnight UTC');
    });
});

describe('copy of the live Campaign', () => {
    it('copies Numbers published with every stage, and its stage tracks locked', async () => {
        const stageKeys = numbers.stages.map((stage) => stage.trackKey);
        const preview = await runLiveCampaignCopy({ username: 'Mod', dryRun: true, now: noon, copyLiveSeries });
        expect(preview).toMatchObject({ copied: ['numbered-v1'], tracks: stageKeys, failed: [] });
        expect(await series.readStoredSeries('numbered-v1')).toBeNull();

        const report = await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        expect(report).toMatchObject({ copied: ['numbered-v1'], tracks: stageKeys, failed: [] });
        const copy = await series.readStoredSeries('numbered-v1');
        expect(copy).toMatchObject({ status: 'published', publishedStageCount: numbers.stages.length, origin: 'migrated' });
        expect(copy.stages).toEqual(numbers.stages);
        for (const trackKey of stageKeys) {
            const track = await tracks.readStoredTrack(trackKey);
            expect(track, trackKey).toMatchObject({ lockReason: 'series', lockedAt: noon.toISOString() });
            expect(matchesAppTrack(track)).toBe(true);
        }
        expect((await readLockedCopyReport('live-campaign')).copied).toEqual(['numbered-v1']);

        // The game still races Numbers from the app, and the Creator does not offer the copy.
        await ensureStoredCatalogLoaded();
        expect(getCampaignSeries('numbered-v1').stages.map((stage) => stage.trackKey)).toEqual(stageKeys);
        expect(campaignHasSeriesChoice()).toBe(false);
        const view = await readCreatorSeriesView();
        expect(view.series.map((entry) => entry.id)).not.toContain('numbered-v1');
        expect(view.appSeries.find((entry) => entry.id === 'numbered-v1')).toMatchObject({ live: true });

        const again = await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        expect(again).toMatchObject({ copied: [], alreadyStored: ['numbered-v1'], tracks: [] });
    });

    it('writes neither the series nor any stage track when its save fails', async () => {
        rejectCommit((commands) => commands.some(([method, args]) => method === 'set' && args[0].includes(':series:')));
        const report = await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        expect(report.copied).toEqual([]);
        expect(report.failed).toEqual([{ key: 'numbered-v1', error: expect.stringContaining('Retry') }]);
        expect(await series.readStoredSeries('numbered-v1')).toBeNull();
        expect(await tracks.readStoredTrackKeys()).toEqual(new Set());
    });

    it('lets the played Daily copy leave a Campaign stage to the Campaign copy', async () => {
        addDaily('2030-02-02', 'numberOne');
        expect((await runPlayedDailyCopy({ username: 'Mod', now: noon })).copied).not.toContain('numberOne');
        await runLiveCampaignCopy({ username: 'Mod', now: noon, copyLiveSeries });
        expect(await tracks.readStoredTrack('numberOne')).toMatchObject({ lockReason: 'series' });
    });
});
