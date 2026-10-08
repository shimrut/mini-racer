import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';

// Adds the hash increment and transaction calls this import needs, leaving other fixtures alone.
class MigrationRedis extends RedisTestDouble {
    async hSet(...args) {
        const result = super.hSet(...args);
        this._bump(args[0]);
        return result;
    }
    async hSetNX(key, field, value) {
        const existed = this.hashes.get(key)?.has(field);
        const result = super.hSetNX(key, field, value);
        if (!existed) this._bump(key);
        return result;
    }
    async hIncrBy(key, field, amount) {
        const hash = this.hashes.get(key) ?? new Map();
        const value = Number(hash.get(field) ?? 0) + amount;
        hash.set(field, String(value));
        this.hashes.set(key, hash);
        this._bump(key);
        return value;
    }
    async hLen(key) { return (await this.hKeys(key)).length; }
    async zRange(key, start, stop, options) {
        if (options?.by === 'rank' && options.reverse) {
            return [...(this.sortedSets.get(key)?.entries() ?? [])]
                .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
                .reverse().slice(start, stop + 1).map(([member, score]) => ({ member, score }));
        }
        return super.zRange(key, start, stop, options);
    }
    async watch(...keys) {
        const watched = keys.map((key) => [key, this.versions.get(key) ?? 0]);
        const commands = [];
        const transaction = {
            multi: async () => {}, discard: async () => {}, unwatch: async () => {},
            watch: async (...extraKeys) => {
                for (const key of extraKeys) {
                    if (!keys.includes(key)) {
                        keys.push(key);
                        watched.push([key, this.versions.get(key) ?? 0]);
                    }
                }
                return transaction;
            },
            exec: async () => {
                this.execCount += 1;
                if (this.failExecAt === this.execCount) {
                    this.failExecAt = null;
                    throw new Error('Redis unavailable');
                }
                if (this.throwTransactionConflictAt === this.execCount) {
                    this.throwTransactionConflictAt = null;
                    throw new Error('2 UNKNOWN: redis: transaction failed');
                }
                if (this.beforeExec) await this.beforeExec(keys);
                if (watched.some(([key, version]) => (this.versions.get(key) ?? 0) !== version)) return [];
                // Apply the whole batch before yielding, as EXEC does.
                const result = await Promise.all(commands.map(([name, args]) => this[name](...args)));
                if (this.loseAcknowledgementAt === this.execCount) {
                    this.loseAcknowledgementAt = null;
                    throw new Error('Lost Redis acknowledgement');
                }
                return result;
            },
        };
        for (const name of ['set', 'hSet', 'hSetNX', 'hIncrBy', 'zAdd']) {
            transaction[name] = async (...args) => { commands.push([name, args]); };
        }
        return transaction;
    }
}

const redis = new MigrationRedis();
vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));
vi.mock('@devvit/web/server', () => ({ context: {}, reddit: {} }));
vi.mock('../src/server/tracks/stored-catalog.ts', () => ({ loadStoredTracks: vi.fn() }));
const {
    challengeAnalyticsCountsKey, challengeAnalyticsCounterFields, challengeAnalyticsViewersKey,
    challengeTrackAnalyticsCountsKey, challengeTrackAnalyticsCounterFields,
    challengeTrackAnalyticsViewersKey, getChallengeAnalyticsPage,
} = await import('../src/server/moderator/challenge-analytics-store.ts');
const { migrateLegacyChallengeAnalytics, challengeAnalyticsMigrationKeys } = await import('../src/server/moderator/challenge-analytics-migration.ts');
const { headToHeadCatalogAllKey, headToHeadCatalogCardsKey } = await import('../src/server/head-to-head/head-to-head-catalog.ts');
const { playerFieldHash } = await import('../src/server/redis/redis-names.ts');
const SUBREDDIT = 'MiniRacer';

async function seedPost(id, { trackKey = 'numberOne', views = 5, clicks = 2, viewers = ['shared'], startedAt = '2026-10-04T10:00:00.000Z', subredditName = SUBREDDIT } = {}) {
    const card = {
        challengeId: `challenge-${id}`, postId: `t3_${id}`,
        postUrl: `https://www.reddit.com/r/${subredditName}/comments/${id}/`,
        subredditName, challengerUsername: 'RaceFan', trackKey,
        lapCount: 1, targetTimeMs: 12_000, medal: 'gold',
        createdAt: '2026-10-03T10:00:00.000Z',
    };
    await redis.hSet(headToHeadCatalogCardsKey(subredditName), { [card.challengeId]: JSON.stringify(card) });
    await redis.zAdd(headToHeadCatalogAllKey(subredditName), { member: card.challengeId, score: Number(id) });
    const fields = challengeAnalyticsCounterFields(card.postId);
    await redis.hSet(challengeAnalyticsCountsKey(subredditName), {
        [fields.views]: String(views), [fields.clicks]: String(clicks),
        ...(startedAt ? { [fields.trackingStartedAt]: startedAt } : {}),
    });
    await redis.hSet(challengeAnalyticsViewersKey(subredditName, card.postId), Object.fromEntries(
        viewers.map((viewer) => [playerFieldHash(viewer), '1']),
    ));
    return card;
}

async function lifetime(trackKey = 'numberOne', subredditName = SUBREDDIT) {
    const fields = challengeTrackAnalyticsCounterFields(trackKey);
    const [views, clicks, ownOpens, startedAt] = await redis.hMGet(challengeTrackAnalyticsCountsKey(subredditName), [
        fields.views, fields.acceptClicks, fields.ownOpens, fields.trackingStartedAt,
    ]);
    return { views: Number(views ?? 0), acceptClicks: Number(clicks ?? 0), ownOpens: Number(ownOpens ?? 0),
        uniqueViewers: await redis.hLen(challengeTrackAnalyticsViewersKey(subredditName, trackKey)), startedAt };
}

beforeEach(() => {
    redis.reset();
    redis.failExecAt = null;
    redis.loseAcknowledgementAt = null;
    vi.restoreAllMocks();
});

describe('legacy challenge analytics lifetime import', () => {
    it('merges posts by track and unions viewers, preserving existing v2 totals without inventing daily history', async () => {
        const first = await seedPost('1', { views: 5, clicks: 2, viewers: ['shared', 'first'], startedAt: '2026-10-03T10:00:00.000Z' });
        await seedPost('2', { views: 9, clicks: 4, viewers: ['shared', 'second'] });
        await seedPost('3', { trackKey: 'numberTwo', views: 3, clicks: 1, viewers: ['shared'] });
        const fields = challengeTrackAnalyticsCounterFields('numberOne');
        await redis.hSet(challengeTrackAnalyticsCountsKey(SUBREDDIT), {
            [fields.views]: '2', [fields.ownOpens]: '1', [fields.trackingStartedAt]: '2026-10-05T10:00:00.000Z',
        });
        await redis.hSet(challengeTrackAnalyticsViewersKey(SUBREDDIT, 'numberOne'), { [playerFieldHash('shared')]: '1' });
        const oldCounts = await redis.hGetAll(challengeAnalyticsCountsKey(SUBREDDIT));
        const oldViewers = await redis.hGetAll(challengeAnalyticsViewersKey(SUBREDDIT, first.postId));

        const page = await getChallengeAnalyticsPage(SUBREDDIT, 0, { now: new Date('2026-10-05T12:00:00.000Z') });
        expect(page.items.map((item) => item.trackKey)).toEqual(['numberOne', 'numberTwo']);
        expect(page.items[0]).toMatchObject({
            trackingStartedAt: '2026-10-03T10:00:00.000Z',
            today: { views: 0, uniqueViewers: 0, clicks: 0, acceptClicks: 0, ownOpens: 0 },
            lifetime: { views: 16, uniqueViewers: 3, clicks: 7, acceptClicks: 6, ownOpens: 1 },
        });
        expect(await lifetime('numberTwo')).toMatchObject({ views: 3, uniqueViewers: 1, acceptClicks: 1 });
        expect(await redis.hGetAll(challengeAnalyticsCountsKey(SUBREDDIT))).toEqual(oldCounts);
        expect(await redis.hGetAll(challengeAnalyticsViewersKey(SUBREDDIT, first.postId))).toEqual(oldViewers);
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await lifetime()).views).toBe(16);
    });

    it('does not double-count when moderator requests import concurrently', async () => {
        await seedPost('1');
        await seedPost('2');
        await Promise.all([migrateLegacyChallengeAnalytics(SUBREDDIT), migrateLegacyChallengeAnalytics(SUBREDDIT)]);
        expect(await lifetime()).toMatchObject({ views: 10, acceptClicks: 4, uniqueViewers: 1 });
        expect(await redis.hLen(challengeAnalyticsMigrationKeys(SUBREDDIT).receipts)).toBe(2);
    });

    it('resumes after an interruption without repeating the already committed post', async () => {
        await seedPost('1');
        await seedPost('2');
        redis.failExecAt = 3;
        await expect(migrateLegacyChallengeAnalytics(SUBREDDIT)).rejects.toThrow('Redis unavailable');
        expect((await lifetime()).views).toBe(5);
        // Completion freezes mappings; unimported snapshots remain resumable.
        expect(await redis.get(challengeAnalyticsMigrationKeys(SUBREDDIT).complete)).toBe('1');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 10, acceptClicks: 4, uniqueViewers: 1 });
    });

    it('retries a real SDK transaction-conflict error', async () => {
        await seedPost('1');
        redis.throwTransactionConflictAt = 1;
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await lifetime()).views).toBe(5);
        expect(redis.execCount).toBe(3);
    });

    it('re-reads source totals and viewers when the legacy snapshot changes during import', async () => {
        const card = await seedPost('1');
        redis.beforeExec = async (keys) => {
            if (!keys.includes(challengeAnalyticsCountsKey(SUBREDDIT))) return;
            redis.beforeExec = null;
            await redis.hIncrBy(challengeAnalyticsCountsKey(SUBREDDIT), challengeAnalyticsCounterFields(card.postId).views, 1);
            await redis.hSet(challengeAnalyticsViewersKey(SUBREDDIT, card.postId), { [playerFieldHash('later')]: '1' });
        };
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 6, uniqueViewers: 2 });
        expect(redis.execCount).toBe(3);
    });

    it('bounds reads and rechecks only fixed mappings after completion', async () => {
        for (let index = 0; index < 30; index += 1) await seedPost(String(index), {
            views: index === 0 ? 250 : 1, clicks: 0,
            viewers: index === 0 ? Array.from({ length: 250 }, (_value, n) => `viewer-${n}`) : ['viewer-0'],
        });
        const scan = vi.spyOn(redis, 'hScan');
        const read = vi.spyOn(redis, 'hMGet');
        const index = vi.spyOn(redis, 'zRange');
        vi.spyOn(redis, 'hGetAll').mockImplementation(() => { throw new Error('Unbounded read forbidden'); });
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await lifetime()).views).toBe(279);
        expect((await lifetime()).uniqueViewers).toBe(250);
        const receiptsKey = challengeAnalyticsMigrationKeys(SUBREDDIT).receipts;
        expect(scan.mock.calls.every(([key, _cursor, _pattern, size]) => size === (key === receiptsKey ? 25 : 100))).toBe(true);
        expect(read.mock.calls.every(([_key, fields]) => fields.length <= 75)).toBe(true);
        scan.mockClear();
        read.mockClear();
        index.mockClear();
        const executions = redis.execCount;
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(scan.mock.calls.every(([key]) => key === receiptsKey)).toBe(true);
        expect(read.mock.calls.every(([key, fields]) => key === challengeAnalyticsCountsKey(SUBREDDIT) && fields.length <= 75)).toBe(true);
        expect(index).not.toHaveBeenCalled();
        expect(redis.execCount).toBe(executions);
    });

    it('keeps subreddit imports separate and omits untracked legacy posts', async () => {
        await seedPost('1', { views: 0, clicks: 0, viewers: [] });
        await seedPost('2', { subredditName: 'AnotherSub' });
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await getChallengeAnalyticsPage(SUBREDDIT, 0)).items).toEqual([]);
        expect((await lifetime('numberOne', 'AnotherSub')).views).toBe(0);
        await migrateLegacyChallengeAnalytics('AnotherSub');
        expect((await lifetime('numberOne', 'AnotherSub')).views).toBe(5);
    });

    it('reconciles a v1 view whose membership finishes after its receipt and marker', async () => {
        const card = await seedPost('1', { views: 1, clicks: 0, viewers: [] });
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 1, uniqueViewers: 0 });
        expect(await redis.get(challengeAnalyticsMigrationKeys(SUBREDDIT).complete)).toBe('1');

        await redis.hSetNX(challengeAnalyticsViewersKey(SUBREDDIT, card.postId), playerFieldHash('late-viewer'), '1');
        const increments = vi.spyOn(redis, 'hIncrBy');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(increments).not.toHaveBeenCalled();
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await lifetime()).uniqueViewers).toBe(1);
    });

    it('adds only late counter deltas after the marker and leaves Today untouched', async () => {
        const card = await seedPost('1');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        const oldFields = challengeAnalyticsCounterFields(card.postId);
        await redis.hIncrBy(challengeAnalyticsCountsKey(SUBREDDIT), oldFields.views, 3);
        await redis.hIncrBy(challengeAnalyticsCountsKey(SUBREDDIT), oldFields.clicks, 4);
        await redis.hSetNX(challengeAnalyticsViewersKey(SUBREDDIT, card.postId), playerFieldHash('later'), '1');
        const increments = vi.spyOn(redis, 'hIncrBy');
        const page = await getChallengeAnalyticsPage(SUBREDDIT, 0, { now: new Date('2026-10-05T12:00:00.000Z') });
        expect(page.items[0]).toMatchObject({
            today: { views: 0, uniqueViewers: 0, clicks: 0 },
            lifetime: { views: 8, uniqueViewers: 2, acceptClicks: 6, ownOpens: 0 },
        });
        const fields = challengeTrackAnalyticsCounterFields(card.trackKey);
        expect(increments.mock.calls).toEqual([
            [challengeTrackAnalyticsCountsKey(SUBREDDIT), fields.views, 3],
            [challengeTrackAnalyticsCountsKey(SUBREDDIT), fields.acceptClicks, 4],
        ]);
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 8, acceptClicks: 6, uniqueViewers: 2 });
        expect(increments).toHaveBeenCalledTimes(2);
    });

    it('maps zero-count posts so an in-flight first v1 view is not discarded', async () => {
        const card = await seedPost('1', { views: 0, clicks: 0, viewers: [], startedAt: null });
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(JSON.parse(await redis.hGet(challengeAnalyticsMigrationKeys(SUBREDDIT).receipts, card.postId))).toEqual({
            trackKey: 'numberOne', views: 0, clicks: 0, viewerCount: 0, startedAt: null,
        });
        const fields = challengeAnalyticsCounterFields(card.postId);
        await redis.hIncrBy(challengeAnalyticsCountsKey(SUBREDDIT), fields.views, 1);
        await redis.hSetNX(challengeAnalyticsCountsKey(SUBREDDIT), fields.trackingStartedAt, '2026-10-05T11:00:00.000Z');
        await redis.hSetNX(challengeAnalyticsViewersKey(SUBREDDIT, card.postId), playerFieldHash('first'), '1');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 1, uniqueViewers: 1, startedAt: '2026-10-05T11:00:00.000Z' });
    });

    it('repairs a late v1 tracking timestamp without a count or membership change', async () => {
        const card = await seedPost('1', { views: 1, clicks: 0, viewers: [], startedAt: null });
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await lifetime()).startedAt).toBeNull();
        await redis.hSetNX(challengeAnalyticsCountsKey(SUBREDDIT), challengeAnalyticsCounterFields(card.postId).trackingStartedAt, '2026-10-04T23:59:59.000Z');
        const increments = vi.spyOn(redis, 'hIncrBy');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 1, uniqueViewers: 0, startedAt: '2026-10-04T23:59:59.000Z' });
        expect(increments).not.toHaveBeenCalled();
    });

    it('preserves an earlier live v2 timestamp inserted during legacy reconciliation', async () => {
        await seedPost('1', { views: 1, clicks: 0, viewers: [], startedAt: '2026-10-05T12:00:05.000Z' });
        const countsKey = challengeTrackAnalyticsCountsKey(SUBREDDIT);
        const fields = challengeTrackAnalyticsCounterFields('numberOne');
        await redis.hSet(countsKey, { [fields.views]: '1' });
        redis.beforeExec = async (keys) => {
            if (!keys.includes(challengeAnalyticsCountsKey(SUBREDDIT))) return;
            redis.beforeExec = null;
            expect(keys).toContain(countsKey);
            await redis.hSetNX(countsKey, fields.trackingStartedAt, '2026-10-05T12:00:00.000Z');
        };
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 2, startedAt: '2026-10-05T12:00:00.000Z' });
        expect(redis.execCount).toBe(3);
    });

    it('does not watch active v2 totals for membership-only reconciliation', async () => {
        const card = await seedPost('1');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        await redis.hSetNX(challengeAnalyticsViewersKey(SUBREDDIT, card.postId), playerFieldHash('later'), '1');
        let checked = false;
        redis.beforeExec = async (keys) => {
            checked = true;
            expect(keys).not.toContain(challengeTrackAnalyticsCountsKey(SUBREDDIT));
        };
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(checked).toBe(true);
        expect(await lifetime()).toMatchObject({ views: 5, uniqueViewers: 2 });
    });

    it('does not reset a receipt imported while catalogue mappings initialize', async () => {
        const card = await seedPost('1');
        redis.beforeExec = async (keys) => {
            if (!keys.includes(challengeAnalyticsMigrationKeys(SUBREDDIT).complete)) return;
            redis.beforeExec = null;
            const fields = challengeTrackAnalyticsCounterFields(card.trackKey);
            await redis.hSet(challengeTrackAnalyticsCountsKey(SUBREDDIT), { [fields.views]: '3', [fields.acceptClicks]: '1' });
            await redis.hSet(challengeTrackAnalyticsViewersKey(SUBREDDIT, card.trackKey), { [playerFieldHash('shared')]: '1' });
            await redis.hSet(challengeAnalyticsMigrationKeys(SUBREDDIT).receipts, { [card.postId]: JSON.stringify({
                trackKey: card.trackKey, views: 3, clicks: 1, viewerCount: 1, startedAt: null,
            }) });
        };
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 5, acceptClicks: 2, uniqueViewers: 1 });
    });

    it('reconciles concurrent late writes without repeating deltas or shared identities', async () => {
        const first = await seedPost('1');
        const second = await seedPost('2');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        for (const [card, amount] of [[first, 2], [second, 3]]) {
            await redis.hIncrBy(challengeAnalyticsCountsKey(SUBREDDIT), challengeAnalyticsCounterFields(card.postId).views, amount);
            await redis.hSetNX(challengeAnalyticsViewersKey(SUBREDDIT, card.postId), playerFieldHash('same-late-viewer'), '1');
        }
        await Promise.all([migrateLegacyChallengeAnalytics(SUBREDDIT), migrateLegacyChallengeAnalytics(SUBREDDIT)]);
        expect(await lifetime()).toMatchObject({ views: 15, acceptClicks: 4, uniqueViewers: 2 });
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await lifetime()).views).toBe(15);
    });

    it('resumes safely after a committed reconciliation loses its acknowledgement', async () => {
        const card = await seedPost('1');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        await redis.hIncrBy(challengeAnalyticsCountsKey(SUBREDDIT), challengeAnalyticsCounterFields(card.postId).views, 1);
        redis.loseAcknowledgementAt = redis.execCount + 1;
        await expect(migrateLegacyChallengeAnalytics(SUBREDDIT)).rejects.toThrow('Lost Redis acknowledgement');
        expect((await lifetime()).views).toBe(6);
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect((await lifetime()).views).toBe(6);
        expect(JSON.parse(await redis.hGet(challengeAnalyticsMigrationKeys(SUBREDDIT).receipts, card.postId)).views).toBe(6);
    });

    it('chunks oversized HSCAN receipt and viewer results instead of trusting COUNT', async () => {
        for (let index = 0; index < 30; index += 1) await seedPost(String(index), {
            views: index === 0 ? 250 : 1, clicks: 0,
            viewers: index === 0 ? Array.from({ length: 250 }, (_value, n) => `viewer-${n}`) : ['viewer-0'],
        });
        const receiptsKey = challengeAnalyticsMigrationKeys(SUBREDDIT).receipts;
        const largeViewersKey = challengeAnalyticsViewersKey(SUBREDDIT, 't3_0');
        const scan = redis.hScan.bind(redis);
        vi.spyOn(redis, 'hScan').mockImplementation(async (key, cursor, pattern, size) => {
            if ((key === receiptsKey || key === largeViewersKey) && cursor === 0) {
                return { cursor: 0, fieldValues: [...redis.hashes.get(key)].map(([field, value]) => ({ field, value })) };
            }
            return scan(key, cursor, pattern, size);
        });
        const reads = vi.spyOn(redis, 'hMGet');
        const writes = vi.spyOn(redis, 'hSet');
        await migrateLegacyChallengeAnalytics(SUBREDDIT);
        expect(await lifetime()).toMatchObject({ views: 279, uniqueViewers: 250 });
        expect(reads.mock.calls.every(([_key, fields]) => fields.length <= 75)).toBe(true);
        const viewerWrites = writes.mock.calls.filter(([key]) => key === challengeTrackAnalyticsViewersKey(SUBREDDIT, 'numberOne'));
        expect(viewerWrites.every(([_key, values]) => Object.keys(values).length <= 100)).toBe(true);
        expect(viewerWrites.some(([_key, values]) => Object.keys(values).length === 100)).toBe(true);
    });
});
