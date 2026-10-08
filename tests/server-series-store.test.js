import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import smallSteps from '../game/track/definitions/small-steps.js';

const strings = new Map();
const hashes = new Map();
const mockContext = { subredditId: 't5_one' };
const mockLiveGroundKeys = vi.hoisted(() => new Set(['tarmac']));
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
vi.mock('../game/track/live-grounds.js', () => ({
    LIVE_GROUND_KEYS: ['tarmac'],
    isLiveGround: (ground) => mockLiveGroundKeys.has(ground ?? 'tarmac'),
}));

const series = await import('../src/server/campaign/series-store.ts');
const tracks = await import('../src/server/tracks/track-store.ts');
const { ensureStoredCatalogLoaded } = await import('../src/server/tracks/stored-catalog.ts');
const { getCampaignSeries, getCampaignFinalStage, isCampaignSeriesFinished, CAMPAIGN_ALL_SERIES } = await import('../game/campaign/manifest.js');
const { setStoredSeriesResolver } = await import('../game/campaign/stored-series.js');
const { setStoredTrackResolver } = await import('../game/track/stored-tracks.js');

const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };

async function saveTrack(key, name, ground = 'tarmac') {
    await tracks.saveStoredTrack(key, { track: { ...smallSteps, name, ground }, medalRow }, { username: 'ModOne' });
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
    installTrackRedisTransactions(mockRedis, strings, hashes);
    mockLiveGroundKeys.clear();
    mockLiveGroundKeys.add('tarmac');
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
    it('publishes a designated endpoint explicitly and freezes it permanently', async () => {
        await series.saveStoredSeries('night-v1', draft, { username: 'ModOne' });
        await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        await reload();
        const results = { 'night-v1-01': { medal: 'bronze' } };
        expect(isCampaignSeriesFinished('night-v1', results)).toBe(false);

        const declared = await series.saveStoredSeries('night-v1', {
            ...draft, finalStageId: 'night-v1-01',
        }, { username: 'ModOne', baseRevision: 2 });
        expect(declared).toMatchObject({ finalStageId: 'night-v1-01', publishedFinalStageId: null });
        await reload();
        expect(getCampaignFinalStage('night-v1')).toBeNull();

        const sealed = await series.publishStoredSeries('night-v1', { username: 'ModOne', baseRevision: 3 });
        expect(sealed).toMatchObject({ publishedFinalStageId: 'night-v1-01', publishedStageCount: 2 });
        await reload();
        expect(getCampaignFinalStage('night-v1')?.raceId).toBe('night-v1-01');
        expect(isCampaignSeriesFinished('night-v1', results)).toBe(true);
        for (const input of [
            { ...draft, finalStageId: null },
            { ...draft, finalStageId: 'night-v1-02', stages: [...draft.stages,
                { trackKey: 'nightThree', laps: 1, requiredMedals: 3 }] },
        ]) {
            await expect(series.saveStoredSeries('night-v1', input, { username: 'ModOne', baseRevision: sealed.revision }))
                .rejects.toThrow('endpoint cannot change');
        }
        expect(await series.saveStoredSeries('night-v1', { ...draft, name: 'Night renamed' }, {
            username: 'ModOne', baseRevision: sealed.revision,
        })).toMatchObject({ name: 'Night renamed', finalStageId: 'night-v1-01', publishedFinalStageId: 'night-v1-01' });
    });

    it('allows progressive release before the final declaration is published', async () => {
        await series.saveStoredSeries('night-v1', { ...draft, finalStageId: 'night-v1-01' }, { username: 'ModOne' });
        const extended = await series.saveStoredSeries('night-v1', { ...draft, finalStageId: 'night-v1-02',
            stages: [...draft.stages, { trackKey: 'nightThree', laps: 1, requiredMedals: 3 }],
        }, { username: 'ModOne', baseRevision: 1 });
        expect(extended.publishedFinalStageId).toBeNull();
        const published = await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        expect(series.toSeriesDefinition(published).finalStageId).toBe('night-v1-02');
    });

    it('rejects a non-tail or foreign final stage and leaves legacy Creator series ongoing', async () => {
        for (const finalStageId of ['night-v1-00', 'other-v1-01', 'night-v1-99', 1]) {
            await expect(series.saveStoredSeries('night-v1', { ...draft, finalStageId }, { username: 'ModOne' }))
                .rejects.toThrow('last stage');
        }
        await series.saveStoredSeries('night-v1', draft, { username: 'ModOne' });
        const published = await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        delete published.finalStageId;
        delete published.publishedFinalStageId;
        expect(series.toSeriesDefinition(published).finalStageId).toBeNull();
    });

    it('copies explicit app endpoints without inventing endpoints for hidden app drafts', async () => {
        const copied = await series.copyLiveAppSeries({ dryRun: false, username: 'ModOne' });
        expect(copied.failed).toEqual([]);
        const numbers = await series.readStoredSeries('numbered-v1');
        expect(numbers).toMatchObject({ finalStageId: 'numbered-v1-16', publishedFinalStageId: 'numbered-v1-16' });
        delete numbers.finalStageId;
        delete numbers.publishedFinalStageId;
        expect(series.toSeriesDefinition(numbers).finalStageId).toBe('numbered-v1-16');
        numbers.origin = 'creator';
        expect(series.toSeriesDefinition(numbers).finalStageId).toBeNull();
        const hidden = await series.copyAppSeriesDrafts({ dryRun: false, username: 'ModOne' });
        for (const id of hidden.copied) expect(await series.readStoredSeries(id))
            .toMatchObject({ finalStageId: null, publishedFinalStageId: null });
    });

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

    it('reads only the series cache of the install that makes the request', () => {
        series.clearStoredSeriesCacheForTests();
        const byId = { revision: '5', published: Object.freeze([{ id: 'by-id' }]) };
        const byName = { revision: '5', published: Object.freeze([{ id: 'by-name' }]) };
        series.publishStoredSeriesSnapshot('t5_one', byId);
        series.publishStoredSeriesSnapshot('miniracer', byName);
        try {
            mockContext.subredditName = 'MiniRacer';
            expect(series.resolveStoredSeriesForRequest()).toBe(byId.published);

            delete mockContext.subredditId;
            expect(series.resolveStoredSeriesForRequest()).toBe(byName.published);
            mockContext.subredditId = '';
            expect(series.resolveStoredSeriesForRequest()).toBe(byName.published);

            delete mockContext.subredditName;
            expect(series.resolveStoredSeriesForRequest()).toEqual([]);
            mockContext.subredditId = 't5_two';
            expect(series.resolveStoredSeriesForRequest()).toEqual([]);

            Object.defineProperty(mockContext, 'subredditId', {
                configurable: true,
                enumerable: true,
                get() { throw new Error('No request context.'); },
            });
            expect(series.resolveStoredSeriesForRequest()).toEqual([]);
        } finally {
            Object.defineProperty(mockContext, 'subredditId', {
                configurable: true,
                enumerable: true,
                writable: true,
                value: 't5_one',
            });
            delete mockContext.subredditName;
        }
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

    it('refuses incomplete stage assignment, and publishes a stage on a held-back ground', async () => {
        await tracks.saveStoredTrack('nightFour', { track: { ...smallSteps, name: 'Night Four' } }, { username: 'ModOne' });
        await reload();
        await expect(series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [{ trackKey: 'nightFour', laps: 1, requiredMedals: 0 }],
        }, { username: 'ModOne' })).rejects.toThrow('medal times');
        await tracks.saveStoredTrack('snowNight', { track: { ...smallSteps, name: 'Snow Night', ground: 'snow' }, medalRow }, { username: 'ModOne' });
        await reload();
        await series.saveStoredSeries('snow-night-v1', { ...draft, ground: 'snow', stages: [{ trackKey: 'snowNight', laps: 1, requiredMedals: 0 }] }, { username: 'ModOne' });
        expect(await series.publishStoredSeries('snow-night-v1', { username: 'ModOne' }))
            .toMatchObject({ status: 'published', grounds: ['snow'] });
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

    it('makes only Numbers live from the app data, whatever the stage surfaces', () => {
        expect(series.isLiveAppSeries(series.listAppSeriesDefinitions()
            .find((definition) => definition.id === 'numbered-v1'))).toBe(true);
        expect(series.isLiveAppSeries({
            id: 'test-v1', ground: 'tarmac',
            stages: [{ trackKey: 'circuit', laps: 1, requiredMedals: 0 }],
        })).toBe(false);
        expect(series.isLiveAppSeries({
            id: 'dirt-v1', ground: 'dirt',
            stages: [{ trackKey: 'countryRoad', laps: 1, requiredMedals: 0 }],
        })).toBe(false);
    });

    it('allows a draft to contain every track surface without freezing it', async () => {
        const grounds = ['tarmac', 'dirt', 'snow', 'grip', 'water', 'space'];
        const stages = [];
        for (const [index, ground] of grounds.entries()) {
            const trackKey = `mixedTrack${index}`;
            await saveTrack(trackKey, `Mixed Track ${index}`, ground);
            stages.push({ trackKey, laps: 1, requiredMedals: index });
        }
        await reload();
        const saved = await series.saveStoredSeries('mixed-v1', {
            name: 'Mixed', ground: 'tarmac', stages, grounds: ['space'],
        }, { username: 'ModOne' });
        expect(saved).toMatchObject({ status: 'draft', publishedStageCount: 0, stages });
        expect(saved.grounds).toBeUndefined();
        for (const stage of stages) expect((await tracks.readStoredTrack(stage.trackKey)).lockedAt).toBeNull();
    });

    it('publishes a series whatever the grounds of its stages', async () => {
        await saveTrack('dirtNight', 'Dirt Night', 'dirt');
        await reload();
        await series.saveStoredSeries('mixed-v1', {
            ...draft, finalStageId: 'mixed-v1-01', stages: [draft.stages[0], { trackKey: 'dirtNight', laps: 1, requiredMedals: 1 }],
        }, { username: 'ModOne' });
        expect(await series.publishStoredSeries('mixed-v1', { username: 'ModOne' }))
            .toMatchObject({ status: 'published', publishedStageCount: 2, grounds: ['tarmac', 'dirt'] });
        await reload();
        expect(getCampaignSeries('mixed-v1')).toMatchObject({ live: true, grounds: ['tarmac', 'dirt'] });
        expect((await tracks.readStoredTrack('dirtNight')).lockReason).toBe('series');
    });

    it('publishes the actual Street track even if legacy series metadata names a held surface', async () => {
        await series.saveStoredSeries('night-v1', { ...draft, ground: 'snow' }, { username: 'ModOne' });
        expect(await series.publishStoredSeries('night-v1', { username: 'ModOne' }))
            .toMatchObject({ ground: 'snow', grounds: ['tarmac'], publishedStageCount: 2 });
        await reload();
        expect(getCampaignSeries('night-v1')).toMatchObject({ live: true, grounds: ['tarmac'] });
    });

    it('publishes and locks mixed stages together on every surface', async () => {
        const grounds = ['tarmac', 'dirt', 'snow', 'grip', 'water', 'space'];
        const stages = [];
        for (const [index, ground] of grounds.entries()) {
            const trackKey = `mixedTrack${index}`;
            await saveTrack(trackKey, `Mixed Track ${index}`, ground);
            stages.push({ trackKey, laps: 1, requiredMedals: index });
        }
        await reload();
        await series.saveStoredSeries('mixed-v1', { name: 'Mixed', ground: 'tarmac', stages }, { username: 'ModOne' });
        const published = await series.publishStoredSeries('mixed-v1', { username: 'ModOne' });
        expect(published).toMatchObject({ grounds, publishedStageCount: stages.length });
        for (const stage of stages) {
            expect(await tracks.readStoredTrack(stage.trackKey)).toMatchObject({ lockReason: 'series' });
        }
        await reload();
        expect(getCampaignSeries('mixed-v1').grounds).toEqual(grounds);
        const current = await tracks.readStoredTrack('mixedTrack0');
        await expect(tracks.saveStoredTrack('mixedTrack0', {
            track: { ...smallSteps, name: 'Changed', ground: 'dirt' }, medalRow,
        }, { username: 'ModOne', baseRevision: current.revision })).rejects.toThrow('locked');
        await expect(series.saveStoredSeries('mixed-v1', {
            name: 'Mixed', ground: 'tarmac',
            stages: [...stages].reverse().map((stage, index) => ({ ...stage, requiredMedals: index })),
        }, { username: 'ModOne', baseRevision: published.revision })).rejects.toThrow('fixed');
    });

    it('keeps an unpublished tail on another surface out of the published summary until it goes live', async () => {
        await series.saveStoredSeries('night-v1', draft, { username: 'ModOne' });
        const published = await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        await saveTrack('dirtNight', 'Dirt Night', 'dirt');
        await reload();
        const appended = await series.saveStoredSeries('night-v1', {
            ...draft, grounds: ['dirt'],
            stages: [...draft.stages, { trackKey: 'dirtNight', laps: 1, requiredMedals: 3 }],
        }, { username: 'ModOne', baseRevision: published.revision });
        expect(appended).toMatchObject({ grounds: ['tarmac'], publishedStageCount: 2 });
        await reload();
        expect(getCampaignSeries('night-v1')).toMatchObject({ live: true, grounds: ['tarmac'] });
        expect(getCampaignSeries('night-v1').stages).toHaveLength(2);
        expect((await tracks.readStoredTrack('dirtNight')).lockedAt).toBeNull();
        const extended = await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        expect(extended).toMatchObject({ grounds: ['tarmac', 'dirt'], publishedStageCount: 3 });
        expect((await tracks.readStoredTrack('dirtNight')).lockReason).toBe('series');
    });

    it('allows an assigned editable stage to change surface and publishes its current surface', async () => {
        await series.saveStoredSeries('night-v1', draft, { username: 'ModOne' });
        const current = await tracks.readStoredTrack('nightOne');
        await tracks.saveStoredTrack('nightOne', {
            track: { ...smallSteps, name: 'Night One', ground: 'dirt' }, medalRow,
        }, { username: 'ModOne', baseRevision: current.revision });
        expect(await series.publishStoredSeries('night-v1', { username: 'ModOne' }))
            .toMatchObject({ grounds: ['dirt', 'tarmac'] });
    });

    it('keeps a mixed publication and its track freezes uncommitted when EXEC loses ownership', async () => {
        await saveTrack('dirtNight', 'Dirt Night', 'dirt');
        await reload();
        await series.saveStoredSeries('mixed-v1', {
            ...draft, finalStageId: 'mixed-v1-01', stages: [draft.stages[0], { trackKey: 'dirtNight', laps: 1, requiredMedals: 1 }],
        }, { username: 'ModOne' });
        const watch = mockRedis.watch.getMockImplementation();
        mockRedis.watch.mockImplementation(async (...keys) => {
            const transaction = await watch(...keys);
            const exec = transaction.exec.getMockImplementation();
            transaction.exec.mockImplementation(async () => transaction.commands.some(([method, args]) => (
                method === 'set' && args[0] === 'dailygp:campaign:series:v1:series:mixed-v1'
                && JSON.parse(args[1]).status === 'published'
            )) ? [] : exec());
            return transaction;
        });
        await expect(series.publishStoredSeries('mixed-v1', { username: 'ModOne' })).rejects.toThrow('Retry');
        expect(await series.readStoredSeries('mixed-v1')).toMatchObject({ status: 'draft', publishedStageCount: 0, publishedFinalStageId: null });
        expect((await series.readStoredSeries('mixed-v1')).grounds).toBeUndefined();
        expect((await tracks.readStoredTrack('nightOne')).lockedAt).toBeNull();
        expect((await tracks.readStoredTrack('dirtNight')).lockedAt).toBeNull();
    });

    it('keeps an older homogeneous record usable without rewriting its surface metadata', async () => {
        await series.saveStoredSeries('night-v1', draft, { username: 'ModOne' });
        const published = await series.publishStoredSeries('night-v1', { username: 'ModOne' });
        const key = 'dailygp:campaign:series:v1:series:night-v1';
        const oldRecord = JSON.parse(strings.get(key));
        delete oldRecord.grounds;
        strings.set(key, JSON.stringify(oldRecord));
        const appended = await series.saveStoredSeries('night-v1', {
            ...draft,
            stages: [...draft.stages, { trackKey: 'nightThree', laps: 1, requiredMedals: 3 }],
        }, { username: 'ModOne', baseRevision: published.revision });
        expect(appended.grounds).toBeUndefined();
        await reload();
        expect(getCampaignSeries('night-v1')).toMatchObject({ live: true, grounds: ['tarmac'] });
        expect(getCampaignSeries('night-v1').stages).toHaveLength(2);
    });
});
