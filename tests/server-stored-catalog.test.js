import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import smallSteps from '../game/track/definitions/small-steps.js';

const strings = new Map();
const hashes = new Map();
const mockContext = { subredditId: 't5_one' };
const failures = { get: new Set(), mGet: 0 };
const known = {
    get: async (key) => {
        if (failures.get.has(key)) throw new Error(`redis: ${key} timed out`);
        return strings.get(key) ?? null;
    },
    set: async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    },
    del: async (...keys) => {
        keys.flat().forEach((key) => strings.delete(key));
        return 1;
    },
    mGet: async (keys) => {
        if (failures.mGet > 0) {
            failures.mGet -= 1;
            throw new Error('redis: mGet timed out');
        }
        return keys.map((key) => strings.get(key) ?? null);
    },
    incrBy: async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next));
        return next;
    },
    hGetAll: async (key) => Object.fromEntries(hashes.get(key) ?? new Map()),
    hSet: async (key, fields) => {
        const hash = hashes.get(key) ?? new Map();
        Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
        hashes.set(key, hash);
        return 1;
    },
    hDel: async (key, fields) => {
        fields.forEach((field) => hashes.get(key)?.delete(field));
        return 1;
    },
    hScan: async () => ({ cursor: 0, fieldValues: [] }),
    expire: async () => true,
};
const mockRedis = new Proxy(known, { get: (target, name) => target[name] ?? (async () => null) });

installTrackRedisTransactions(mockRedis, strings, hashes);

vi.mock('@devvit/redis', () => ({ redis: mockRedis, redisCompressed: mockRedis }));
vi.mock('@devvit/web/server', () => ({ redis: mockRedis, context: mockContext }));

const catalog = await import('../src/server/tracks/stored-catalog.ts');
const tracks = await import('../src/server/tracks/track-store.ts');
const series = await import('../src/server/campaign/series-store.ts');

const TRACK_REVISION_KEY = 'dailygp:tracks:v1:revision';
const SERIES_REVISION_KEY = 'dailygp:campaign:series:v1:revision';
const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };

async function saveTrack(key, name) {
    await tracks.saveStoredTrack(key, { track: { ...smallSteps, name }, medalRow }, { username: 'ModOne' });
}

beforeEach(() => {
    strings.clear();
    hashes.clear();
    failures.get.clear();
    failures.mGet = 0;
    mockContext.subredditId = 't5_one';
    tracks.clearStoredTrackCacheForTests();
    series.clearStoredSeriesCacheForTests();
    tracks.installStoredTrackResolver();
    series.installStoredSeriesResolver();
});

describe('the stored catalog', () => {
    it('loads the stored tracks and the published series', async () => {
        await saveTrack('nightOne', 'Night One');
        await catalog.ensureStoredCatalogLoaded();
        expect(tracks.resolveStoredTrackForRequest('nightOne')?.name).toBe('Night One');
    });

    it('fails when the series cannot load, even if the tracks load', async () => {
        await saveTrack('nightOne', 'Night One');
        failures.get.add(SERIES_REVISION_KEY);
        await expect(catalog.ensureStoredCatalogLoaded()).rejects.toBeInstanceOf(catalog.StoredCatalogUnavailableError);
    });

    it('fails when the tracks cannot load, and still tries the series', async () => {
        failures.get.add(TRACK_REVISION_KEY);
        const seriesGet = vi.spyOn(known, 'get');
        await expect(catalog.ensureStoredCatalogLoaded()).rejects.toBeInstanceOf(catalog.StoredCatalogUnavailableError);
        expect(seriesGet.mock.calls.some(([key]) => key === SERIES_REVISION_KEY)).toBe(true);
        seriesGet.mockRestore();
    });

    it('fails on a warm process whose refresh cannot read', async () => {
        await saveTrack('nightOne', 'Night One');
        await catalog.ensureStoredCatalogLoaded();
        await saveTrack('nightTwo', 'Night Two');
        failures.get.add(TRACK_REVISION_KEY);
        await expect(catalog.ensureStoredCatalogLoaded()).rejects.toBeInstanceOf(catalog.StoredCatalogUnavailableError);
    });
});
