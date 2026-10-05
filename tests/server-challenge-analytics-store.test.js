import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';

const context = {};
const hashes = new Map();
const sortedSets = new Map();
const expiries = new Map();
function hashFor(key) {
    const hash = hashes.get(key) ?? new Map();
    hashes.set(key, hash);
    return hash;
}
const redis = {
    hIncrBy: vi.fn(async (key, field, amount) => {
        const hash = hashFor(key);
        const next = Number(hash.get(field) ?? 0) + amount;
        hash.set(field, String(next));
        return next;
    }),
    hSetNX: vi.fn(async (key, field, value) => {
        const hash = hashFor(key);
        if (hash.has(field)) return 0;
        hash.set(field, value);
        return 1;
    }),
    hLen: vi.fn(async (key) => hashFor(key).size),
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashFor(key).get(field) ?? null)),
    hGetAll: vi.fn(() => { throw new Error('Unbounded read forbidden'); }),
    zAdd: vi.fn(async (key, row) => {
        const rows = (sortedSets.get(key) ?? []).filter(({ member }) => member !== row.member);
        rows.push(row);
        sortedSets.set(key, rows);
        return 1;
    }),
    zRange: vi.fn(async (key, start, stop) => [...(sortedSets.get(key) ?? [])]
        .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member)).slice(start, stop + 1)),
    expire: vi.fn(async (key, seconds) => { expiries.set(key, seconds); }),
    del: vi.fn(() => { throw new Error('Analytics must not delete legacy data'); }),
};
const loadStoredTracks = vi.fn(async () => {});
const migrateLegacyChallengeAnalytics = vi.fn(async () => {});
vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ context, reddit: {} }));
vi.mock('../src/server/tracks/stored-catalog.ts', () => ({ loadStoredTracks }));
vi.mock('../src/server/moderator/challenge-analytics-migration.ts', () => ({ migrateLegacyChallengeAnalytics }));

const {
    challengeAnalyticsCountsKey,
    challengeAnalyticsViewersKey,
    challengeTrackAnalyticsCountsKey,
    challengeTrackAnalyticsViewersKey,
    challengeTrackAnalyticsCounterFields,
    challengeTrackAnalyticsIndexKey,
    challengeTrackAnalyticsDayExpiry,
    getChallengeAnalyticsPage,
    recordChallengeAnalyticsEvent,
} = await import('../src/server/moderator/challenge-analytics-store.ts');
const TRACK_KEY = Object.keys(TRACKS)[0];
const OTHER_TRACK_KEY = Object.keys(TRACKS)[1];
const NOW = new Date('2026-10-05T09:00:00.000Z');
const DATE = '2026-10-05';
const event = (action, now = NOW, extras = {}) => recordChallengeAnalyticsEvent({ action, ...extras }, { now: () => now });
const page = (offset = 0, now = NOW, subredditName = 'MiniRacer') => getChallengeAnalyticsPage(subredditName, offset, { now });

function trustedContext(overrides = {}) {
    Object.assign(context, {
        subredditName: 'MiniRacer', postId: 't3_one', userId: 't2_player', loid: 'anonymous-one',
        postAuthorId: 't2_author',
        postData: { postType: 'head-to-head', challengeId: 'challenge-one', trackKey: TRACK_KEY, challengerUserId: 't2_author' },
        ...overrides,
    });
}

function metrics(trackKey = TRACK_KEY, date = null, subredditName = 'MiniRacer') {
    const fields = challengeTrackAnalyticsCounterFields(trackKey);
    const hash = hashFor(challengeTrackAnalyticsCountsKey(subredditName, date));
    const acceptClicks = Number(hash.get(fields.acceptClicks) ?? 0);
    const ownOpens = Number(hash.get(fields.ownOpens) ?? 0);
    return {
        views: Number(hash.get(fields.views) ?? 0),
        clicks: acceptClicks + ownOpens, acceptClicks, ownOpens,
        uniqueViewers: hashFor(challengeTrackAnalyticsViewersKey(subredditName, trackKey, date)).size,
    };
}

function startedAt(trackKey = TRACK_KEY) {
    return hashFor(challengeTrackAnalyticsCountsKey('MiniRacer')).get(challengeTrackAnalyticsCounterFields(trackKey).trackingStartedAt) ?? null;
}

function seedTrackIndex(size) {
    sortedSets.set(challengeTrackAnalyticsIndexKey('MiniRacer'), Array.from({ length: size }, (_unused, index) => ({ member: `track${String(index).padStart(3, '0')}`, score: 0 })));
}

const ZERO = { views: 0, clicks: 0, acceptClicks: 0, ownOpens: 0, uniqueViewers: 0 };

describe('challenge analytics by track', () => {
    beforeEach(() => {
        for (const key of Object.keys(context)) delete context[key];
        hashes.clear(); sortedSets.clear(); expiries.clear();
        vi.clearAllMocks();
        trustedContext();
    });

    it('counts raw concurrent repeats across posts while deduplicating track viewers', async () => {
        await Promise.all(Array.from({ length: 50 }, (_unused, index) => {
            context.postId = index % 2 ? 't3_old' : 't3_new';
            context.postData.challengeId = index % 2 ? 'old-challenge' : 'new-challenge';
            return event('view');
        }));
        await Promise.all(Array.from({ length: 5 }, () => event('click')));
        expect(metrics()).toEqual({ views: 50, uniqueViewers: 1, clicks: 5, acceptClicks: 5, ownOpens: 0 });
        expect(metrics(TRACK_KEY, DATE)).toEqual(metrics());
        expect(startedAt()).toBe(NOW.toISOString());
        expect(loadStoredTracks).not.toHaveBeenCalled();
        expect(migrateLegacyChallengeAnalytics).not.toHaveBeenCalled();
    });

    it('starts a fresh UTC day while lifetime includes events on old posts', async () => {
        const before = new Date('2026-10-04T23:59:59.999Z');
        const after = new Date('2026-10-05T00:00:00.000Z');
        context.postData.createdAt = '2020-01-01T00:00:00.000Z';
        await event('view', before);
        context.postId = 't3_other_old_post';
        await event('view', after);
        context.userId = 't2_second';
        await event('view', after);
        expect(metrics(TRACK_KEY, '2026-10-04')).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(metrics(TRACK_KEY, DATE)).toMatchObject({ views: 2, uniqueViewers: 2 });
        expect(metrics()).toMatchObject({ views: 3, uniqueViewers: 2 });
        expect(startedAt()).toBe(before.toISOString());
        const result = await page(0, after);
        expect(result.date).toBe(DATE);
        expect(result.items[0].today).toMatchObject({ views: 2, uniqueViewers: 2 });
        expect(result.items[0].lifetime).toMatchObject({ views: 3, uniqueViewers: 2 });
    });

    it('keeps daily expiry at a fixed UTC deadline and lifetime membership permanent', async () => {
        const first = new Date('2026-10-05T00:00:00.000Z');
        const last = new Date('2026-10-05T23:00:00.000Z');
        await event('view', first);
        const countsKey = challengeTrackAnalyticsCountsKey('MiniRacer', DATE);
        const viewersKey = challengeTrackAnalyticsViewersKey('MiniRacer', TRACK_KEY, DATE);
        expect(expiries.get(countsKey)).toBe(172800);
        expect(expiries.get(viewersKey)).toBe(172800);
        await event('view', last);
        expect(expiries.get(countsKey)).toBe(90000);
        expect(expiries.get(viewersKey)).toBe(90000);
        expect(challengeTrackAnalyticsDayExpiry(DATE).toISOString()).toBe('2026-10-07T00:00:00.000Z');
        expect([...expiries.keys()].every((key) => key.includes(':d:2026-10-05:'))).toBe(true);
        hashes.delete(countsKey); hashes.delete(viewersKey);
        expect(metrics()).toMatchObject({ views: 2, uniqueViewers: 1 });
    });

    it('recomputes expiry after delayed writes instead of extending the day deadline', async () => {
        const times = [NOW, new Date(NOW.getTime() + 20_000), new Date(NOW.getTime() + 25_000)];
        await recordChallengeAnalyticsEvent({ action: 'view' }, { now: () => times.shift() });
        expect(expiries.get(challengeTrackAnalyticsCountsKey('MiniRacer', DATE))).toBe(140380);
        expect(expiries.get(challengeTrackAnalyticsViewersKey('MiniRacer', TRACK_KEY, DATE))).toBe(140375);
    });

    it('prefers signed-in identity and hashes membership fields', async () => {
        await event('view'); context.loid = 'anonymous-two'; await event('view');
        context.userId = 't2_other'; await event('view');
        expect(metrics()).toMatchObject({ views: 3, uniqueViewers: 2 });
        const fields = [...hashFor(challengeTrackAnalyticsViewersKey('MiniRacer', TRACK_KEY)).keys()];
        expect(fields.every((field) => !field.includes('t2_') && !field.includes('anonymous'))).toBe(true);
    });

    it('counts anonymous identities and includes unidentified views only in totals', async () => {
        context.userId = undefined;
        await event('view'); await event('view'); context.loid = 'anonymous-two'; await event('view');
        context.loid = undefined; await event('view'); await event('view'); await event('click');
        expect(metrics()).toEqual({ views: 5, uniqueViewers: 2, clicks: 1, acceptClicks: 1, ownOpens: 0 });
        expect(metrics(TRACK_KEY, DATE)).toEqual(metrics());
    });

    it('splits Accept clicks and author opens and derives legacy click classification', async () => {
        await event('click');
        context.userId = 't2_author';
        await event('own_open'); await event('own_open'); await event('click');
        expect(metrics()).toEqual({ ...ZERO, clicks: 4, acceptClicks: 1, ownOpens: 3 });
        expect(metrics(TRACK_KEY, DATE)).toEqual(metrics());
    });

    it('authorizes older author posts from the trusted post author ID', async () => {
        delete context.postData.challengerUserId;
        context.userId = context.postAuthorId;
        await event('own_open');
        expect(metrics().ownOpens).toBe(1);
    });

    it.each([
        { userId: undefined, loid: undefined },
        { userId: 't2_other' },
        { userId: 't2_author', postData: { postType: 'head-to-head', challengeId: 'one', trackKey: TRACK_KEY, challengerUserId: 't2_different' } },
    ])('rejects unauthorized author opens: %j', async (overrides) => {
        trustedContext(overrides);
        await event('own_open', NOW, { userId: 't2_author', postAuthorId: 't2_author' });
        expect(redis.hIncrBy).not.toHaveBeenCalled();
    });

    it('includes author views and isolates other tracks and subreddit scopes', async () => {
        context.userId = 't2_author'; await event('view');
        context.postData.trackKey = OTHER_TRACK_KEY; await event('view');
        context.subredditName = 'AnotherSub'; await event('view');
        expect(metrics()).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(metrics(OTHER_TRACK_KEY)).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(metrics(OTHER_TRACK_KEY, null, 'AnotherSub')).toMatchObject({ views: 1, uniqueViewers: 1 });
    });

    it('ignores browser track, identity, post and subreddit targets', async () => {
        await event('view', NOW, { trackKey: OTHER_TRACK_KEY, userId: 't2_forged', postId: 't3_forged', subredditName: 'Forged' });
        expect(metrics()).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(metrics(OTHER_TRACK_KEY, null, 'Forged')).toEqual(ZERO);
    });

    it.each([
        { subredditName: undefined }, { postId: undefined },
        { postData: { postType: 'daily-podium', challengeId: 'one', trackKey: TRACK_KEY } },
        { postData: { postType: 'head-to-head', trackKey: TRACK_KEY } },
        { postData: { postType: 'head-to-head', challengeId: ' ', trackKey: TRACK_KEY } },
        { postData: { postType: 'head-to-head', challengeId: 'one' } },
        { postData: { postType: 'head-to-head', challengeId: 'one', trackKey: 'invalid:key' } },
    ])('requires trusted challenge and track context: %j', async (overrides) => {
        trustedContext(overrides); await event('view'); expect(redis.hIncrBy).not.toHaveBeenCalled();
    });

    it('does not add any unique after a failed lifetime increment', async () => {
        redis.hIncrBy.mockRejectedValueOnce(new Error('Redis unavailable'));
        await expect(event('view')).rejects.toThrow('Redis unavailable');
        expect(redis.hSetNX).not.toHaveBeenCalled();
        expect(metrics()).toEqual(ZERO); expect(metrics(TRACK_KEY, DATE)).toEqual(ZERO);
    });

    it('retains lifetime if the daily increment fails and retries membership safely', async () => {
        const original = redis.hIncrBy.getMockImplementation();
        redis.hIncrBy.mockImplementationOnce(original).mockRejectedValueOnce(new Error('Daily unavailable'));
        await expect(event('view')).rejects.toThrow('Daily unavailable');
        expect(metrics()).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(metrics(TRACK_KEY, DATE)).toEqual(ZERO);
        await event('view');
        expect(metrics()).toMatchObject({ views: 2, uniqueViewers: 1 });
        expect(metrics(TRACK_KEY, DATE)).toMatchObject({ views: 1, uniqueViewers: 1 });
    });

    it('keeps the prior v1 counters and membership unchanged', async () => {
        hashFor(challengeAnalyticsCountsKey('MiniRacer')).set('views:t3_one', '100');
        hashFor(challengeAnalyticsViewersKey('MiniRacer', 't3_one')).set('old-hashed-viewer', '1');
        await event('view'); await page();
        expect(hashFor(challengeAnalyticsCountsKey('MiniRacer')).get('views:t3_one')).toBe('100');
        expect(hashFor(challengeAnalyticsViewersKey('MiniRacer', 't3_one')).size).toBe(1);
        expect(metrics()).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(redis.del).not.toHaveBeenCalled();
    });

    it('returns an explicit UTC date for an empty track index', async () => {
        expect(await page()).toEqual({ date: DATE, items: [], nextOffset: null });
        expect(migrateLegacyChallengeAnalytics).toHaveBeenCalledWith('MiniRacer');
        expect(loadStoredTracks).not.toHaveBeenCalled();
    });

    it('reads track rows in bounded pages and loads only each page definitions', async () => {
        seedTrackIndex(60);
        const first = await page();
        expect(first.items).toHaveLength(25); expect(first.items[0].trackKey).toBe('track000');
        expect(first.items[0]).toMatchObject({ today: ZERO, lifetime: ZERO, trackingStartedAt: null });
        expect(first.nextOffset).toBe(25);
        expect(redis.zRange).toHaveBeenCalledWith(challengeTrackAnalyticsIndexKey('MiniRacer'), 0, 25, { by: 'rank' });
        expect(loadStoredTracks).toHaveBeenCalledWith(first.items.map(({ trackKey }) => trackKey));
        expect(redis.hMGet.mock.calls.every(([, fields]) => fields.length <= 100)).toBe(true);
        expect(redis.hLen).toHaveBeenCalledTimes(50); expect(redis.hGetAll).not.toHaveBeenCalled();
        const second = await page(25); const last = await page(second.nextOffset);
        expect(second.items[0].trackKey).toBe('track025');
        expect(last.items).toHaveLength(10); expect(last.items[0].trackKey).toBe('track050'); expect(last.nextOffset).toBeNull();
    });

    it('returns both periods with split click counters and no viewer identities', async () => {
        await event('view'); await event('click'); context.userId = 't2_author'; await event('own_open');
        const result = await page();
        expect(result.items[0]).toEqual({ trackKey: TRACK_KEY, trackName: expect.any(String), trackingStartedAt: NOW.toISOString(), today: metrics(TRACK_KEY, DATE), lifetime: metrics() });
        expect(result.items[0].lifetime.clicks).toBe(2);
        expect(JSON.stringify(result)).not.toContain('t2_player');
    });

    it('keeps viewed totals above membership when a view arrives during reads', async () => {
        sortedSets.set(challengeTrackAnalyticsIndexKey('MiniRacer'), [{ member: TRACK_KEY, score: 0 }]);
        redis.hLen.mockImplementationOnce(async (key) => { await event('view'); return hashFor(key).size; });
        const result = await page();
        expect(result.items[0].today).toMatchObject({ views: 1, uniqueViewers: 1 });
        expect(result.items[0].lifetime).toMatchObject({ views: 1, uniqueViewers: 1 });
    });

    it('reads lifetime after Today so concurrent views remain included', async () => {
        await event('view');
        const original = redis.hMGet.getMockImplementation();
        redis.hMGet.mockImplementationOnce(async (key, fields) => { await event('view'); return original(key, fields); });
        const result = await page();
        expect(result.items[0].today.views).toBe(2); expect(result.items[0].lifetime.views).toBe(2);
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, NaN])('rejects offset %s before any Redis work', async (offset) => {
        await expect(page(offset)).rejects.toThrow('Invalid challenge analytics offset');
        expect(redis.zRange).not.toHaveBeenCalled(); expect(migrateLegacyChallengeAnalytics).not.toHaveBeenCalled();
    });

    it('surfaces failed membership reads instead of manufacturing zeroes', async () => {
        await event('view'); redis.hLen.mockRejectedValueOnce(new Error('Redis unavailable'));
        await expect(page()).rejects.toThrow('Redis unavailable');
    });
});
