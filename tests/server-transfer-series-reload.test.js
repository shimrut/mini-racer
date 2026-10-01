import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RedisTestDouble } from './redis-test-double.js';

const redis = new RedisTestDouble();
const mockContext = vi.hoisted(() => ({ subredditId: 't5_reload' }));

vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));
vi.mock('@devvit/web/server', async (importOriginal) => ({
    ...(await importOriginal()),
    redis,
    context: mockContext,
}));

const { getServerDailyGpChallenge, selectGuestProgress } = await import('../src/server/daily/daily-gp-store.ts');
const seriesStore = await import('../src/server/campaign/series-store.ts');
const trackStore = await import('../src/server/tracks/track-store.ts');
const { setStoredSeriesResolver } = await import('../game/campaign/stored-series.js');
const { getCampaignStage } = await import('../game/campaign/manifest.js');
const { campaignProgressKey } = await import('../src/server/campaign/campaign-progress-key.js');
const { toCampaignCompetition } = await import('../src/server/competition/competition.ts');
const { racedListKey } = await import('../src/server/player/raced-list.ts');
const { RACED_LIST_FILL_READY_KEY } = await import('../src/server/player/raced-list-fill.ts');
const { carUnlockHashKey } = await import('../src/server/player/car-unlock-store.ts');
const { recordCompletedRace } = await import('../src/server/player/car-unlock-store.ts');

const NIGHT_STAGE = { raceId: 'night-v1-00', trackKey: 'babylonRace', lapCount: 1, rulesRevision: 1 };
const SERIES_PREFIX = 'dailygp:campaign:series:v1';

function selectionKey(guestPlayerId, redditPlayerId) {
    return `dailygp:guest-progress-selection:v1:${createHash('sha256')
        .update(`${guestPlayerId}:${redditPlayerId}`, 'utf8')
        .digest('base64url')}`;
}

function playerHash(playerId) {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

async function seedSevenDayPlaylist() {
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let dayOffset = 6; dayOffset >= 0; dayOffset -= 1) {
        vi.setSystemTime(new Date(realNow - (dayOffset * 86400000)));
        await getServerDailyGpChallenge();
    }
    vi.setSystemTime(new Date(realNow));
    vi.useRealTimers();
}

// Publishes Night in Redis, the way the Creator does. No server cache has it yet.
async function publishNightInRedis() {
    const now = new Date().toISOString();
    await redis.set(`${SERIES_PREFIX}:series:night-v1`, JSON.stringify({
        version: 1,
        id: 'night-v1',
        name: 'Night Races',
        ground: 'tarmac',
        stages: [{ trackKey: NIGHT_STAGE.trackKey, laps: 1, requiredMedals: 0 }],
        status: 'published',
        publishedStageCount: 1,
        publishedAt: now,
        origin: 'creator',
        revision: 1,
        createdAt: now,
        createdBy: 'ModOne',
        updatedAt: now,
        updatedBy: 'ModOne',
    }));
    await redis.hSet(`${SERIES_PREFIX}:index`, { 'night-v1': '1' });
    await redis.incrBy(seriesStore.STORED_SERIES_REVISION_KEY, 1);
}

async function seedBoardRow(seriesId, stage, playerId, bestTimeMs) {
    const board = toCampaignCompetition(seriesId, stage);
    await redis.hSet(board.entryHashKey, {
        [playerId]: JSON.stringify({
            playerId,
            displayName: 'Racer',
            bestTimeMs,
            trackKey: stage.trackKey,
            completedLaps: stage.lapCount,
            validationMethod: 'strict-replay',
            updatedAt: new Date().toISOString(),
        }),
    });
    await redis.zAdd(board.leaderboardKey, { member: playerId, score: bestTimeMs });
    await redis.hSet(racedListKey(playerId), { [`campaign:${stage.raceId}`]: '1' });
    return board;
}

async function entryOf(board, playerId) {
    const raw = await redis.hGet(board.entryHashKey, playerId);
    return raw ? JSON.parse(raw) : null;
}

// One request: the list is fixed when it starts, as the request middleware does.
function transferRequest(guestPlayerId, redditPlayerId) {
    return seriesStore.runWithPinnedStoredSeries(() => selectGuestProgress({
        guestPlayerId,
        redditPlayerId,
        choice: 'guest',
    }));
}

beforeEach(async () => {
    redis.reset();
    seriesStore.clearStoredSeriesCacheForTests();
    trackStore.clearStoredTrackCacheForTests();
    seriesStore.installStoredSeriesResolver();
    trackStore.installStoredTrackResolver();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedSevenDayPlaylist();
    await redis.set(RACED_LIST_FILL_READY_KEY, JSON.stringify({ completedAt: new Date().toISOString() }));
});

afterEach(() => {
    vi.restoreAllMocks();
    delete redis.mGet;
    delete redis.set;
});

afterAll(() => setStoredSeriesResolver(null));

describe('a transfer loads the series list again after it blocks saving', () => {
    it('moves a guest row on a stage that the request list did not have', async () => {
        const guestPlayerId = 'guest:reload-guest-row';
        const redditPlayerId = 'reddit:reload-guest-row';
        await seedBoardRow('numbered-v1', getCampaignStage('numbered-v1-00'), guestPlayerId, 31234);
        // The request took its list before Night was published, and the guest
        // raced Night before the marks.
        await publishNightInRedis();
        const guestNight = await seedBoardRow('night-v1', NIGHT_STAGE, guestPlayerId, 9000);

        await expect(transferRequest(guestPlayerId, redditPlayerId)).resolves.toMatchObject({ status: 'completed' });

        const accountNight = toCampaignCompetition('night-v1', NIGHT_STAGE);
        expect((await entryOf(accountNight, redditPlayerId))?.bestTimeMs).toBe(9000);
        expect(await entryOf(guestNight, guestPlayerId)).toBeNull();
    });

    it('keeps an account result on a new stage, saved after the request took its list and before the marks', async () => {
        const guestPlayerId = 'guest:reload-account-row';
        const redditPlayerId = 'reddit:reload-account-row';
        await seedBoardRow('numbered-v1', getCampaignStage('numbered-v1-00'), guestPlayerId, 31234);
        await publishNightInRedis();
        const accountNight = await seedBoardRow('night-v1', NIGHT_STAGE, redditPlayerId, 8000);
        const savedResult = {
            ...NIGHT_STAGE,
            bestTimeMs: 8000,
            medal: 'gold',
            checkpointTimesSec: null,
            updatedAt: new Date().toISOString(),
        };
        await redis.set(campaignProgressKey(redditPlayerId, 'night-v1'), JSON.stringify({
            campaignId: 'night-v1',
            startedAt: savedResult.updatedAt,
            resultsByRaceId: { 'night-v1-00': savedResult },
            updatedAt: savedResult.updatedAt,
        }));

        await expect(transferRequest(guestPlayerId, redditPlayerId)).resolves.toMatchObject({ status: 'completed' });

        expect((await entryOf(accountNight, redditPlayerId))?.bestTimeMs).toBe(8000);
        const accountProgress = JSON.parse(await redis.get(campaignProgressKey(redditPlayerId, 'night-v1')));
        expect(accountProgress.resultsByRaceId['night-v1-00']).toMatchObject({ bestTimeMs: 8000 });
    });

    it('stops with a retry and no copy work when the list cannot load, and the next try completes', async () => {
        const guestPlayerId = 'guest:reload-fails';
        const redditPlayerId = 'reddit:reload-fails';
        const numbersStage = getCampaignStage('numbered-v1-00');
        await seedBoardRow('numbered-v1', numbersStage, guestPlayerId, 31234);
        const realMGet = RedisTestDouble.prototype.mGet;
        redis.mGet = async function failAfterMarks(keys) {
            if (keys.includes(seriesStore.STORED_SERIES_REVISION_KEY)) throw new Error('redis: timeout');
            return realMGet.call(this, keys);
        };

        await expect(transferRequest(guestPlayerId, redditPlayerId))
            .rejects.toMatchObject({ statusCode: 503, reason: 'progress_selection_retryable' });

        const record = JSON.parse(await redis.get(selectionKey(guestPlayerId, redditPlayerId)));
        expect(record).toMatchObject({ status: 'pending', phase: 'preparing' });
        expect(record.sourceInventory).toBeUndefined();
        expect(await entryOf(toCampaignCompetition('numbered-v1', numbersStage), redditPlayerId)).toBeNull();

        delete redis.mGet;
        await expect(transferRequest(guestPlayerId, redditPlayerId)).resolves.toMatchObject({ status: 'completed' });
        expect((await entryOf(toCampaignCompetition('numbered-v1', numbersStage), redditPlayerId))?.bestTimeMs)
            .toBe(31234);
    });

    it('resumes a copying transfer after a publication with its frozen inventory', async () => {
        const guestPlayerId = 'guest:reload-resume';
        const redditPlayerId = 'reddit:reload-resume';
        const numbersStage = getCampaignStage('numbered-v1-00');
        await seedBoardRow('numbered-v1', numbersStage, guestPlayerId, 31234);
        // A held progress lock stops the first request after it recorded the guest data.
        const lockKey = `campaign:numbered-v1:progress-lock:${playerHash(guestPlayerId)}`;
        await redis.set(lockKey, 'held');

        await expect(transferRequest(guestPlayerId, redditPlayerId))
            .rejects.toMatchObject({ statusCode: 503, reason: 'progress_selection_retryable' });
        const frozen = JSON.parse(await redis.get(selectionKey(guestPlayerId, redditPlayerId)));
        expect(frozen.phase).toBe('copying');
        expect(frozen.sourceInventory).toBeTruthy();

        await redis.del(lockKey);
        await publishNightInRedis();
        // A new reward field would show up in a new inventory, not in the frozen one.
        await recordCompletedRace(guestPlayerId);
        expect(Object.keys(await redis.hGetAll(carUnlockHashKey(guestPlayerId))).length).toBeGreaterThan(0);

        await expect(transferRequest(guestPlayerId, redditPlayerId)).resolves.toMatchObject({ status: 'completed' });
        const completed = JSON.parse(await redis.get(selectionKey(guestPlayerId, redditPlayerId)));
        expect(completed.sourceInventory).toEqual(frozen.sourceInventory);
        expect((await entryOf(toCampaignCompetition('numbered-v1', numbersStage), redditPlayerId))?.bestTimeMs)
            .toBe(31234);
    });
});
