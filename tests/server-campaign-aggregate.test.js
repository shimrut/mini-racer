import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';
import { getCampaignSeriesStages, getCampaignFinalStage } from '../game/campaign/manifest.js';
import { clearStoredSeriesForTests, registerStoredSeries } from '../game/campaign/stored-series.js';
import { campaignProgressKey } from '../src/server/campaign/campaign-progress-key.js';

const redis = new RedisTestDouble();
const profiles = new Map();
vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));
vi.mock('../src/server/redis/shared-cache.js', () => ({ cacheSharedJson: (source) => source() }));
vi.mock('../src/server/moderator/analytics-store.js', () => ({ recordAnalyticsRaceBestEffort: () => {} }));
vi.mock('../src/server/competition/competition-identity.js', async (importOriginal) => ({
    ...await importOriginal(),
    resolveAuthorizedPlayerIdentity: async ({ redditUsername, guestToken }) => ({
        canonicalPlayerId: redditUsername ? `reddit:${redditUsername.toLowerCase()}` : guestToken === 'valid-guest' ? 'guest:self' : null,
        guestStatus: 'active',
    }),
    readPlayerProfileMap: async (playerIds) => new Map(playerIds.map((id) => [id, profiles.get(id)]).filter(([, profile]) => profile)),
}));
vi.mock('../src/server/competition/competition-submit.js', async (importOriginal) => ({
    ...await importOriginal(),
    submitCompetitionRun: async ({ competition, playerId, replay }) => {
        await redis.hSet(competition.entryHashKey, { [playerId]: JSON.stringify({
            playerId, trackKey: competition.trackKey, bestTimeMs: replay.timeMs,
            updatedAt: new Date().toISOString(), completedLaps: competition.lapCount, validationMethod: 'strict-replay',
        }) });
        return { status: 200, body: { accepted: true, improved: true, bestTimeMs: replay.timeMs, checkpointTimesSec: null }, releaseLock: Promise.resolve() };
    },
}));

const {
    getServerCampaignAggregate, submitServerCampaignRun, getServerCampaignBootstrap,
    mergeGuestCampaignProgress, cleanupGuestCampaignProgress, cleanupExpiredCampaignGuests,
    runCampaignAggregateFills, CAMPAIGN_GUEST_EXPIRY_KEY,
} = await import('../src/server/campaign/campaign-store.ts');
const { toCampaignCompetition } = await import('../src/server/competition/competition.ts');
const { campaignAggregateKeys, runCampaignAggregateFill, readCampaignAggregateSnapshot } = await import('../src/server/campaign/campaign-aggregate-store.ts');
const { guestProgressSelectionAccountPendingKey, guestProgressSelectionPendingKey } = await import('../src/server/player/guest-retirement.js');
const { guestPromotionKey } = await import('../src/server/player/car-unlock-store.js');

const SERIES_ID = 'numbered-v1';
const stages = getCampaignSeriesStages(SERIES_ID);
const finalStage = getCampaignFinalStage(SERIES_ID);
const keys = campaignAggregateKeys(SERIES_ID);
const NOW_MS = Date.parse('2026-10-05T12:00:00.000Z');

function completeResults(timeMs = 12_000, seriesStages = stages) {
    return Object.fromEntries(seriesStages.map((stage) => [stage.raceId, {
        raceId: stage.raceId, trackKey: stage.trackKey, lapCount: stage.lapCount, rulesRevision: stage.rulesRevision,
        bestTimeMs: timeMs, medal: 'gold', checkpointTimesSec: null, updatedAt: new Date(NOW_MS).toISOString(),
    }]));
}

async function seedProgress(playerId, results = completeResults(), seriesId = SERIES_ID) {
    await redis.set(campaignProgressKey(playerId, seriesId), JSON.stringify({
        campaignId: seriesId, startedAt: new Date(NOW_MS).toISOString(), resultsByRaceId: results,
        updatedAt: new Date(NOW_MS).toISOString(),
    }));
}

async function seedEntry(playerId, stage, timeMs = 12_000, overrides = {}) {
    await redis.hSet(toCampaignCompetition(stage.seriesId, stage).entryHashKey, { [playerId]: JSON.stringify({
        playerId, trackKey: stage.trackKey, bestTimeMs: timeMs, updatedAt: new Date(NOW_MS).toISOString(), ...overrides,
    }) });
}

async function makeFillImmediatelyRunnable() {
    await redis.set(keys.fillState, JSON.stringify({ finalStageId: finalStage.raceId, cursor: 0, scanned: false, pending: [] }));
}

async function aggregate(username = 'Self', overrides = {}) {
    return getServerCampaignAggregate({ seriesId: SERIES_ID, redditUsername: username, ...overrides });
}

describe('Campaign aggregate ownership and recovery', () => {
    beforeEach(() => {
        redis.reset();
        profiles.clear();
        clearStoredSeriesForTests();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); clearStoredSeriesForTests(); });

    it('requires authorized identity and a complete fixed Campaign before exposing any board', async () => {
        expect(await aggregate(null, { playerId: 'reddit:spoofed' })).toMatchObject({ status: 401 });
        expect(await aggregate()).toMatchObject({ status: 403, body: { reason: 'campaign_unfinished' } });
        expect(await aggregate('Self', { seriesId: 'unpublished' })).toMatchObject({ status: 404 });
        const missing = completeResults();
        delete missing[stages[3].raceId];
        await seedProgress('reddit:self', missing);
        expect(await aggregate()).toMatchObject({ status: 403 });
        expect(await redis.zCard(keys.leaderboard)).toBe(0);
    });

    it('adopts saved complete progress, ranks total milliseconds once, and reuses public names', async () => {
        await seedProgress('reddit:self');
        await redis.set(keys.fillReady, finalStage.raceId);
        profiles.set('reddit:self', { leaderboardIdentity: 'reddit', redditUsername: 'Self' });
        const answer = await aggregate('Self', { limit: 100, offset: -3, totalTimeMs: 1 });
        expect(answer).toMatchObject({ status: 200, body: {
            seriesId: SERIES_ID, finalStageId: finalStage.raceId, totalTimeMs: stages.length * 12_000,
            ready: true, totalCount: 1, playerRank: 1, playerRankLabel: '#1', pageOffset: 0, pageLimit: 50,
            currentPlayerRow: { displayName: 'Self', bestTimeMs: stages.length * 12_000, completedLaps: null,
                checkpointTimesSec: null, opponentRaceAvailable: false, isCurrentPlayer: true },
        } });
        expect(JSON.stringify(answer.body)).not.toContain('reddit:self');
    });

    it('returns a place on the first request for a new sealed three-stage Creator Campaign', async () => {
        const seriesId = 'creator-v1';
        registerStoredSeries([{
            id: seriesId, name: 'Creator', ground: 'tarmac', finalStageId: `${seriesId}-02`,
            stages: stages.slice(0, 3).map((stage) => ({
                trackKey: stage.trackKey, laps: stage.lapCount, requiredMedals: 0,
            })),
        }]);
        const creatorStages = getCampaignSeriesStages(seriesId);
        const creatorKeys = campaignAggregateKeys(seriesId);
        await seedProgress('reddit:self', completeResults(12_000, creatorStages), seriesId);
        for (const stage of creatorStages) await seedEntry('reddit:historic', stage, 10_000);
        expect(await redis.get(creatorKeys.fillReady)).toBeUndefined();
        const answer = await aggregate('Self', { seriesId });
        expect(answer).toMatchObject({ status: 200, body: {
            seriesId, finalStageId: `${seriesId}-02`, ready: true,
            totalTimeMs: 36_000, playerRank: 2, totalCount: 2,
        } });
        expect(answer.body.topRows.map((row) => row.bestTimeMs)).toEqual([30_000, 36_000]);
        expect(await redis.get(creatorKeys.fillReady)).toBe(`${seriesId}-02`);
    });

    it('unblocks existing boards whose inventory was saved behind the obsolete ten-minute delay', async () => {
        await seedProgress('reddit:self');
        await redis.set(keys.fillState, JSON.stringify({
            finalStageId: finalStage.raceId, notBeforeMs: Date.now() + 600_000,
            cursor: 0, scanned: false, pending: [], queued: [],
        }));
        for (const stage of stages) await seedEntry('reddit:historic', stage, 10_000);
        const answer = await aggregate();
        expect(answer).toMatchObject({ status: 200, body: { ready: true, playerRank: 2, totalCount: 2 } });
        expect(await redis.get(keys.fillState)).toBeUndefined();
        expect(await redis.get(keys.fillReady)).toBe(finalStage.raceId);
    });

    it('keeps totals usable while suppressing all places until the historic inventory is complete', async () => {
        await seedProgress('reddit:self');
        await redis.zAdd(keys.leaderboard, { member: 'reddit:rival', score: 1_000 });
        for (let index = 0; index < 11; index++) await seedEntry(`reddit:historic-${index}`, finalStage);
        const answer = await aggregate();
        expect(answer).toMatchObject({ status: 200, body: {
            ready: false, totalTimeMs: stages.length * 12_000, playerRank: null, playerRankLabel: null,
            topRows: [], nearbyRows: [], currentPlayerRow: null, totalCount: 0, hasMore: false,
        } });
    });

    it('reconciles a faster accepted legacy entry against an already present progress PB', async () => {
        await seedProgress('reddit:self');
        await redis.set(keys.fillReady, finalStage.raceId);
        await seedEntry('reddit:self', stages[0], 8_000); // Supported early entries omit lap/validation labels.
        const answer = await aggregate();
        expect(answer.body.totalTimeMs).toBe(stages.length * 12_000 - 4_000);
        const saved = JSON.parse(await redis.get(campaignProgressKey('reddit:self', SERIES_ID)));
        expect(saved.resultsByRaceId[stages[0].raceId]).toMatchObject({ bestTimeMs: 8_000, lapCount: stages[0].lapCount });
        expect(await redis.zScore(keys.leaderboard, 'reddit:self')).toBe(answer.body.totalTimeMs);
    });

    it('repairs a missing derived row on a no-op accepted retry without changing saved source progress', async () => {
        await seedProgress('reddit:self');
        const before = await redis.get(campaignProgressKey('reddit:self', SERIES_ID));
        const response = await submitServerCampaignRun({
            raceId: stages[0].raceId, trackKey: stages[0].trackKey, replay: { timeMs: 12_000 }, redditUsername: 'Self',
        });
        expect(response.status).toBe(200);
        expect(await redis.get(campaignProgressKey('reddit:self', SERIES_ID))).toBe(before);
        expect(await redis.zScore(keys.leaderboard, 'reddit:self')).toBe(stages.length * 12_000);
    });

    it('recovers an accepted stage PB after its source-progress transaction is interrupted', async () => {
        await seedProgress('reddit:self');
        await redis.set(keys.fillReady, finalStage.raceId);
        redis.setBeforeExec((watchedKeys) => {
            if (watchedKeys.some((key) => key.includes(':progress-lock:')) && watchedKeys.length > 1) {
                redis.touch(watchedKeys[0]);
                redis.setBeforeExec(null);
            }
        });
        const rejected = await submitServerCampaignRun({
            raceId: stages[0].raceId, trackKey: stages[0].trackKey, replay: { timeMs: 8_000 }, redditUsername: 'Self',
        });
        expect(rejected).toMatchObject({ status: 503, body: { accepted: false } });
        expect(JSON.parse(await redis.get(campaignProgressKey('reddit:self', SERIES_ID))).resultsByRaceId[stages[0].raceId].bestTimeMs).toBe(12_000);
        expect((await aggregate()).body.totalTimeMs).toBe(stages.length * 12_000 - 4_000);
    });

    it('serializes different-stage PB improvements and preserves both in the derived total', async () => {
        await seedProgress('reddit:self');
        const replies = await Promise.all(stages.slice(0, 2).map((stage, index) => submitServerCampaignRun({
            raceId: stage.raceId, trackKey: stage.trackKey, replay: { timeMs: 8_000 + index * 1_000 }, redditUsername: 'Self',
        })));
        expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
        expect(await redis.zScore(keys.leaderboard, 'reddit:self')).toBe(stages.length * 12_000 - 7_000);
    });

    it('fences guest/account transfers before exposing totals or performing a derived repair', async () => {
        await seedProgress('reddit:self');
        await redis.set(guestProgressSelectionAccountPendingKey('reddit:self'), 'selection');
        expect(await aggregate()).toMatchObject({ status: 503, body: { reason: 'progress_transfer_pending' } });
        expect(await redis.zCard(keys.leaderboard)).toBe(0);
        await seedProgress('guest:self');
        await redis.set(guestProgressSelectionPendingKey('guest:self'), 'selection');
        expect(await aggregate(null, { guestToken: 'valid-guest' })).toMatchObject({ status: 503, body: { reason: 'progress_transfer_pending' } });
    });

    it('updates the account total from merged per-stage PBs and removes the guest on cleanup', async () => {
        await seedProgress('reddit:self');
        await seedProgress('guest:source', completeResults(10_000));
        await redis.zAdd(keys.leaderboard, { member: 'guest:source', score: stages.length * 10_000 });
        await mergeGuestCampaignProgress({ guestPlayerId: 'guest:source', redditPlayerId: 'reddit:self' });
        expect(await redis.zScore(keys.leaderboard, 'reddit:self')).toBe(stages.length * 10_000);
        await cleanupGuestCampaignProgress({ guestPlayerId: 'guest:source' });
        expect(await redis.zScore(keys.leaderboard, 'guest:source')).toBeUndefined();
        expect(await redis.zScore(keys.leaderboard, 'reddit:self')).toBe(stages.length * 10_000);
    });

    it('removes an expired guest from the aggregate together with its Campaign source rows', async () => {
        await seedProgress('guest:expired');
        await redis.zAdd(keys.leaderboard, { member: 'guest:expired', score: 1_000 });
        await redis.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, { member: 'guest:expired', score: Date.now() - 1 });
        expect(await cleanupExpiredCampaignGuests()).toBe(1);
        expect(await redis.zScore(keys.leaderboard, 'guest:expired')).toBeUndefined();
        expect(await redis.get(campaignProgressKey('guest:expired', SERIES_ID))).toBeUndefined();
    });

    it('backfills retained final-stage entries without requiring a stage rank or a historic screen visit', async () => {
        await makeFillImmediatelyRunnable();
        for (let index = 0; index < 21; index++) {
            const playerId = `reddit:historic-${index}`;
            for (const stage of stages) await seedEntry(playerId, stage, 10_000 + index);
        }
        await seedEntry('reddit:incomplete', finalStage);
        const pending = guestProgressSelectionAccountPendingKey('reddit:historic-0');
        await redis.set(pending, 'transfer');
        await runCampaignAggregateFills();
        expect(await redis.get(keys.fillReady)).toBeUndefined();
        expect(await redis.zCard(keys.leaderboard)).toBe(9);
        await runCampaignAggregateFills();
        await runCampaignAggregateFills();
        await runCampaignAggregateFills();
        expect(await redis.zScore(keys.leaderboard, 'reddit:historic-20')).toBe(stages.length * 10_020);
        expect(await redis.zCard(keys.leaderboard)).toBe(20);
        expect(await redis.get(keys.fillReady)).toBeUndefined();
        await redis.del(pending);
        await runCampaignAggregateFills();
        expect(await redis.get(keys.fillReady)).toBe(finalStage.raceId);
        expect(await redis.zCard(keys.leaderboard)).toBe(21);
        expect(await redis.zScore(keys.leaderboard, 'reddit:incomplete')).toBeUndefined();
        expect(await redis.zCard(toCampaignCompetition(SERIES_ID, finalStage).leaderboardKey)).toBe(0);
    });

    it('never resurrects promoted or expired guests while filling historic entry candidates', async () => {
        await makeFillImmediatelyRunnable();
        for (const playerId of ['guest:promoted', 'guest:expired']) {
            for (const stage of stages) await seedEntry(playerId, stage);
            await redis.zAdd(keys.leaderboard, { member: playerId, score: 1_000 });
        }
        await redis.set(guestPromotionKey('guest:promoted'), 'reddit:self');
        await redis.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, { member: 'guest:expired', score: Date.now() - 1 });
        await runCampaignAggregateFills();
        expect(await redis.get(keys.fillReady)).toBe(finalStage.raceId);
        expect(await redis.zCard(keys.leaderboard)).toBe(0);
        expect(await redis.get(campaignProgressKey('guest:expired', SERIES_ID))).toBeUndefined();
        expect(await redis.get(campaignProgressKey('guest:promoted', SERIES_ID))).toBeUndefined();
    });

    it('keeps a guest aggregate when racing refreshes its expiry before the removal lock is acquired', async () => {
        await makeFillImmediatelyRunnable();
        await seedProgress('guest:active');
        await seedEntry('guest:active', finalStage);
        await redis.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, { member: 'guest:active', score: Date.now() - 1 });
        await redis.zAdd(keys.leaderboard, { member: 'guest:active', score: stages.length * 12_000 });
        const sourceSet = redis.set.bind(redis);
        let refreshed = false;
        let acquiredProgressLocks = 0;
        const set = vi.spyOn(redis, 'set').mockImplementation(async (key, value, options) => {
            if (key.includes(':progress-lock:')) acquiredProgressLocks++;
            if (!refreshed && key.includes(':progress-lock:') && acquiredProgressLocks === 2) {
                refreshed = true;
                await redis.zAdd(CAMPAIGN_GUEST_EXPIRY_KEY, { member: 'guest:active', score: Date.now() + 60_000 });
            }
            return sourceSet(key, value, options);
        });
        await runCampaignAggregateFills();
        expect(refreshed).toBe(true);
        expect(await redis.zScore(keys.leaderboard, 'guest:active')).toBe(stages.length * 12_000);
        expect(await redis.get(keys.fillReady)).toBeUndefined();
        set.mockRestore();
        await runCampaignAggregateFills();
        expect(await redis.get(keys.fillReady)).toBe(finalStage.raceId);
        expect(await redis.zScore(keys.leaderboard, 'guest:active')).toBe(stages.length * 12_000);
    });

    it('does not overwrite a fresh retention update with inferred older final-stage evidence', async () => {
        await makeFillImmediatelyRunnable();
        const oldResults = completeResults();
        for (const row of Object.values(oldResults)) row.updatedAt = '2024-01-01T00:00:00.000Z';
        await seedProgress('guest:active', oldResults);
        const saved = JSON.parse(await redis.get(campaignProgressKey('guest:active', SERIES_ID)));
        saved.updatedAt = '2024-01-01T00:00:00.000Z';
        await redis.set(campaignProgressKey('guest:active', SERIES_ID), JSON.stringify(saved));
        await seedEntry('guest:active', finalStage, 12_000, { updatedAt: '2024-01-01T00:00:00.000Z' });
        const sourceScore = redis.zScore.bind(redis);
        const freshExpiry = Date.now() + 60_000;
        let refreshed = false;
        const score = vi.spyOn(redis, 'zScore').mockImplementation(async (key, playerId) => {
            const observed = await sourceScore(key, playerId);
            if (!refreshed && key === CAMPAIGN_GUEST_EXPIRY_KEY && playerId === 'guest:active' && observed === undefined) {
                refreshed = true;
                await redis.zAdd(key, { member: playerId, score: freshExpiry });
                redis.touch(key); // A different series' concurrent activity invalidates WATCH.
            }
            return observed;
        });
        await runCampaignAggregateFills();
        expect(refreshed).toBe(true);
        expect(await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, 'guest:active')).toBe(freshExpiry);
        expect(await redis.get(keys.fillReady)).toBeUndefined();
        score.mockRestore();
        await runCampaignAggregateFills();
        expect(await redis.get(keys.fillReady)).toBe(finalStage.raceId);
        expect(await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, 'guest:active')).toBe(freshExpiry);
        expect(await redis.zScore(keys.leaderboard, 'guest:active')).toBe(stages.length * 12_000);
    });

    it('finishes inventory when a retired guest already has no aggregate member', async () => {
        await makeFillImmediatelyRunnable();
        await seedEntry('guest:promoted', finalStage);
        await redis.set(guestPromotionKey('guest:promoted'), 'reddit:self');
        await runCampaignAggregateFills();
        expect(await redis.get(keys.fillReady)).toBe(finalStage.raceId);
        expect(await redis.zCard(keys.leaderboard)).toBe(0);
    });

    it('keeps ranking repair behind the transfer fence even if transfer begins immediately before EXEC', async () => {
        await seedProgress('reddit:self');
        const pendingKey = guestProgressSelectionAccountPendingKey('reddit:self');
        redis.setBeforeExec((watchedKeys) => {
            if (watchedKeys.includes(pendingKey)) {
                redis.strings.set(pendingKey, 'transfer');
                redis.touch(pendingKey);
                redis.setBeforeExec(null);
            }
        });
        expect(await aggregate()).toMatchObject({ status: 503 });
        expect(await redis.zScore(keys.leaderboard, 'reddit:self')).toBeUndefined();
    });
});

describe('Campaign aggregate page and bounded fill', () => {
    beforeEach(() => { redis.reset(); profiles.clear(); });

    it('stops at the shared deadline and gives the cut players back to the next tick', async () => {
        for (let index = 0; index < 25; index++) await seedEntry(`reddit:player-${index}`, finalStage);
        let now = Date.now();
        const deadline = now + 10_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const seen = [];
        const reconcile = vi.fn(async (playerId) => {
            seen.push(playerId);
            // The third player uses up the request's time.
            if (seen.length === 3) now = deadline;
            return true;
        });
        try {
            expect(await runCampaignAggregateFill(SERIES_ID, reconcile, deadline)).toBe(false);
            expect(reconcile).toHaveBeenCalledTimes(3);
            now = deadline + 60_000;
            while (!await runCampaignAggregateFill(SERIES_ID, reconcile));
        } finally {
            vi.restoreAllMocks();
        }
        expect(seen).toHaveLength(25);
        expect(new Set(seen).size).toBe(25);
    });

    it('scans immediately in bounded pages and stops scanning when ready', async () => {
        const reconcile = vi.fn(async () => true);
        for (let index = 0; index < 25; index++) await seedEntry(`reddit:player-${index}`, finalStage);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(false);
        expect(reconcile).toHaveBeenCalledTimes(10);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(false);
        expect(reconcile).toHaveBeenCalledTimes(20);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(true);
        expect(reconcile).toHaveBeenCalledTimes(25);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(true);
        expect(reconcile).toHaveBeenCalledTimes(25);
    });

    it('becomes ready for an empty board on its first inventory request', async () => {
        expect(await runCampaignAggregateFill(SERIES_ID, async () => true)).toBe(true);
        expect(await redis.get(keys.fillReady)).toBe(finalStage.raceId);
    });

    it('holds HSCAN overflow in a saved queue and enforces the hard candidate budget', async () => {
        await makeFillImmediatelyRunnable();
        for (let index = 0; index < 31; index++) await seedEntry(`reddit:player-${index}`, finalStage);
        const sourceScan = redis.hScan.bind(redis);
        const scan = vi.spyOn(redis, 'hScan').mockImplementation((key, cursor) => sourceScan(key, cursor, undefined, 100));
        const reconcile = vi.fn(async () => true);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(false);
        expect(reconcile).toHaveBeenCalledTimes(10);
        expect(JSON.parse(await redis.get(keys.fillState)).queued).toHaveLength(21);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(false);
        expect(reconcile).toHaveBeenCalledTimes(20);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(false);
        expect(reconcile).toHaveBeenCalledTimes(30);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(true);
        expect(reconcile).toHaveBeenCalledTimes(31);
        expect(scan).toHaveBeenCalledTimes(1);
        scan.mockRestore();
    });

    it('resumes the saved cursor and retries immediately despite an obsolete rollout delay', async () => {
        const reconcile = vi.fn(async () => true);
        await redis.set(keys.fillState, JSON.stringify({
            finalStageId: finalStage.raceId, notBeforeMs: Date.now() + 600_000,
            cursor: 0, scanned: false, pending: ['reddit:busy'], queued: [],
        }));
        await seedEntry('reddit:old-request', finalStage);
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(true);
        expect(reconcile.mock.calls).toEqual([['reddit:busy'], ['reddit:old-request']]);
    });

    it('does not acknowledge scan progress after losing fill-lock ownership', async () => {
        await makeFillImmediatelyRunnable();
        await seedEntry('reddit:historic', finalStage);
        const reconcile = vi.fn(async () => { await redis.set(keys.fillLock, 'another-owner'); return true; });
        expect(await runCampaignAggregateFill(SERIES_ID, reconcile)).toBe(false);
        expect(await redis.get(keys.fillReady)).toBeUndefined();
        expect(JSON.parse(await redis.get(keys.fillState)).scanned).toBe(false);
        expect(await redis.get(keys.fillLock)).toBe('another-owner');
        await redis.del(keys.fillLock);
        expect(await runCampaignAggregateFill(SERIES_ID, async () => true)).toBe(true);
    });

    it('reuses positional places and nearby rows without single-stage racing controls', async () => {
        for (let index = 0; index < 20; index++) {
            const playerId = `reddit:player-${String(index).padStart(2, '0')}`;
            await redis.zAdd(keys.leaderboard, { member: playerId, score: 100_000 + Math.floor(index / 2) });
            profiles.set(playerId, { leaderboardIdentity: 'reddit', redditUsername: `Player ${index}` });
        }
        const snapshot = await readCampaignAggregateSnapshot({
            seriesId: SERIES_ID, playerId: 'reddit:player-14', totalTimeMs: 120_000, limit: 5, offset: 5, ready: true,
        });
        expect(snapshot).toMatchObject({ playerRank: 15, totalCount: 20, pageOffset: 5, pageLimit: 5, hasMore: true, nextOffset: 10 });
        expect(snapshot.topRows.map((row) => row.rank)).toEqual([6, 7, 8, 9, 10]);
        expect(snapshot.nearbyRows.find((row) => row.isCurrentPlayer)).toMatchObject({ rank: 15, displayName: 'Player 14' });
        expect(snapshot.topRows.every((row) => row.opponentRaceAvailable === false && row.completedLaps === null)).toBe(true);
        expect(snapshot.currentPlayerRow.bestTimeMs).toBe(100_007);
        expect(snapshot.totalTimeMs).toBe(100_007);
    });
});
