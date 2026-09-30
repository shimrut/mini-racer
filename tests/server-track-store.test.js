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

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('@devvit/web/server', () => ({ redis: mockRedis, context: mockContext }));

const store = await import('../src/server/tracks/track-store.ts');
const { TrackInputError } = await import('../src/server/tracks/track-shape.ts');
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
        }, { username: 'ModTwo', baseRevision: 1 });
        expect(second).toMatchObject({ revision: 2, createdBy: 'ModOne', updatedBy: 'ModTwo', medalRow: null });
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

    it('deletes an unlocked track that no list uses', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await expect(store.deleteStoredTrack('nightCut', { isPlaced: async () => true }))
            .rejects.toThrow('Daily list');
        expect(await store.deleteStoredTrack('nightCut', { baseRevision: 1 })).toBe(true);
        expect(await store.readStoredTrack('nightCut')).toBeNull();
        expect(await store.deleteStoredTrack('nightCut')).toBe(false);
    });

    it('lets a migrated copy use the key of a built-in track', async () => {
        const record = await store.saveStoredTrack('roughCut', { track: { ...roughCut, name: 'Rough Cut' } }, {
            username: 'ModOne',
            origin: 'migrated',
        });
        expect(record.origin).toBe('migrated');
    });
});

describe('stored track cache for the game lookup', () => {
    it('fills the lookup for the current subreddit only', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne' });
        expect(TRACKS.nightCut).toBeUndefined();
        await store.ensureStoredTracksLoaded();
        expect(TRACKS.nightCut.name).toBe('Night Cut');
        expect(getTrackMedalThresholds('nightCut')).toEqual({ gold: 9.4, silver: 9.7, bronze: 10.1 });

        mockContext.subredditId = 't5_two';
        expect(TRACKS.nightCut).toBeUndefined();
    });

    it('reads one value when nothing changed, and only the changed track after a save', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await store.saveStoredTrack('dayCut', { track: { ...shape, name: 'Day Cut' } }, { username: 'ModOne' });
        await store.ensureStoredTracksLoaded();
        mockRedis.mGet.mockClear();
        mockRedis.hGetAll.mockClear();

        await store.ensureStoredTracksLoaded();
        expect(mockRedis.hGetAll).not.toHaveBeenCalled();
        expect(mockRedis.mGet).not.toHaveBeenCalled();

        await store.saveStoredTrack('dayCut', { track: { ...shape, name: 'Day Cut II' } }, {
            username: 'ModOne',
            baseRevision: 1,
        });
        await store.ensureStoredTracksLoaded();
        expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
        expect(mockRedis.mGet.mock.calls[0][0]).toEqual(['dailygp:tracks:v1:track:dayCut']);
        expect(TRACKS.dayCut.name).toBe('Day Cut II');
        expect(TRACKS.nightCut.name).toBe('Night Cut');
    });

    it('drops a deleted track from the lookup', async () => {
        await store.saveStoredTrack('nightCut', { track: shape }, { username: 'ModOne' });
        await store.ensureStoredTracksLoaded();
        await store.deleteStoredTrack('nightCut');
        await store.ensureStoredTracksLoaded();
        expect(TRACKS.nightCut).toBeUndefined();
    });
});
