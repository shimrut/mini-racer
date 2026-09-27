import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';

// Freezes how the Daily and the podium lookups find a lost post in the app's
// own post list, before the two copies become one. A podium post and a Daily
// post can name the same day. Daily posts made before 2026-09-08 have no post
// type. Today the podium lookup checks the post type and the Daily lookup does
// not, so a newer podium post of the same day wins the Daily lookup.

const redis = new RedisTestDouble();
const { reddit } = vi.hoisted(() => ({
    reddit: { getPostById: vi.fn(), getPostsByUser: vi.fn() },
}));

vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));
vi.mock('@devvit/web/server', () => ({ reddit, cache: vi.fn(), context: undefined }));

const { resolveDailyGpPostRecord } = await import('../src/server/daily/daily-gp-share.ts');
const { resolveDailyGpPodiumPostRecord } = await import('../src/server/podium/daily-podium-service.ts');

const DAY = 'daily-gp-2026-09-19';
const SUBREDDIT = 'MiniRacerGame';

function post(id, postData, subredditName = SUBREDDIT) {
    return {
        id,
        url: `https://www.reddit.com/r/${subredditName}/comments/${id.slice(3)}/`,
        subredditName,
        getPostData: async () => postData,
    };
}

const PODIUM = post('t3_podium', { postType: 'daily-podium', challengeId: DAY });
const DAILY = post('t3_daily', { postType: 'daily-race', challengeId: DAY });
const OLD_DAILY = post('t3_olddaily', { challengeId: DAY });
const OTHER_SUBREDDIT = post('t3_elsewhere', { postType: 'daily-race', challengeId: DAY }, 'mini_racer_dev');
const OTHER_DAY = post('t3_otherday', { postType: 'daily-race', challengeId: 'daily-gp-2026-09-18' });

// The app's posts, newest first, as the listing returns them.
function listPosts(posts) {
    reddit.getPostsByUser.mockResolvedValue({ all: async () => posts });
}

function lookUp(resolve, preferredPostUrl = null) {
    return resolve({ subredditName: SUBREDDIT, challengeId: DAY, appSlug: 'mini-racer', preferredPostUrl });
}

describe('lost post lookup', () => {
    beforeEach(() => {
        redis.reset();
        reddit.getPostById.mockReset();
        reddit.getPostById.mockRejectedValue(new Error('no stored post'));
        reddit.getPostsByUser.mockReset();
    });

    it('asks for the app\'s own posts of the last month', async () => {
        listPosts([]);

        await expect(lookUp(resolveDailyGpPostRecord)).resolves.toBeNull();
        await expect(lookUp(resolveDailyGpPodiumPostRecord)).resolves.toBeNull();

        for (const [request] of reddit.getPostsByUser.mock.calls) {
            expect(request).toEqual({ username: 'mini-racer', sort: 'new', timeframe: 'month', limit: 100, pageSize: 100 });
        }
    });

    it('podium: takes only a podium post of the same day and subreddit', async () => {
        listPosts([OTHER_SUBREDDIT, OTHER_DAY, OLD_DAILY, DAILY, PODIUM]);

        await expect(lookUp(resolveDailyGpPodiumPostRecord)).resolves.toMatchObject({
            challengeId: DAY,
            postId: 't3_podium',
        });
    });

    it('podium: finds nothing when only Daily posts name the day', async () => {
        listPosts([DAILY, OLD_DAILY]);

        await expect(lookUp(resolveDailyGpPodiumPostRecord)).resolves.toBeNull();
    });

    it('Daily: takes a Daily post with a type, and an old one without a type', async () => {
        listPosts([OTHER_SUBREDDIT, OTHER_DAY, DAILY]);
        await expect(lookUp(resolveDailyGpPostRecord)).resolves.toMatchObject({ postId: 't3_daily' });

        redis.reset();
        listPosts([OLD_DAILY]);
        await expect(lookUp(resolveDailyGpPostRecord)).resolves.toMatchObject({ postId: 't3_olddaily' });
    });

    it('Daily: today takes a newer podium post of the same day first', async () => {
        listPosts([PODIUM, DAILY]);

        await expect(lookUp(resolveDailyGpPostRecord)).resolves.toMatchObject({ postId: 't3_podium' });
    });

    it('both: prefer the post at the known address over the newest one', async () => {
        listPosts([PODIUM, DAILY, OLD_DAILY]);
        await expect(lookUp(resolveDailyGpPostRecord, OLD_DAILY.url)).resolves.toMatchObject({ postId: 't3_olddaily' });

        const secondPodium = post('t3_podium2', { postType: 'daily-podium', challengeId: DAY });
        redis.reset();
        listPosts([secondPodium, PODIUM]);
        await expect(lookUp(resolveDailyGpPodiumPostRecord, PODIUM.url)).resolves.toMatchObject({ postId: 't3_podium' });
    });

    it('both: skip a post whose data cannot be read', async () => {
        const broken = { ...DAILY, id: 't3_broken', getPostData: async () => { throw new Error('gone'); } };
        listPosts([broken, DAILY]);
        await expect(lookUp(resolveDailyGpPostRecord)).resolves.toMatchObject({ postId: 't3_daily' });

        redis.reset();
        listPosts([{ ...PODIUM, id: 't3_broken', getPostData: async () => { throw new Error('gone'); } }, PODIUM]);
        await expect(lookUp(resolveDailyGpPodiumPostRecord)).resolves.toMatchObject({ postId: 't3_podium' });
    });
});
