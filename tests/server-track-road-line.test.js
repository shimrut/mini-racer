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
const { TrackInputError, normalizeRoadLine } = await import('../src/server/tracks/track-shape.ts');
const { buildLockedTrackCopy, matchesAppTrack } = await import('../src/server/tracks/track-copy.ts');
const { createTrackFingerprint } = await import('../src/server/competition/pb-ghost-trace.ts');
const { TRACKS } = await import('../game/track/tracks.js');
const { setStoredTrackResolver } = await import('../game/track/stored-tracks.js');

const shape = { ...roughCut, name: 'Night Cut' };
const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };
const roadLine = {
    points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }],
    width: 4.8,
};

beforeEach(() => {
    strings.clear();
    hashes.clear();
    vi.clearAllMocks();
    mockContext.subredditId = 't5_one';
    store.clearStoredTrackCacheForTests();
    store.installStoredTrackResolver();
});

afterEach(() => setStoredTrackResolver(null));

describe('road line check', () => {
    it('gives null for a track with no road line', () => {
        expect(normalizeRoadLine(undefined)).toBeNull();
        expect(normalizeRoadLine(null)).toBeNull();
    });

    it('keeps only the points, the width and the rounding of each bend', () => {
        const input = {
            points: roadLine.points.map((point) => ({ ...point, extra: true })),
            width: 4.8,
            extra: 'dropped',
        };
        input.points[1].cornerRadius = 5;
        const expected = structuredClone(roadLine);
        expected.points[1].cornerRadius = 5;
        expect(normalizeRoadLine(input)).toEqual(expected);
    });

    it('refuses a road line out of range', () => {
        const bad = [
            [],
            { points: roadLine.points.slice(0, 2), width: 4.8 },
            { points: Array.from({ length: 161 }, (_, index) => ({ x: index, y: index % 2 })), width: 4.8 },
            { points: roadLine.points, width: 1 },
            { points: roadLine.points, width: 21 },
            { points: roadLine.points, width: Number.NaN },
            { points: [...roadLine.points.slice(0, 3), { x: 2000, y: 0 }], width: 4.8 },
            { points: [...roadLine.points.slice(0, 3), { x: 10, y: 30, cornerRadius: 21 }], width: 4.8 },
            { points: [...roadLine.points.slice(0, 3), { x: 10, y: 30, cornerRadius: -1 }], width: 4.8 },
        ];
        for (const value of bad) {
            expect(() => normalizeRoadLine(value)).toThrow(TrackInputError);
        }
    });
});

describe('stored road line', () => {
    it('saves the road line beside the track, and the fingerprint stays the same', async () => {
        const record = await store.saveStoredTrack('nightCut', { track: shape, medalRow, roadLine }, { username: 'ModOne' });
        expect(record.roadLine).toEqual(roadLine);
        expect(record.track).not.toHaveProperty('roadLine');
        expect(record.fingerprint).toBe(createTrackFingerprint(shape));
        expect((await store.readStoredTrack('nightCut')).roadLine).toEqual(roadLine);
    });

    it('writes no road line field for a track without one', async () => {
        const record = await store.saveStoredTrack('nightCut', { track: shape, medalRow, roadLine: null }, { username: 'ModOne' });
        expect(record).not.toHaveProperty('roadLine');
        expect(JSON.parse(strings.get('dailygp:tracks:v1:track:nightCut'))).not.toHaveProperty('roadLine');
    });

    it('drops the road line when a new revision has none', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow, roadLine }, { username: 'ModOne' });
        const second = await store.saveStoredTrack('nightCut', { track: shape, medalRow }, { username: 'ModOne', baseRevision: 1 });
        expect(second).not.toHaveProperty('roadLine');
    });

    it('refuses a save with a bad road line, and writes nothing', async () => {
        await expect(store.saveStoredTrack('nightCut', {
            track: shape, medalRow, roadLine: { points: roadLine.points, width: 0 },
        }, { username: 'ModOne' })).rejects.toThrow(TrackInputError);
        expect(await store.readStoredTrack('nightCut')).toBeNull();
    });

    it('never gives the road line to the game', async () => {
        await store.saveStoredTrack('nightCut', { track: shape, medalRow, roadLine }, { username: 'ModOne' });
        await ensureStoredCatalogLoaded();
        await loadStoredTracks(['nightCut']);
        expect(TRACKS.nightCut.name).toBe('Night Cut');
        expect(TRACKS.nightCut).not.toHaveProperty('roadLine');
    });

    it('does not count a copy with a road line as the exact app track', () => {
        const copy = buildLockedTrackCopy('roughCut', { username: 'ModOne', reason: 'daily', now: new Date(0) });
        expect(matchesAppTrack(copy)).toBe(true);
        expect(matchesAppTrack({ ...copy, roadLine })).toBe(false);
    });
});
