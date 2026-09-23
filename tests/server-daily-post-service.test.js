import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockReddit,
    mockShare,
    mockPostStore,
    mockAutopostStore,
    mockContext,
    mockShareImage,
    mockPostFlair,
} = vi.hoisted(() => ({
    mockReddit: {
        submitCustomPost: vi.fn(),
        setPostFlair: vi.fn(),
    },
    mockShare: {
        ensureDailyGpScoreThread: vi.fn(),
        registerDailyGpPostWithScoreThread: vi.fn(),
        resolveDailyGpPostRecord: vi.fn(),
    },
    mockPostStore: {
        acquireDailyGpPostCreationLock: vi.fn(),
        releaseDailyGpPostCreationLock: vi.fn(),
    },
    mockAutopostStore: {
        readDailyAutopostSubscription: vi.fn(),
        upsertDailyAutopostSubscription: vi.fn(),
    },
    mockContext: {
        getRequestAppSlug: vi.fn(),
        getRequestUsername: vi.fn(),
        readContextSubredditName: vi.fn(),
    },
    mockShareImage: {
        resolveDailyShareImageUrl: vi.fn(),
    },
    mockPostFlair: { resolveMiniRacerPostFlairId: vi.fn() },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));
vi.mock('../src/server/daily/daily-gp-share.js', () => mockShare);
vi.mock('../src/server/daily/daily-gp-post-store.js', () => mockPostStore);
vi.mock('../src/server/daily/daily-autopost-store.js', () => mockAutopostStore);
vi.mock('../src/server/request/request-context.js', () => mockContext);
vi.mock('../src/server/posts/share-image.js', () => mockShareImage);
vi.mock('../src/server/posts/post-flair-service.js', () => mockPostFlair);

const {
    enableDailyAutopost,
    ensureDailyMiniRacerPostForSubreddit,
    getDailyGpShareRequestContext,
} = await import('../src/server/daily/daily-post-service.ts');

const challenge = {
    id: 'daily-gp-2026-07-16',
    challengeDate: '2026-07-16',
    trackKey: 'circuit',
    startsAt: '2026-07-16T00:00:00.000Z',
    endsAt: '2026-07-17T00:00:00.000Z',
    availableUntil: '2026-07-23T00:00:00.000Z',
    status: 'active',
    objectiveType: 'single_lap_fastest',
    objectiveParams: {},
    skin: 'default',
};

describe('daily post workflow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.getRequestAppSlug.mockReturnValue('mini-racer');
        mockContext.getRequestUsername.mockReturnValue('RaceFan');
        mockContext.readContextSubredditName.mockReturnValue('MiniRacer');
        mockAutopostStore.readDailyAutopostSubscription.mockResolvedValue(null);
        mockAutopostStore.upsertDailyAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(null),
        );
        mockShare.resolveDailyGpPostRecord.mockResolvedValue(null);
        mockPostStore.acquireDailyGpPostCreationLock.mockResolvedValue({
            key: 'lock',
            value: 'value',
        });
        mockPostStore.releaseDailyGpPostCreationLock.mockResolvedValue(undefined);
        mockShare.registerDailyGpPostWithScoreThread.mockResolvedValue({});
        mockShareImage.resolveDailyShareImageUrl.mockReturnValue(null);
        mockPostFlair.resolveMiniRacerPostFlairId.mockResolvedValue('flair-daily-race');
        mockReddit.setPostFlair.mockResolvedValue(undefined);
    });

    it('enables autoposting while retaining existing post history', async () => {
        const previous = {
            subredditName: 'MiniRacer',
            enabled: false,
            enabledAt: null,
            updatedAt: 'old',
            lastPostedChallengeId: challenge.id,
            lastPostedAt: '2026-07-16T00:05:00.000Z',
            lastPostUrl: 'https://reddit.com/post',
        };
        mockAutopostStore.upsertDailyAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(previous),
        );

        await enableDailyAutopost('MiniRacer');
        const updater = mockAutopostStore.upsertDailyAutopostSubscription.mock.calls[0][1];
        expect(updater(previous)).toMatchObject({
            enabled: true,
            lastPostedChallengeId: challenge.id,
            lastPostUrl: 'https://reddit.com/post',
        });
    });

    it('reuses a canonical post and prepares its score thread', async () => {
        const existing = {
            postUrl: 'https://reddit.com/existing',
            createdAt: '2026-07-16T00:05:00.000Z',
        };
        mockShare.resolveDailyGpPostRecord.mockResolvedValue(existing);
        mockShare.ensureDailyGpScoreThread.mockResolvedValue(existing);

        await expect(
            ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
        ).resolves.toEqual({
            created: false,
            postUrl: existing.postUrl,
        });
        expect(mockShare.ensureDailyGpScoreThread).toHaveBeenCalledWith(existing, 'mini-racer');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('reports lock contention when no raced post can be recovered', async () => {
        mockPostStore.acquireDailyGpPostCreationLock.mockResolvedValue(null);

        await expect(
            ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
        ).rejects.toThrow('already being created');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('creates the canonical post, prepares its score thread, and releases the lock', async () => {
        mockReddit.submitCustomPost.mockResolvedValue({
            id: 't3_daily',
            url: 'https://reddit.com/daily',
        });

        await expect(
            ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/daily',
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledWith(
            expect.objectContaining({
                subredditName: 'MiniRacer',
                entry: 'default',
                postData: expect.objectContaining({ postType: 'daily-race' }),
            }),
        );
        expect(mockReddit.submitCustomPost.mock.calls[0][0]).not.toHaveProperty('flairId');
        expect(mockReddit.setPostFlair).toHaveBeenCalledWith({
            subredditName: 'MiniRacer',
            postId: 't3_daily',
            flairTemplateId: 'flair-daily-race',
        });
        expect(mockReddit.submitCustomPost.mock.calls[0][0].styles).toBeUndefined();
        expect(mockShare.registerDailyGpPostWithScoreThread).toHaveBeenCalledWith({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/daily',
            appSlug: 'mini-racer',
        });
        expect(mockPostStore.releaseDailyGpPostCreationLock).toHaveBeenCalledWith({
            key: 'lock',
            value: 'value',
        });
    });

    it('still reports the daily post as created when the app cannot set its flair', async () => {
        mockReddit.submitCustomPost.mockResolvedValue({
            id: 't3_daily',
            url: 'https://reddit.com/daily',
        });
        mockReddit.setPostFlair.mockRejectedValueOnce(new Error('flair refused'));
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await expect(
                ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
            ).resolves.toEqual({
                created: true,
                postUrl: 'https://reddit.com/daily',
            });
            expect(error).toHaveBeenCalledWith(
                'Daily post was created without its flair:',
                expect.any(Error),
            );
        } finally {
            error.mockRestore();
        }
    });

    it('attaches the track share image URL when the asset resolves', async () => {
        mockShareImage.resolveDailyShareImageUrl.mockReturnValue(
            'https://i.redd.it/circuit-share.jpg',
        );
        mockReddit.submitCustomPost.mockResolvedValue({
            id: 't3_daily',
            url: 'https://reddit.com/daily',
        });

        await ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge);

        expect(mockShareImage.resolveDailyShareImageUrl).toHaveBeenCalledWith('circuit');
        expect(mockReddit.submitCustomPost).toHaveBeenCalledWith(
            expect.objectContaining({
                styles: { shareImageUrl: 'https://i.redd.it/circuit-share.jpg' },
            }),
        );
    });

    it('builds sharing context from the request adapter and stored canonical post', async () => {
        mockAutopostStore.readDailyAutopostSubscription.mockResolvedValue({
            lastPostUrl: 'https://reddit.com/daily',
        });

        await expect(getDailyGpShareRequestContext()).resolves.toEqual({
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            appSlug: 'mini-racer',
            preferredPostUrl: 'https://reddit.com/daily',
        });
    });

    it('requires the app slug before creating a daily post', async () => {
        mockContext.getRequestAppSlug.mockReturnValue(null);
        await expect(
            ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
        ).rejects.toThrow('did not provide the Mini Racer app identity');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('reuses a raced canonical post when lock acquisition fails', async () => {
        const raced = {
            postUrl: 'https://reddit.com/raced',
            createdAt: '2026-07-16T00:05:00.000Z',
        };
        mockPostStore.acquireDailyGpPostCreationLock.mockResolvedValue(null);
        mockShare.resolveDailyGpPostRecord.mockResolvedValue(raced);
        mockShare.ensureDailyGpScoreThread.mockResolvedValue(raced);

        await expect(
            ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
        ).resolves.toEqual({
            created: false,
            postUrl: raced.postUrl,
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('reuses a canonical post created while holding the lock', async () => {
        const raced = {
            postUrl: 'https://reddit.com/raced',
            createdAt: '2026-07-16T00:05:00.000Z',
        };
        mockShare.resolveDailyGpPostRecord
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(raced);
        mockShare.ensureDailyGpScoreThread.mockResolvedValue(raced);

        await expect(
            ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
        ).resolves.toEqual({
            created: false,
            postUrl: raced.postUrl,
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockPostStore.releaseDailyGpPostCreationLock).toHaveBeenCalled();
    });

    it('releases the creation lock when Reddit returns an invalid post identity', async () => {
        mockReddit.submitCustomPost.mockResolvedValue({ id: 'invalid', url: 'https://reddit.com/bad' });
        await expect(
            ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
        ).rejects.toThrow('did not return the daily post identity');
        expect(mockPostStore.releaseDailyGpPostCreationLock).toHaveBeenCalledWith({
            key: 'lock',
            value: 'value',
        });
    });

    it('preserves enabledAt when enabling autopost and falls back when absent', async () => {
        const previous = {
            subredditName: 'MiniRacer',
            enabled: false,
            enabledAt: '2026-07-15T00:00:00.000Z',
            updatedAt: 'old',
            lastPostedChallengeId: null,
            lastPostedAt: null,
            lastPostUrl: null,
        };
        mockAutopostStore.upsertDailyAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(previous),
        );

        await enableDailyAutopost('MiniRacer');
        const withHistory = mockAutopostStore.upsertDailyAutopostSubscription.mock.calls[0][1];
        expect(withHistory(previous)).toMatchObject({
            enabled: true,
            enabledAt: previous.enabledAt,
            lastPostedChallengeId: null,
            lastPostedAt: null,
            lastPostUrl: null,
        });

        const fresh = withHistory(null);
        expect(fresh.enabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(fresh.lastPostedChallengeId).toBeNull();
    });

    it('passes preferredPostUrl when the subscription matches the challenge', async () => {
        mockAutopostStore.readDailyAutopostSubscription.mockResolvedValue({
            lastPostedChallengeId: challenge.id,
            lastPostUrl: 'https://reddit.com/preferred',
        });
        mockShare.resolveDailyGpPostRecord.mockResolvedValue({
            postUrl: 'https://reddit.com/preferred',
            createdAt: '2026-07-16T00:05:00.000Z',
        });
        mockShare.ensureDailyGpScoreThread.mockResolvedValue({
            postUrl: 'https://reddit.com/preferred',
            createdAt: '2026-07-16T00:05:00.000Z',
        });

        await ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge);

        expect(mockShare.resolveDailyGpPostRecord).toHaveBeenCalledWith({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            appSlug: 'mini-racer',
            preferredPostUrl: 'https://reddit.com/preferred',
        });
    });

    it('preserves lastPostedAt when reusing the same challenge', async () => {
        const existing = {
            postUrl: 'https://reddit.com/existing',
            createdAt: '2026-07-16T00:05:00.000Z',
        };
        const previous = {
            subredditName: 'MiniRacer',
            enabled: true,
            enabledAt: '2026-07-15T00:00:00.000Z',
            updatedAt: 'old',
            lastPostedChallengeId: challenge.id,
            lastPostedAt: '2026-07-16T00:10:00.000Z',
            lastPostUrl: 'https://reddit.com/existing',
        };
        mockShare.resolveDailyGpPostRecord.mockResolvedValue(existing);
        mockShare.ensureDailyGpScoreThread.mockResolvedValue(existing);
        mockAutopostStore.upsertDailyAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(previous),
        );

        await ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge);
        const updater = mockAutopostStore.upsertDailyAutopostSubscription.mock.calls[0][1];
        expect(updater(previous)).toMatchObject({
            enabled: true,
            enabledAt: previous.enabledAt,
            lastPostedChallengeId: challenge.id,
            lastPostedAt: previous.lastPostedAt,
            lastPostUrl: existing.postUrl,
        });
    });

    it('rejects Reddit posts without t3_ ids or string urls', async () => {
        const invalidPosts = [
            { id: 'not-a-post', url: 'https://reddit.com/daily' },
            { id: 't3_daily', url: 42 },
            { id: 't3_daily' },
        ];
        for (const post of invalidPosts) {
            mockReddit.submitCustomPost.mockResolvedValue(post);
            await expect(
                ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
            ).rejects.toThrow('did not return the daily post identity');
        }
        expect(mockShare.registerDailyGpPostWithScoreThread).not.toHaveBeenCalled();
    });

    it('returns null sharing context when the request has no subreddit', async () => {
        mockContext.readContextSubredditName.mockReturnValue(null);
        await expect(getDailyGpShareRequestContext()).resolves.toEqual({
            username: 'RaceFan',
            subredditName: null,
            appSlug: 'mini-racer',
            preferredPostUrl: null,
        });
        expect(mockAutopostStore.readDailyAutopostSubscription).not.toHaveBeenCalled();
    });
});
