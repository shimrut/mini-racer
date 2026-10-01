import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import smallSteps from '../game/track/definitions/small-steps.js';

const strings = new Map();
const hashes = new Map();
const mockContext = { subredditId: 't5_one' };
const known = {
    get: async (key) => strings.get(key) ?? null,
    set: async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    },
    del: async (...keys) => {
        keys.flat().forEach((key) => strings.delete(key));
        return 1;
    },
    mGet: async (keys) => keys.map((key) => strings.get(key) ?? null),
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

const series = await import('../src/server/campaign/series-store.ts');
const tracks = await import('../src/server/tracks/track-store.ts');
const { ensureStoredCatalogLoaded } = await import('../src/server/tracks/stored-catalog.ts');
const { getCampaignSeries, CAMPAIGN_ALL_SERIES } = await import('../game/campaign/manifest.js');
const { setStoredSeriesResolver } = await import('../game/campaign/stored-series.js');
const { setStoredTrackResolver } = await import('../game/track/stored-tracks.js');

const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };

async function saveTrack(key, name) {
    await tracks.saveStoredTrack(key, { track: { ...smallSteps, name }, medalRow }, { username: 'ModOne' });
}

async function reload() {
    await ensureStoredCatalogLoaded();
}

const draft = {
    name: 'Night Races',
    ground: 'tarmac',
    stages: [
        { trackKey: 'nightOne', laps: 1, requiredMedals: 0 },
        { trackKey: 'nightTwo', laps: 2, requiredMedals: 1 },
    ],
};

beforeEach(async () => {
    strings.clear();
    hashes.clear();
    tracks.clearStoredTrackCacheForTests();
    series.clearStoredSeriesCacheForTests();
    tracks.installStoredTrackResolver();
    series.installStoredSeriesResolver();
    await saveTrack('nightOne', 'Night One');
    await saveTrack('nightTwo', 'Night Two');
    await saveTrack('nightThree', 'Night Three');
    await reload();
});

afterEach(() => {
    setStoredSeriesResolver(null);
    setStoredTrackResolver(null);
});

describe('stored Campaign series', () => {
    it('keeps a draft private, and makes a published series live for players', async () => {
        const saved = await series.saveStoredSeries('night-v1', draft, { username: 'ModOne' });
        expect(saved).toMatchObject({ status: 'draft', publishedStageCount: 0, revision: 1 });
        await reload();
        expect(getCampaignSeries('night-v1')).toBeNull();

        const published = await series.publishStoredSeries('night-v1', { username: 'ModOne', baseRevision: 1 });
        expect(published).toMatchObject({ status: 'published', publishedStageCount: 2 });
        expect((await tracks.readStoredTrack('nightOne')).lockReason).toBe('series');
        await reload();
        expect(getCampaignSeries('night-v1').stages.map((stage) => stage.trackKey)).toEqual(['nightOne', 'nightTwo']);

        mockContext.subredditId = 't5_two';
        expect(getCampaignSeries('night-v1')).toBeNull();
        mockContext.subredditId = 't5_one';
    });

    it('fixes the published stages, and lets new stages go after them', async () => {
        await series.saveStoredSeries('night-v1', draft, { username: 'ModOne' });
        await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        await expect(series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [{ ...draft.stages[0], laps: 3 }, draft.stages[1]],
        }, { username: 'ModOne', baseRevision: 2 })).rejects.toThrow('fixed');

        const appended = await series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [...draft.stages, { trackKey: 'nightThree', laps: 1, requiredMedals: 3 }],
        }, { username: 'ModOne', baseRevision: 2 });
        expect(appended.publishedStageCount).toBe(2);
        await reload();
        expect(getCampaignSeries('night-v1').stages).toHaveLength(2);

        await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        await reload();
        expect(getCampaignSeries('night-v1').stages).toHaveLength(3);
        await expect(series.deleteStoredSeries('night-v1')).rejects.toThrow('live');
    });

    it('checks the stage rules', async () => {
        await expect(series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [{ trackKey: 'nightOne', laps: 1, requiredMedals: 1 }],
        }, { username: 'ModOne' })).rejects.toThrow('first stage needs no medals');
        await expect(series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [{ trackKey: 'nightOne', laps: 4, requiredMedals: 0 }],
        }, { username: 'ModOne' })).rejects.toThrow('Laps');
        await expect(series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [draft.stages[0], { ...draft.stages[0], requiredMedals: 1 }],
        }, { username: 'ModOne' })).rejects.toThrow('only once');
        await expect(series.saveStoredSeries('numbered-v1', draft, { username: 'ModOne' }))
            .rejects.toThrow('Numbers stays in the app');
        const appId = CAMPAIGN_ALL_SERIES.find((entry) => !entry.live).id;
        await expect(series.saveStoredSeries(appId, draft, { username: 'ModOne' }))
            .rejects.toThrow('already uses this key');
        await expect(series.saveStoredSeries('night-v1', draft, {
            username: 'ModOne',
            isTrackUsedElsewhere: async (trackKey) => trackKey === 'nightTwo',
        })).rejects.toThrow('Night Two is used somewhere else');
    });

    it('refuses incomplete stage assignment and publishing on a held-back ground', async () => {
        await tracks.saveStoredTrack('nightFour', { track: { ...smallSteps, name: 'Night Four' } }, { username: 'ModOne' });
        await reload();
        await expect(series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [{ trackKey: 'nightFour', laps: 1, requiredMedals: 0 }],
        }, { username: 'ModOne' })).rejects.toThrow('medal times');
        await tracks.saveStoredTrack('snowNight', { track: { ...smallSteps, name: 'Snow Night', ground: 'snow' }, medalRow }, { username: 'ModOne' });
        await reload();
        await series.saveStoredSeries('snow-night-v1', { ...draft, ground: 'snow', stages: [{ trackKey: 'snowNight', laps: 1, requiredMedals: 0 }] }, { username: 'ModOne' });
        await expect(series.publishStoredSeries('snow-night-v1', { username: 'ModOne' }))
            .rejects.toThrow('live ground');
    });

    it('copies each hidden app series once as a draft', async () => {
        const first = await series.copyAppSeriesDrafts({ dryRun: false, username: 'ModOne' });
        expect(first.live).toContain('numbered-v1');
        expect(first.copied.length).toBeGreaterThan(0);
        expect(first.failed).toEqual([]);
        const copy = await series.readStoredSeries(first.copied[0]);
        expect(copy).toMatchObject({ origin: 'migrated', status: 'draft' });
        const second = await series.copyAppSeriesDrafts({ dryRun: false, username: 'ModOne' });
        expect(second.copied).toEqual([]);
        expect(second.alreadyStored).toEqual(first.copied);
    });
});
