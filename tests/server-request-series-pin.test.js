import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';

const redis = new RedisTestDouble();
const mockContext = { subredditId: 't5_pin' };

vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));
vi.mock('@devvit/web/server', () => ({ redis, context: mockContext }));

const seriesStore = await import('../src/server/campaign/series-store.ts');
const { CAMPAIGN_SERIES } = await import('../game/campaign/manifest.js');
const { setStoredSeriesResolver } = await import('../game/campaign/stored-series.js');
const {
    getServerCampaignBootstrap,
    mergeGuestCampaignProgress,
} = await import('../src/server/campaign/campaign-store.ts');
const { campaignProgressKey } = await import('../src/server/campaign/campaign-progress-key.js');
const { toCampaignCompetition } = await import('../src/server/competition/competition.ts');
const { getCampaignStage } = await import('../game/campaign/manifest.js');

// One-stage series on a built-in track. The order of the list is the order
// that the published snapshot gives.
function definition(id, trackKey) {
    return Object.freeze({
        id,
        name: id,
        ground: 'tarmac',
        stages: [{ trackKey, laps: 1, requiredMedals: 0 }],
    });
}

const NIGHT = definition('night-v1', 'babylonRace');
const DAWN = definition('dawn-v1', 'smallSteps');

function publish(revision, definitions) {
    seriesStore.publishStoredSeriesSnapshot('t5_pin', {
        revision: String(revision),
        published: Object.freeze([...definitions]),
    });
}

function ids() {
    return CAMPAIGN_SERIES.map((series) => series.id);
}

function result(raceId, trackKey, bestTimeMs) {
    return {
        raceId,
        trackKey,
        lapCount: 1,
        rulesRevision: 1,
        bestTimeMs,
        medal: 'gold',
        checkpointTimesSec: null,
        updatedAt: '2026-09-30T10:00:00.000Z',
    };
}

beforeEach(() => {
    redis.reset();
    seriesStore.clearStoredSeriesCacheForTests();
    seriesStore.installStoredSeriesResolver();
});

afterEach(() => {
    delete redis.get;
    redis.beforeExec = null;
});

afterAll(() => setStoredSeriesResolver(null));

describe('one series list for each request', () => {
    it('keeps each request on its own list when only one request takes the newer list', async () => {
        publish(1, [NIGHT]);
        let releaseFirst;
        const firstWaits = new Promise((resolve) => { releaseFirst = resolve; });

        const first = seriesStore.runWithPinnedStoredSeries(async () => {
            const before = ids();
            await firstWaits;
            return { before, after: ids() };
        });
        const second = seriesStore.runWithPinnedStoredSeries(async () => {
            await Promise.resolve();
            publish(2, [NIGHT, DAWN]);
            const beforeRepin = ids();
            seriesStore.repinStoredSeries();
            const afterRepin = ids();
            releaseFirst();
            await Promise.resolve();
            return { beforeRepin, afterRepin, later: ids() };
        });

        expect(await first).toEqual({
            before: ['numbered-v1', 'night-v1'],
            after: ['numbered-v1', 'night-v1'],
        });
        expect(await second).toEqual({
            beforeRepin: ['numbered-v1', 'night-v1'],
            afterRepin: ['numbered-v1', 'night-v1', 'dawn-v1'],
            later: ['numbered-v1', 'night-v1', 'dawn-v1'],
        });
        // Outside a request, the list is the cache.
        expect(ids()).toEqual(['numbered-v1', 'night-v1', 'dawn-v1']);
    });

    it('gives a request that starts after a change the newer list, and the older request keeps its own', async () => {
        publish(1, [NIGHT]);
        let releaseFirst;
        const firstWaits = new Promise((resolve) => { releaseFirst = resolve; });
        const first = seriesStore.runWithPinnedStoredSeries(async () => {
            await firstWaits;
            return ids();
        });

        publish(2, [NIGHT, DAWN]);
        const second = await seriesStore.runWithPinnedStoredSeries(async () => {
            await Promise.resolve();
            return ids();
        });
        releaseFirst();

        expect(await first).toEqual(['numbered-v1', 'night-v1']);
        expect(second).toEqual(['numbered-v1', 'night-v1', 'dawn-v1']);
    });

    it('answers a Campaign load from one list when a series goes in front during the load', async () => {
        publish(1, [NIGHT]);
        const playerId = 'reddit:pinracer';
        const nightKey = campaignProgressKey(playerId, 'night-v1');
        await redis.set(nightKey, JSON.stringify({
            campaignId: 'night-v1',
            startedAt: '2026-09-01T00:00:00.000Z',
            resultsByRaceId: { 'night-v1-00': result('night-v1-00', 'babylonRace', 9000) },
            updatedAt: '2026-09-30T10:00:00.000Z',
        }));
        let published = false;
        const realGet = RedisTestDouble.prototype.get;
        redis.get = async function publishInFront(key) {
            const value = await realGet.call(this, key);
            if (key === nightKey && !published) {
                published = true;
                // Another request publishes a series that goes in front of Night.
                publish(2, [DAWN, NIGHT]);
            }
            return value;
        };

        const loaded = await seriesStore.runWithPinnedStoredSeries(() => getServerCampaignBootstrap({
            redditUsername: 'PinRacer',
            seriesId: 'night-v1',
        }));

        expect(published).toBe(true);
        expect(loaded.status).toBe(200);
        expect(loaded.body.campaignId).toBe('night-v1');
        expect(Object.keys(loaded.body.progress.resultsByRaceId)).toEqual(['night-v1-00']);
        expect(loaded.body.series.map((series) => series.id)).toEqual(['numbered-v1', 'night-v1']);
        expect(loaded.body.series.find((series) => series.id === 'night-v1').medalCount).toBeGreaterThan(0);
    });

    it('completes a transfer when a series is published after the stage copies start', async () => {
        publish(1, [NIGHT]);
        const guestPlayerId = 'guest:pin-merge';
        const redditPlayerId = 'reddit:pin-merge';
        await redis.set(campaignProgressKey(guestPlayerId, 'night-v1'), JSON.stringify({
            campaignId: 'night-v1',
            startedAt: '2026-09-01T00:00:00.000Z',
            resultsByRaceId: { 'night-v1-00': result('night-v1-00', 'babylonRace', 9000) },
            updatedAt: '2026-09-30T10:00:00.000Z',
        }));
        const stage = getCampaignStage('numbered-v1-00');
        const board = toCampaignCompetition('numbered-v1', stage, { playerId: guestPlayerId });
        await redis.hSet(board.entryHashKey, {
            [guestPlayerId]: JSON.stringify({
                playerId: guestPlayerId,
                displayName: 'Guest racer',
                bestTimeMs: 31234,
                trackKey: stage.trackKey,
                completedLaps: stage.lapCount,
                validationMethod: 'strict-replay',
                updatedAt: new Date().toISOString(),
            }),
        });
        await redis.zAdd(board.leaderboardKey, { member: guestPlayerId, score: 31234 });
        redis.beforeExec = () => {
            redis.beforeExec = null;
            publish(2, [NIGHT, DAWN]);
        };

        const merged = await seriesStore.runWithPinnedStoredSeries(() => mergeGuestCampaignProgress({
            guestPlayerId,
            redditPlayerId,
        }));

        expect(merged.merged).toBe(true);
        expect(JSON.parse(await redis.get(campaignProgressKey(redditPlayerId, 'night-v1'))).resultsByRaceId)
            .toHaveProperty('night-v1-00');
        expect(JSON.parse(await redis.get(campaignProgressKey(redditPlayerId))).resultsByRaceId)
            .toHaveProperty('numbered-v1-00');
    });
});
