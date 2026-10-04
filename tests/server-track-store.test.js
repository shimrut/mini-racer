import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import roughCut from '../game/track/definitions/rough-cut.js';

const strings = new Map();
const hashes = new Map();
const mockContext = { subredditId: 't5_one' };
const mockRedis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (...keys) => {
        keys.flat().forEach((key) => strings.delete(key));
        return 1;
    }),
    mGet: vi.fn(async (keys) => keys.map((key) => strings.get(key) ?? null)),
    incrBy: vi.fn(async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next));
        return next;
    }),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? new Map())),
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
    hSet: vi.fn(async (key, fields) => {
        const hash = hashes.get(key) ?? new Map();
        Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
        hashes.set(key, hash);
        return 1;
    }),
    hDel: vi.fn(async (key, fields) => {
        fields.forEach((field) => hashes.get(key)?.delete(field));
        return 1;
    }),
};

installTrackRedisTransactions(mockRedis, strings, hashes);

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('@devvit/web/server', () => ({ redis: mockRedis, context: mockContext }));

const store = await import('../src/server/tracks/track-store.ts');
const { ensureStoredCatalogLoaded, loadStoredTracks } = await import('../src/server/tracks/stored-catalog.ts');
const { TrackInputError } = await import('../src/server/tracks/track-shape.ts');
const { TrackPlacementRetryError } = await import('../src/server/tracks/track-placement-lock.ts');
const { TRACKS } = await import('../game/track/tracks.js');
const { getTrackMedalThresholds } = await import('../game/medals/medal-timing.js');
const { setStoredTrackResolver } = await import('../game/track/stored-tracks.js');

const shape = { ...roughCut, name: 'Night Cut' };
const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };

beforeEach(() => {
    strings.clear();
    hashes.clear();
    vi.clearAllMocks();
    mockContext.subredditId = 't5_one';
    store.clearStoredTrackCacheForTests();
    store.installStoredTrackResolver();
});

afterEach(() => setStoredTrackResolver(null));

describe('stored track store', () => {
    it('saves a new track, then a new revision of it', async () => {
        const first = await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        expect(first).toMatchObject({
            key: 'nightCut',
            revision: 1,
            origin: 'creator',
            checksPassed: true,
            lockedAt: null,
            createdBy: 'ModOne',
            medalRow,
        });
        const second = await store.saveStoredTrack('nightCut', {
            track: { ...shape, name: 'Night Cut II' },
            medalRow: null,
        }, { username: 'ModOne', baseRevision: 1 });
        expect(second).toMatchObject({ revision: 2, createdBy: 'ModOne', updatedBy: 'ModOne', medalRow: null });
        expect((await store.listStoredTracks()).map((track) => track.name)).toEqual(['Night Cut II']);
    });

    it('keeps an unfinished road, and marks the checks as not passed', async () => {
        const record = await store.saveStoredTrack('halfRoad', {
            track: { ...shape, outer: [], inner: [] },
            draftLoop: [{ x: 1, y: 2 }],
        }, { username: 'ModOne' });
        expect(record).toMatchObject({ checksPassed: false, checkError: 'Finish the road.', draftLoop: [{ x: 1, y: 2 }] });
    });

    it('refuses a key that a built-in track uses', async () => {
        await expect(store.saveStoredTrack('roughCut', { track: shape }, { username: 'ModOne' }))
            .rejects.toThrow('already uses this key');
    });

    it('refuses a save from an older revision', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await expect(store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne', baseRevision: 0 }))
            .rejects.toBeInstanceOf(store.TrackConflictError);
    });

    it('refuses medal times out of order and bad keys', async () => {
        await expect(store.saveStoredTrack('nightCut', {
            track: shape,
            medalRow: { ...medalRow, gold: 12 },
        }, { username: 'ModOne' })).rejects.toThrow('Medal times must go up');
        await expect(store.saveStoredTrack('Bad Key', { track: shape }, { username: 'ModOne' }))
            .rejects.toBeInstanceOf(TrackInputError);
    });

    it('locks a track when it is placed, then refuses edits and deletes', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        expect(await store.readPlacedStoredTracks(['nightCut'])).toEqual([]);
        expect(await store.lockStoredTrack('nightCut', 'daily')).toBe(true);
        expect(await store.lockStoredTrack('nightCut', 'daily')).toBe(false);
        await expect(store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne', baseRevision: 2 }))
            .rejects.toThrow('locked');
        await expect(store.deleteStoredTrack('nightCut')).rejects.toThrow('locked');
        const placed = await store.readPlacedStoredTracks(['nightCut', 'missingTrack']);
        expect(placed.map((entry) => entry.key)).toEqual(['nightCut']);
        expect(placed[0].medalRow).toMatchObject({ gold: 9.4, author: 9.1 });
    });

    it('never answers with a deleted track after the key is made again', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        await ensureStoredCatalogLoaded();
        await loadStoredTracks(['nightCut']);
        const firstValue = hashes.get('dailygp:tracks:v1:index').get('nightCut');
        expect(TRACKS.nightCut.name).toBe('Night Cut');

        expect(await store.deleteStoredTrack('nightCut', { baseRevision: 1 })).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 2));
        await store.saveStoredTrack('nightCut', { track: { ...shape, name: 'Day Cut' }, medalRow }, { username: 'ModOne' });
        const secondValue = hashes.get('dailygp:tracks:v1:index').get('nightCut');

        // Both records are revision 1, but their index values differ.
        expect(firstValue.startsWith('1:')).toBe(true);
        expect(secondValue.startsWith('1:')).toBe(true);
        expect(secondValue).not.toBe(firstValue);
        await ensureStoredCatalogLoaded();
        // The old track is still in the cache, under its old index value.
        expect(() => TRACKS.nightCut).toThrow(store.StoredTrackNotLoadedError);
        await loadStoredTracks(['nightCut']);
        expect(TRACKS.nightCut.name).toBe('Day Cut');
    });

    it('still reads an index value that holds only the revision', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        await store.lockStoredTrack('nightCut', 'daily');
        hashes.get('dailygp:tracks:v1:index').set('nightCut', '2');
        expect((await store.readPlacedStoredTracks(['nightCut'])).map((entry) => entry.key)).toEqual(['nightCut']);
    });

    it('reads only the asked tracks, with one index read and one record read', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        await store.lockStoredTrack('nightCut', 'daily');
        vi.clearAllMocks();

        const placed = await store.readPlacedStoredTracks(['nightCut', 'roughCut']);

        expect(placed.map((entry) => entry.key)).toEqual(['nightCut']);
        expect(mockRedis.hMGet).toHaveBeenCalledTimes(1);
        expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
        expect(mockRedis.hGetAll).not.toHaveBeenCalled();
    });

    it('answers retry, never absent, when the index and a record disagree', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        await store.lockStoredTrack('nightCut', 'daily');
        // A record without its index field: a placement between the reads, or a broken list.
        hashes.get('dailygp:tracks:v1:index').delete('nightCut');
        await expect(store.readPlacedStoredTracks(['nightCut']))
            .rejects.toBeInstanceOf(TrackPlacementRetryError);

        // An index field with a damaged record.
        hashes.get('dailygp:tracks:v1:index').set('nightCut', '2');
        strings.set('dailygp:tracks:v1:track:nightCut', '{broken');
        await expect(store.readPlacedStoredTracks(['nightCut']))
            .rejects.toBeInstanceOf(TrackPlacementRetryError);
        expect(mockRedis.hMGet).toHaveBeenCalledTimes(4);
    });

    it('reads again when a placement lands between the two reads', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        await store.lockStoredTrack('nightCut', 'daily');
        const index = hashes.get('dailygp:tracks:v1:index');
        const revision = index.get('nightCut');
        index.delete('nightCut');
        // The first index read misses the new field; the record is already there.
        mockRedis.hMGet.mockImplementationOnce(async (key, fields) => {
            const values = fields.map(() => null);
            index.set('nightCut', revision);
            return values;
        });

        const placed = await store.readPlacedStoredTracks(['nightCut']);

        expect(placed.map((entry) => entry.key)).toEqual(['nightCut']);
    });

    it('deletes an unlocked track that no list uses', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await expect(store.deleteStoredTrack('nightCut', { isPlaced: async () => true }))
            .rejects.toThrow('Daily list');
        expect(await store.deleteStoredTrack('nightCut', { baseRevision: 1 })).toBe(true);
        expect(await store.readStoredTrack('nightCut')).toBeNull();
        expect(await store.deleteStoredTrack('nightCut')).toBe(false);
    });

    it('lets a migrated copy use the key of a built-in track', async () => {
        const record = await store.saveStoredTrack('roughCut', { track: { ...roughCut, name: 'Rough Cut' }, medalRow }, {
            username: 'ModOne',
            origin: 'migrated',
        });
        expect(record.origin).toBe('migrated');
    });
});

describe('stored track cache for the game lookup', () => {
    it('fills the lookup for the current subreddit only, with the tracks a request loads', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        expect(TRACKS.nightCut).toBeUndefined();
        await ensureStoredCatalogLoaded();
        // Listed, but not loaded: the lookup refuses, and never gives the app layout.
        expect('nightCut' in TRACKS).toBe(true);
        expect(() => TRACKS.nightCut).toThrow(store.StoredTrackNotLoadedError);
        expect(() => store.describePlacedStoredTracks(['nightCut'])).toThrow(store.StoredTrackNotLoadedError);
        await loadStoredTracks(['nightCut']);
        expect(TRACKS.nightCut.name).toBe('Night Cut');
        expect(getTrackMedalThresholds('nightCut')).toEqual({ gold: 9.4, silver: 9.7, bronze: 10.1 });

        mockContext.subredditId = 't5_two';
        expect(TRACKS.nightCut).toBeUndefined();
    });

    it('reads only the revisions when nothing changed, and only the named tracks', async () => {
        const revisionKeys = ['dailygp:tracks:v1:revision', 'dailygp:campaign:series:v1:revision'];
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await store.saveStoredTrack('dayCut', { track: { ...shape, name: 'Day Cut' } }, { username: 'ModOne' });
        await ensureStoredCatalogLoaded();
        await loadStoredTracks(['nightCut', 'dayCut']);
        mockRedis.mGet.mockClear();
        mockRedis.hGetAll.mockClear();

        // A warm server: one read of the revisions, and no track read.
        await ensureStoredCatalogLoaded();
        await loadStoredTracks(['nightCut', 'dayCut']);
        expect(mockRedis.hGetAll).not.toHaveBeenCalled();
        expect(mockRedis.mGet.mock.calls).toEqual([[revisionKeys]]);

        await store.saveStoredTrack('dayCut', { track: { ...shape, name: 'Day Cut II' } }, {
            username: 'ModOne',
            baseRevision: 1,
        });
        mockRedis.mGet.mockClear();
        mockRedis.hGetAll.mockClear();
        // After a save: the list once, and no track until a request names it.
        await ensureStoredCatalogLoaded();
        expect(mockRedis.hGetAll.mock.calls).toEqual([['dailygp:tracks:v1:index']]);
        expect(mockRedis.mGet.mock.calls).toEqual([[revisionKeys], [revisionKeys]]);
        await loadStoredTracks(['dayCut']);
        expect(mockRedis.mGet.mock.calls.at(-1)).toEqual([['dailygp:tracks:v1:track:dayCut']]);
        expect(TRACKS.dayCut.name).toBe('Day Cut II');
        expect(TRACKS.nightCut.name).toBe('Night Cut');
    });

    it('loads 100 stored tracks only when a request names them', async () => {
        for (let index = 0; index < 100; index += 1) {
            await store.saveStoredTrack(`track${index}`, { track: { ...shape, name: `Track ${index}` } }, { username: 'ModOne' });
        }
        mockRedis.mGet.mockClear();
        await ensureStoredCatalogLoaded();
        await loadStoredTracks(['track42']);
        const trackReads = mockRedis.mGet.mock.calls.filter(([keys]) => keys.some((key) => key.includes(':track:')));
        expect(trackReads).toEqual([[['dailygp:tracks:v1:track:track42']]]);
        expect(TRACKS.track42.name).toBe('Track 42');
    });

    it('reads the list again and retries when a record changed after the list was read', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await ensureStoredCatalogLoaded();
        // A save lands after this server read the list.
        await store.saveStoredTrack('nightCut', { track: { ...shape, name: 'Night Cut II' } }, { username: 'ModOne', baseRevision: 1 });
        await loadStoredTracks(['nightCut']);
        expect(TRACKS.nightCut.name).toBe('Night Cut II');
    });

    it('keeps each request on its own pinned list while another request reads a newer one', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await ensureStoredCatalogLoaded();
        await store.runWithPinnedStoredTracks(async () => {
            await loadStoredTracks(['nightCut']);
            // Another request publishes a newer list after a save.
            await store.saveStoredTrack('nightCut', { track: { ...shape, name: 'Night Cut II' } }, { username: 'ModOne', baseRevision: 1 });
            await store.runWithPinnedStoredTracks(async () => {
                await ensureStoredCatalogLoaded();
                store.repinStoredTracks();
                await loadStoredTracks(['nightCut']);
                expect(TRACKS.nightCut.name).toBe('Night Cut II');
            });
            // This request still reads the track of its own list.
            expect(TRACKS.nightCut.name).toBe('Night Cut');
        });
    });

    it('answers retry when a listed record stays broken', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await ensureStoredCatalogLoaded();
        strings.set('dailygp:tracks:v1:track:nightCut', '{broken');
        await expect(loadStoredTracks(['nightCut'])).rejects.toBeInstanceOf(TrackPlacementRetryError);
    });

    it('drops a deleted track from the lookup', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await ensureStoredCatalogLoaded();
        await store.deleteStoredTrack('nightCut');
        await ensureStoredCatalogLoaded();
        expect(TRACKS.nightCut).toBeUndefined();
    });
});
