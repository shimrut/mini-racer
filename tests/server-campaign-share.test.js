import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCampaignFinalStage, getCampaignSeriesStages } from '../game/campaign/manifest.js';

const { values, mockRedis, mockReddit, mockResults, mockIdentity, mockAvatar, mockPending } = vi.hoisted(() => {
    const values = new Map();
    const mockRedis = {
        get: vi.fn(async (key) => values.get(key) ?? null),
        set: vi.fn(async (key, value, options = {}) => {
            if (options.nx && values.has(key)) return '';
            values.set(key, value);
            return 'OK';
        }),
        del: vi.fn(async (key) => Number(values.delete(key))),
        zRank: vi.fn(async () => null),
        zCard: vi.fn(async () => 0),
        watch: vi.fn(() => {
            const commands = [];
            return {
                multi: vi.fn(async () => {}),
                unwatch: vi.fn(async () => {}),
                discard: vi.fn(async () => {}),
                del: vi.fn(async (key) => commands.push(() => mockRedis.del(key))),
                exec: vi.fn(async () => Promise.all(commands.map((command) => command()))),
            };
        }),
    };
    return {
        values,
        mockRedis,
        mockReddit: { submitCustomPost: vi.fn(), getPostsByUser: vi.fn(), getPostById: vi.fn() },
        mockResults: vi.fn(),
        mockIdentity: vi.fn(),
        mockAvatar: vi.fn(),
        mockPending: vi.fn(),
    };
});

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));
vi.mock('../src/server/campaign/campaign-store.js', () => ({ getCampaignResultsForSeries: mockResults }));
vi.mock('../src/server/competition/competition-identity.js', () => ({ resolveAuthorizedPlayerIdentity: mockIdentity }));
vi.mock('../src/server/player/reddit-avatar.js', () => ({ resolveRedditAvatarUrl: mockAvatar }));
vi.mock('../src/server/player/guest-retirement.js', () => ({ isProgressTransferPending: mockPending }));

const { previewServerCampaignResultsShare, confirmServerCampaignResultsShare, refreshServerCampaignResultsShare } = await import('../src/server/campaign/campaign-share.ts');
const { campaignAggregateKeys } = await import('../src/server/campaign/campaign-aggregate-store.ts');
const stages = getCampaignSeriesStages('numbered-v1');
function rankBoard(rank, total) {
    values.set(campaignAggregateKeys('numbered-v1').fillReady, getCampaignFinalStage('numbered-v1').raceId);
    mockRedis.zRank.mockResolvedValue(rank - 1);
    mockRedis.zCard.mockResolvedValue(total);
}
const input = { seriesId: 'numbered-v1', redditUsername: 'RaceFan', subredditName: 'MiniRacer' };
const completedResults = () => Object.fromEntries(stages.map((stage, index) => [stage.raceId, {
    medal: ['author', 'gold', 'silver', 'bronze'][index % 4],
}]));
// The first stage carries the remainder so the saved stage times sum to totalTimeMs.
const timedResults = (totalTimeMs, medal = (index) => ['author', 'gold', 'silver', 'bronze'][index % 4]) => Object.fromEntries(
    stages.map((stage, index) => [stage.raceId, {
        medal: medal(index),
        bestTimeMs: index === 0 ? totalTimeMs - (stages.length - 1) * 1000 : 1000,
    }]),
);
const publishedPost = (overrides = {}) => ({
    id: 't3_finished',
    url: 'https://reddit.com/r/MiniRacer/comments/finished',
    authorName: 'RaceFan',
    subredditName: 'MiniRacer',
    createdAt: new Date(),
    getPostData: vi.fn(async () => ({ postType: 'campaign-finished', seriesId: 'numbered-v1' })),
    delete: vi.fn(async () => {}),
    ...overrides,
});
const claimKey = () => [...values.keys()].find((key) => key.includes(':shared-result:') && !key.endsWith(':lock'));
async function previewAndConfirm(request) {
    const preview = await previewServerCampaignResultsShare(request);
    if (preview.body.status !== 'ready') return preview;
    return confirmServerCampaignResultsShare({ ...request, shareToken: preview.body.shareToken });
}
const refreshInput = { ...input, raceId: stages[0].raceId };
async function publishedFixture() {
    await previewAndConfirm(input);
    const data = { ...mockReddit.submitCustomPost.mock.calls[0][0].postData };
    const post = publishedPost({
        getPostData: vi.fn(async () => ({ ...data })),
        mergePostData: vi.fn(async (updates) => { Object.assign(data, updates); }),
        setTextFallback: vi.fn(async () => {}),
    });
    mockReddit.getPostById.mockResolvedValue(post);
    return post;
}

describe('Campaign result sharing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        values.clear();
        mockRedis.get.mockImplementation(async (key) => values.get(key) ?? null);
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (options.nx && values.has(key)) return '';
            values.set(key, value);
            return 'OK';
        });
        mockReddit.submitCustomPost.mockResolvedValue(publishedPost());
        mockReddit.getPostsByUser.mockReturnValue({ all: async () => [] });
        mockResults.mockResolvedValue(completedResults());
        mockIdentity.mockResolvedValue({ canonicalPlayerId: 'reddit:racefan' });
        mockAvatar.mockResolvedValue('https://i.redd.it/racefan.png');
        mockPending.mockResolvedValue(false);
        mockRedis.zRank.mockResolvedValue(null);
        mockRedis.zCard.mockResolvedValue(0);
    });

    it('prepares the exact canonical title and medals without publishing or reserving a post', async () => {
        const preview = await previewServerCampaignResultsShare(input);
        expect(preview).toMatchObject({
            status: 200,
            body: { status: 'ready', username: 'RaceFan', title: 'I finished the Numbers campaign', stageCount: stages.length },
        });
        expect(preview.body.shareToken).toEqual(expect.any(String));
        expect(preview.body.medalSummary).toContain('author');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockAvatar).not.toHaveBeenCalled();
        expect(claimKey()).toBeUndefined();
        const [key, , options] = mockRedis.set.mock.calls[0];
        expect(key).toBe(`campaign:share-preview:${preview.body.shareToken}`);
        expect(options.expiration).toEqual(new Date(preview.body.expiresAt));
    });

    it('requires an unexpired preview token before it can publish', async () => {
        expect(await confirmServerCampaignResultsShare(input)).toMatchObject({ body: { status: 'preview_expired' } });
        const preview = await previewServerCampaignResultsShare(input);
        const key = `campaign:share-preview:${preview.body.shareToken}`;
        values.set(key, JSON.stringify({ ...JSON.parse(values.get(key)), expiresAt: '2020-01-01T00:00:00.000Z' }));
        expect(await confirmServerCampaignResultsShare({ ...input, shareToken: preview.body.shareToken }))
            .toMatchObject({ body: { status: 'preview_expired' } });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it.each([
        { redditUsername: 'OtherRacer' },
        { subredditName: 'OtherCommunity' },
    ])('binds the preview token to the authenticated account and community', async (otherContext) => {
        const preview = await previewServerCampaignResultsShare(input);
        expect(await confirmServerCampaignResultsShare({ ...input, ...otherContext, shareToken: preview.body.shareToken }))
            .toMatchObject({ status: 403, body: { status: 'share_forbidden' } });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('rechecks canonical completion at confirmation instead of trusting the preview alone', async () => {
        const preview = await previewServerCampaignResultsShare(input);
        mockResults.mockResolvedValue({});
        expect(await confirmServerCampaignResultsShare({ ...input, shareToken: preview.body.shareToken }))
            .toMatchObject({ body: { status: 'campaign_incomplete' } });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('publishes the title and medal summary the player previewed, ignoring confirm body edits', async () => {
        const preview = await previewServerCampaignResultsShare(input);
        const improvedResults = Object.fromEntries(stages.map((stage) => [stage.raceId, { medal: 'author' }]));
        mockResults.mockResolvedValue(improvedResults);
        const confirmed = await confirmServerCampaignResultsShare({
            ...input, shareToken: preview.body.shareToken, title: 'Forged title', seriesId: 'unknown', medalDistribution: { author: 99 },
        });
        expect(confirmed.body.status).toBe('shared');
        expect(mockReddit.submitCustomPost).toHaveBeenCalledWith(expect.objectContaining({
            title: preview.body.title,
            postData: expect.objectContaining({ seriesId: input.seriesId, medalDistribution: preview.body.medalDistribution }),
        }));
        expect(await confirmServerCampaignResultsShare({ ...input, shareToken: preview.body.shareToken }))
            .toMatchObject({ body: { status: 'already_shared', postId: 't3_finished' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('publishes as the authenticated player with canonical name and one medal per stage', async () => {
        const result = await previewAndConfirm({ ...input, seriesName: 'fake', medalDistribution: { author: 99 } });
        expect(result).toMatchObject({ status: 200, body: { status: 'shared', postId: 't3_finished' } });
        expect(mockResults).toHaveBeenCalledWith('reddit:racefan', 'numbered-v1');
        const submitted = mockReddit.submitCustomPost.mock.calls[0][0];
        expect(submitted).toMatchObject({
            entry: 'campaign',
            title: 'I finished the Numbers campaign',
            runAs: 'USER',
            userGeneratedContent: { text: 'I finished the Numbers campaign' },
            postData: {
                postType: 'campaign-finished', launchMode: 'campaign', seriesId: 'numbered-v1', seriesName: 'Numbers',
                playerUsername: 'RaceFan', playerAvatarUrl: 'https://i.redd.it/racefan.png', stageCount: stages.length,
            },
        });
        expect(submitted.postData.place).toBeUndefined();
        expect(submitted.postData.totalTimeMs).toBeUndefined();
        expect(submitted.textFallback.text).not.toContain('Overall place');
        expect(submitted.textFallback.text).not.toContain('Total time');
        expect(Object.values(submitted.postData.medalDistribution).reduce((sum, count) => sum + count, 0)).toBe(stages.length);
        expect(submitted.postData.medalDistribution).toEqual(stages.reduce((counts, _stage, index) => {
            counts[['author', 'gold', 'silver', 'bronze'][index % 4]] += 1;
            return counts;
        }, { author: 0, gold: 0, silver: 0, bronze: 0 }));
    });

    it.each([
        [{ ...input, redditUsername: null }, 'sign_in_required'],
        [{ ...input, seriesId: 'unknown' }, 'campaign_unavailable'],
        [{ ...input, subredditName: null }, 'community_required'],
    ])('rejects missing authenticated context or an unavailable Campaign', async (request, reason) => {
        expect(await previewAndConfirm(request)).toMatchObject({ body: { status: reason } });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('requires the saved final-stage medal and ignores forged request medals', async () => {
        const results = completedResults();
        delete results[stages.at(-1).raceId];
        mockResults.mockResolvedValue(results);
        expect(await previewAndConfirm({ ...input, medalDistribution: { author: 99 } }))
            .toMatchObject({ body: { status: 'campaign_incomplete' } });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(claimKey()).toBeUndefined();
    });

    it('waits for a pending progress selection before sharing', async () => {
        mockPending.mockResolvedValue(true);
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'progress_transfer_pending' } });
        expect(mockResults).not.toHaveBeenCalled();
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('publishes the overall place shown in the preview and ignores a forged place', async () => {
        rankBoard(2, 12);
        const preview = await previewServerCampaignResultsShare(input);
        expect(preview.body).toMatchObject({
            place: { rank: 2, total: 12 },
            placeSummary: 'Overall place #2 / 12',
        });
        const confirmed = await confirmServerCampaignResultsShare({
            ...input, shareToken: preview.body.shareToken, place: { rank: 1, total: 1 },
        });
        expect(confirmed.body.status).toBe('shared');
        const submitted = mockReddit.submitCustomPost.mock.calls[0][0];
        expect(submitted.postData.place).toEqual({ rank: 2, total: 12 });
        expect(submitted.textFallback.text).toContain('Overall place #2 / 12');
    });

    it('rejects a preview whose place was altered', async () => {
        const preview = await previewServerCampaignResultsShare(input);
        const key = `campaign:share-preview:${preview.body.shareToken}`;
        values.set(key, JSON.stringify({ ...JSON.parse(values.get(key)), place: { rank: 0, total: 1 } }));
        expect(await confirmServerCampaignResultsShare({ ...input, shareToken: preview.body.shareToken }))
            .toMatchObject({ body: { status: 'preview_expired' } });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('publishes the total time shown in the preview, in the post data and the plain text', async () => {
        mockResults.mockResolvedValue(timedResults(187_654));
        const preview = await previewServerCampaignResultsShare(input);
        expect(JSON.parse(values.get(`campaign:share-preview:${preview.body.shareToken}`)).totalTimeMs).toBe(187_654);
        mockResults.mockResolvedValue(timedResults(100_000));
        const confirmed = await confirmServerCampaignResultsShare({ ...input, shareToken: preview.body.shareToken, totalTimeMs: 1 });
        expect(confirmed.body.status).toBe('shared');
        const submitted = mockReddit.submitCustomPost.mock.calls[0][0];
        expect(submitted.title).toBe('I finished the Numbers campaign');
        expect(submitted.postData.totalTimeMs).toBe(187_654);
        expect(submitted.textFallback.text).toContain('Total time 3:07.654');
    });

    it.each([0, -1, 1.5, '187654', Number.MAX_SAFE_INTEGER + 1])('rejects a preview whose total time was altered to %j', async (totalTimeMs) => {
        mockResults.mockResolvedValue(timedResults(187_654));
        const preview = await previewServerCampaignResultsShare(input);
        const key = `campaign:share-preview:${preview.body.shareToken}`;
        values.set(key, JSON.stringify({ ...JSON.parse(values.get(key)), totalTimeMs }));
        expect(await confirmServerCampaignResultsShare({ ...input, shareToken: preview.body.shareToken }))
            .toMatchObject({ body: { status: 'preview_expired' } });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('updates the shared place when a later save changes it', async () => {
        const post = await publishedFixture();
        rankBoard(1, 4);
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).toHaveBeenCalledWith({ place: { rank: 1, total: 4 } });
        expect(post.setTextFallback).toHaveBeenCalledWith({
            text: expect.stringContaining('Overall place #1 / 4'),
        });
    });

    it('keeps a posted place when ranking is temporarily unavailable', async () => {
        rankBoard(3, 9);
        const post = await publishedFixture();
        values.delete(campaignAggregateKeys('numbered-v1').fillReady);
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).not.toHaveBeenCalled();
        expect(post.setTextFallback).not.toHaveBeenCalled();
    });

    it('returns the same durable post on repeated clicks', async () => {
        await previewAndConfirm(input);
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'already_shared', postId: 't3_finished' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
        expect(mockResults).toHaveBeenCalledTimes(2);
    });

    it('updates medals and the plain-text backup on the existing post from saved progress', async () => {
        const post = await publishedFixture();
        mockResults.mockResolvedValue(Object.fromEntries(stages.map((stage) => [stage.raceId, { medal: 'author' }])));
        await refreshServerCampaignResultsShare(refreshInput);
        expect(mockReddit.getPostById).toHaveBeenCalledWith('t3_finished');
        expect(post.mergePostData).toHaveBeenCalledWith({
            medalDistribution: { author: stages.length, gold: 0, silver: 0, bronze: 0 }, stageCount: stages.length,
        });
        expect(post.setTextFallback).toHaveBeenCalledWith({
            text: `I finished the Numbers campaign.\n\n${stages.length} author · 0 gold · 0 silver · 0 bronze\n\nOpen this post on Reddit and select Play Campaign to race this Campaign.`,
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
        expect(await previewAndConfirm(input)).toMatchObject({ body: { postId: 't3_finished', status: 'already_shared' } });
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).toHaveBeenCalledOnce();
        expect(post.setTextFallback).toHaveBeenCalledOnce();
    });

    it('does not write a post when medals, place and total time are unchanged', async () => {
        mockResults.mockResolvedValue(timedResults(187_654));
        const post = await publishedFixture();
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).not.toHaveBeenCalled();
        expect(post.setTextFallback).not.toHaveBeenCalled();
    });

    it('updates the total time and plain text when a faster time keeps the medals', async () => {
        mockResults.mockResolvedValue(timedResults(187_654));
        const post = await publishedFixture();
        mockResults.mockResolvedValue(timedResults(170_001));
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).toHaveBeenCalledOnce();
        expect(post.mergePostData).toHaveBeenCalledWith({ totalTimeMs: 170_001 });
        expect(post.setTextFallback).toHaveBeenCalledWith({ text: expect.stringContaining('Total time 2:50.001') });
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).toHaveBeenCalledOnce();
    });

    it('adds the total time to a post made before it was carried', async () => {
        const post = await publishedFixture();
        expect(mockReddit.submitCustomPost.mock.calls[0][0].postData.totalTimeMs).toBeUndefined();
        mockResults.mockResolvedValue(timedResults(187_654));
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).toHaveBeenCalledWith({ totalTimeMs: 187_654 });
    });

    it('keeps a posted total time when no total can be computed', async () => {
        mockResults.mockResolvedValue(timedResults(187_654));
        const post = await publishedFixture();
        mockResults.mockResolvedValue(completedResults());
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).not.toHaveBeenCalled();
    });

    it.each([{ redditUsername: 'OtherRacer' }, { subredditName: 'OtherCommunity' }])('keeps updates scoped to the owner and community: %j', async (other) => {
        await publishedFixture();
        if (other.redditUsername) mockIdentity.mockResolvedValue({ canonicalPlayerId: 'reddit:otherracer' });
        await refreshServerCampaignResultsShare({ ...refreshInput, ...other });
        expect(mockReddit.getPostById).not.toHaveBeenCalled();
    });

    it('does not create a post when no result has been shared', async () => {
        await refreshServerCampaignResultsShare(refreshInput);
        expect(mockReddit.getPostById).not.toHaveBeenCalled();
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('refuses a stored post belonging to another author', async () => {
        const post = await publishedFixture();
        post.authorName = 'OtherRacer';
        await refreshServerCampaignResultsShare(refreshInput);
        expect(post.mergePostData).not.toHaveBeenCalled();
    });

    it('serializes concurrent improvements and reads fresh results after the lock', async () => {
        const post = await publishedFixture();
        const all = (medal) => Object.fromEntries(stages.map((stage) => [stage.raceId, { medal }]));
        mockResults.mockResolvedValue(all('gold'));
        let finishFirst;
        post.mergePostData.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
        const first = refreshServerCampaignResultsShare(refreshInput);
        await vi.waitFor(() => expect(post.mergePostData).toHaveBeenCalledOnce());
        mockResults.mockResolvedValue(all('author'));
        const second = refreshServerCampaignResultsShare(refreshInput);
        await vi.waitFor(() => expect(mockRedis.set.mock.calls.filter(([key]) => key.endsWith(':lock')).length).toBeGreaterThan(2));
        expect(post.mergePostData).toHaveBeenCalledOnce();
        finishFirst();
        await Promise.all([first, second]);
        expect(post.mergePostData).toHaveBeenLastCalledWith({
            medalDistribution: { author: stages.length, gold: 0, silver: 0, bronze: 0 }, stageCount: stages.length,
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('allows a failed Reddit update to be retried against the same post', async () => {
        const post = await publishedFixture();
        mockResults.mockResolvedValue(Object.fromEntries(stages.map((stage) => [stage.raceId, { medal: 'author' }])));
        post.mergePostData.mockRejectedValueOnce(new Error('Reddit unavailable'));
        await expect(refreshServerCampaignResultsShare(refreshInput)).rejects.toThrow('Reddit unavailable');
        expect(JSON.parse(values.get(claimKey())).refreshPending).toBe(true);
        await refreshServerCampaignResultsShare({ ...input, seriesId: 'numbered-v1', onlyIfPending: true });
        expect(post.mergePostData).toHaveBeenCalledTimes(2);
        expect(post.setTextFallback).toHaveBeenCalledOnce();
        expect(JSON.parse(values.get(claimKey())).refreshPending).toBeUndefined();
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('leaves Reddit alone when no post refresh is waiting', async () => {
        await publishedFixture();
        mockReddit.getPostById.mockClear();
        await refreshServerCampaignResultsShare({ ...input, seriesId: 'numbered-v1', onlyIfPending: true });
        expect(mockReddit.getPostById).not.toHaveBeenCalled();
    });

    it('rewrites the plain text when the medal counts were saved but the text update failed', async () => {
        const post = await publishedFixture();
        mockResults.mockResolvedValue(Object.fromEntries(stages.map((stage) => [stage.raceId, { medal: 'author' }])));
        post.setTextFallback.mockRejectedValueOnce(new Error('Reddit unavailable'));
        await expect(refreshServerCampaignResultsShare(refreshInput)).rejects.toThrow('Reddit unavailable');
        expect(post.mergePostData).toHaveBeenCalledOnce();
        await refreshServerCampaignResultsShare({ ...input, seriesId: 'numbered-v1', onlyIfPending: true });
        expect(post.mergePostData).toHaveBeenCalledOnce();
        expect(post.setTextFallback).toHaveBeenLastCalledWith({
            text: `I finished the Numbers campaign.\n\n${stages.length} author · 0 gold · 0 silver · 0 bronze\n\nOpen this post on Reddit and select Play Campaign to race this Campaign.`,
        });
        expect(JSON.parse(values.get(claimKey())).refreshPending).toBeUndefined();
    });

    it('blocks a second click while the first Reddit submission is running', async () => {
        let resolvePost;
        mockReddit.submitCustomPost.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));
        const first = previewAndConfirm(input);
        await vi.waitFor(() => expect(resolvePost).toBeTypeOf('function'));
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'share_in_progress' } });
        resolvePost(publishedPost());
        expect(await first).toMatchObject({ body: { status: 'shared' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('recovers a live user post when Reddit submits and then throws', async () => {
        mockReddit.submitCustomPost.mockRejectedValue(new Error('response connection lost'));
        mockReddit.getPostsByUser.mockReturnValue({ all: async () => [publishedPost()] });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'shared', postId: 't3_finished' } });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'already_shared' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('keeps an uncertain claim and only recovers on retry, even after lock expiry', async () => {
        mockReddit.submitCustomPost.mockRejectedValue(new Error('response connection lost'));
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'share_unconfirmed' } });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'share_unconfirmed' } });
        mockReddit.getPostsByUser.mockReturnValue({ all: async () => [publishedPost()] });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'already_shared' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('recovers after the published identity fails to save, without reporting failure or posting twice', async () => {
        const originalSet = mockRedis.set.getMockImplementation();
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (key.includes(':shared-result:') && !key.endsWith(':lock') && !options.nx) throw new Error('Redis temporarily unavailable');
            return originalSet(key, value, options);
        });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'shared' } });
        expect(JSON.parse(values.get(claimKey()))).not.toHaveProperty('postId');
        mockRedis.set.mockImplementation(originalSet);
        mockReddit.getPostsByUser.mockReturnValue({ all: async () => [publishedPost()] });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'already_shared' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('never recovers another author, community, campaign or an older result', async () => {
        mockReddit.submitCustomPost.mockRejectedValue(new Error('response connection lost'));
        mockReddit.getPostsByUser.mockReturnValue({ all: async () => [
            publishedPost({ authorName: 'OtherRacer' }),
            publishedPost({ subredditName: 'Elsewhere' }),
            publishedPost({ getPostData: async () => ({ postType: 'campaign-finished', seriesId: 'other-v1' }) }),
            publishedPost({ createdAt: new Date('2020-01-01') }),
        ] });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'share_unconfirmed' } });
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'share_unconfirmed' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('removes an app-authored fallback and fails closed instead of claiming user sharing', async () => {
        const fallback = publishedPost({ authorName: 'mini-racer' });
        mockReddit.submitCustomPost.mockResolvedValue(fallback);
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'user_action_unavailable' } });
        expect(fallback.delete).toHaveBeenCalledOnce();
        expect(claimKey()).toBeUndefined();
    });

    it('retains the claim if the wrong-author post cannot be removed', async () => {
        const fallback = publishedPost({ authorName: 'mini-racer', delete: vi.fn(async () => { throw new Error('delete failed'); }) });
        mockReddit.submitCustomPost.mockResolvedValue(fallback);
        await previewAndConfirm(input);
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'share_unconfirmed' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledOnce();
    });

    it('allows a fresh attempt only after a known refusal before posting', async () => {
        mockReddit.submitCustomPost.mockRejectedValueOnce(new Error('Failed to mint user action token'));
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'user_action_unavailable' } });
        expect(claimKey()).toBeUndefined();
        expect(await previewAndConfirm(input)).toMatchObject({ body: { status: 'shared' } });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledTimes(2);
    });

    it('does not post before a durable claim is written', async () => {
        const originalSet = mockRedis.set.getMockImplementation();
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (key.includes(':shared-result:') && !key.endsWith(':lock')) throw new Error('Redis unavailable');
            return originalSet(key, value, options);
        });
        await expect(previewAndConfirm(input)).rejects.toThrow('Redis unavailable');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });
});
