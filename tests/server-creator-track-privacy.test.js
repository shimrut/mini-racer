import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import smallSteps from '../game/track/definitions/small-steps.js';
import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';

const strings = new Map();
const hashes = new Map();
const known = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value); return 'OK';
    }),
    del: vi.fn(async (...keys) => { keys.flat().forEach((key) => strings.delete(key)); return 1; }),
    mGet: vi.fn(async (keys) => keys.map((key) => strings.get(key) ?? null)),
    hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? new Map())),
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
    hSet: vi.fn(async (key, fields) => {
        const hash = hashes.get(key) ?? new Map();
        Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
        hashes.set(key, hash); return 1;
    }),
    hDel: vi.fn(async (key, fields) => { fields.forEach((field) => hashes.get(key)?.delete(field)); return 1; }),
    incrBy: vi.fn(async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next)); return next;
    }),
};
const redis = new Proxy(known, { get: (target, name) => target[name] ?? (async () => null) });
vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));
vi.mock('@devvit/web/server', () => ({ redis, context: { subredditId: 't5_privacy' } }));

const tracks = await import('../src/server/tracks/track-store.ts');
const access = await import('../src/server/tracks/creator-track-access.ts');
const schedule = await import('../src/server/daily/daily-schedule-store.ts');
const series = await import('../src/server/campaign/series-store.ts');
const { readCreatorDailyView } = await import('../src/server/daily/daily-schedule-view.ts');
const { readCreatorSeriesView } = await import('../src/server/campaign/series-view.ts');
const { ensureStoredCatalogLoaded } = await import('../src/server/tracks/stored-catalog.ts');
const { setStoredTrackResolver } = await import('../game/track/stored-tracks.js');

const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };
const trackKey = 'privateRoad';
const recordKey = tracks.storedTrackRecordKey(trackKey);
const shape = { ...smallSteps, name: 'Private Road' };
const planner = { name: 'Shared Series', ground: 'tarmac', stages: [{ trackKey, laps: 1, requiredMedals: 0 }] };

beforeEach(async () => {
    strings.clear(); hashes.clear(); vi.clearAllMocks();
    installTrackRedisTransactions(redis, strings, hashes);
    tracks.clearStoredTrackCacheForTests(); series.clearStoredSeriesCacheForTests();
    tracks.installStoredTrackResolver();
    await tracks.saveStoredTrack(trackKey, { track: shape, medalRow }, { username: 'ModOne' });
    await ensureStoredCatalogLoaded();
});
afterEach(() => setStoredTrackResolver(null));

function replaceRecord(change) {
    const record = JSON.parse(strings.get(recordKey));
    change(record); strings.set(recordKey, JSON.stringify(record));
    return record;
}

describe('Creator account drafts', () => {
    it('lists and reads only the owner draft, with case insensitive account identity', async () => {
        expect((await access.listCreatorTrackRecords(' modONE '))[0]).toMatchObject({ key: trackKey, privateDraft: true });
        expect((await access.listCreatorTracks('ModOne'))[0]).toMatchObject({ name: 'Private Road', privateDraft: true });
        expect(await access.readCreatorTrack(trackKey, 'ModTwo')).toBeNull();
        expect(await access.listCreatorTrackRecords('ModTwo')).toEqual([]);
        expect(await access.listCreatorTracks('ModTwo')).toEqual([]);
        expect(await tracks.readPlacedStoredTracks([trackKey])).toEqual([]);
        // Internal catalog/copy operations still retain the raw installation list.
        expect((await tracks.listStoredTrackRecords())[0].key).toBe(trackKey);
    });

    it('keeps ownerless legacy drafts hidden and migrated/locked tracks shared', async () => {
        replaceRecord((record) => { delete record.createdBy; });
        expect(await access.readCreatorTrack(trackKey, 'ModOne')).toBeNull();
        expect(await access.listCreatorTracks('')).toEqual([]);
        replaceRecord((record) => { delete record.origin; });
        expect(await access.readCreatorTrack(trackKey, 'ModTwo')).toBeNull();
        expect(await access.listCreatorTracks('ModTwo')).toEqual([]);
        replaceRecord((record) => { record.origin = 'migrated'; });
        expect(await access.readCreatorTrack(trackKey, 'ModTwo')).toMatchObject({ privateDraft: false });
        replaceRecord((record) => { record.origin = 'creator'; record.lockedAt = '2026-10-03T00:00:00.000Z'; });
        expect(await access.readCreatorTrack(trackKey, 'ModTwo')).toMatchObject({ privateDraft: false });
    });

    it('blocks another account save before stale revision disclosure and makes delete absent', async () => {
        const before = strings.get(recordKey);
        for (const baseRevision of [0, 1, 99]) {
            await expect(tracks.saveStoredTrack(trackKey, { track: { ...shape, name: 'Overwrite' } }, {
                username: 'ModTwo', baseRevision,
            })).rejects.toThrow('A track already uses this key. Choose another name.');
        }
        expect(await tracks.deleteStoredTrack(trackKey, { username: 'ModTwo', baseRevision: 99 })).toBe(false);
        expect(strings.get(recordKey)).toBe(before);
        expect(await tracks.deleteStoredTrack(trackKey, { username: ' modONE ', baseRevision: 1 })).toBe(true);
    });

    it.each([
        ['Daily', readCreatorDailyView], ['Campaign', readCreatorSeriesView],
    ])('hides other account drafts from %s candidate metadata', async (_mode, readView) => {
        const own = await readView('ModOne');
        const other = await readView('ModTwo');
        expect(own.tracks.some((entry) => entry.key === trackKey)).toBe(true);
        expect(other.tracks.some((entry) => entry.key === trackKey)).toBe(false);
    });

    it('blocks another account admission before private name/readiness errors', async () => {
        replaceRecord((record) => { record.medalRow = null; });
        await expect(schedule.saveDailySchedule([trackKey], { username: 'ModTwo' }))
            .rejects.toThrow('A track already uses this key. Choose another name.');
        await expect(series.saveStoredSeries('privacy-v1', planner, { username: 'ModTwo' }))
            .rejects.toThrow('A track already uses this key. Choose another name.');
        expect((await schedule.readDailySchedule()).source).toBe('app');
        expect(await series.readStoredSeries('privacy-v1')).toBeNull();
    });

    it.each(['daily', 'campaign'])('shares the owner draft on %s admission, permanently, without exposing it to players', async (mode) => {
        if (mode === 'daily') await schedule.saveDailySchedule([trackKey], { username: ' modONE ' });
        else await series.saveStoredSeries('privacy-v1', planner, { username: ' modONE ' });
        const shared = await access.readCreatorTrack(trackKey, 'ModTwo');
        expect(shared).toMatchObject({ privateDraft: false, revision: 2 });
        expect(shared.sharedAt).toBeTruthy();
        expect(await tracks.readPlacedStoredTracks([trackKey])).toEqual([]);
        if (mode === 'daily') await schedule.saveDailySchedule(['circuit'], { username: 'ModTwo', baseRevision: 1 });
        else await series.deleteStoredSeries('privacy-v1', { baseRevision: 1 });
        const edited = await tracks.saveStoredTrack(trackKey, { track: { ...shape, name: 'Shared Edit' } }, {
            username: 'ModTwo', baseRevision: 2,
        });
        expect(edited.sharedAt).toBe(shared.sharedAt);
        expect(await access.readCreatorTrack(trackKey, 'ModThree')).toMatchObject({ privateDraft: false });
    });

    it.each(['daily', 'campaign-delete', 'campaign-edit'])('retains legacy sharing after %s removes the placement', async (mode) => {
        if (mode === 'daily') await schedule.saveDailySchedule([trackKey], { username: 'ModOne' });
        else await series.saveStoredSeries('privacy-v1', planner, { username: 'ModOne' });
        // Existing deployments have assigned rows without sharedAt.
        replaceRecord((record) => { delete record.sharedAt; });
        expect(await access.readCreatorTrack(trackKey, 'ModTwo')).toMatchObject({ privateDraft: false });
        if (mode === 'daily') await schedule.saveDailySchedule(['circuit'], { username: 'ModTwo', baseRevision: 1 });
        else if (mode === 'campaign-delete') await series.deleteStoredSeries('privacy-v1', { baseRevision: 1 });
        else await series.saveStoredSeries('privacy-v1', { ...planner, stages: [] }, { username: 'ModTwo', baseRevision: 1 });
        expect(await access.readCreatorTrack(trackKey, 'ModTwo')).toMatchObject({ privateDraft: false, sharedAt: expect.any(String) });
    });

    it('keeps draft ownership when a Daily placement transaction aborts', async () => {
        const watch = redis.watch.getMockImplementation();
        redis.watch.mockImplementation(async (...keys) => {
            const transaction = await watch(...keys);
            transaction.exec.mockResolvedValue([]);
            return transaction;
        });
        await expect(schedule.saveDailySchedule([trackKey], { username: 'ModOne' })).rejects.toThrow('Retry');
        expect((await tracks.readStoredTrack(trackKey)).sharedAt).toBeUndefined();
        expect(await access.readCreatorTrack(trackKey, 'ModTwo')).toBeNull();
    });

    it('retries a list that read private geometry before a concurrent shared revision', async () => {
        const read = redis.mGet.getMockImplementation();
        let injected = false;
        redis.mGet.mockImplementation(async (keys) => {
            const values = await read(keys);
            if (keys.includes(recordKey) && !injected) {
                injected = true;
                const next = replaceRecord((record) => {
                    record.track.name = 'Shared Road'; record.revision += 1;
                    record.sharedAt = '2026-10-03T00:00:00.000Z';
                });
                hashes.get(tracks.STORED_TRACKS_INDEX_KEY).set(trackKey, tracks.storedTrackIndexValue(next));
                strings.set(tracks.STORED_TRACKS_REVISION_KEY, '2');
                strings.set('dailygp:daily:schedule:v1', JSON.stringify({
                    version: 1, keys: [trackKey], revision: 1, updatedAt: next.sharedAt, updatedBy: 'ModOne',
                }));
            }
            return values;
        });
        try {
            const listed = await access.listCreatorTrackRecords('ModTwo');
            expect(listed).toHaveLength(1);
            expect(listed[0].track.name).toBe('Shared Road');
            expect(listed[0].privateDraft).toBe(false);
        } finally { redis.mGet.mockImplementation(read); }
    });
});
