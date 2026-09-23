import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockReddit,
    mockShare,
    mockPostStore,
    mockAutopostStore,
    mockContext,
    mockShareImage,
    mockStore,
    mockPostFlair,
} = vi.hoisted(() => ({
    mockReddit: {
        submitCustomPost: vi.fn(),
        setPostFlair: vi.fn(),
        getPostById: vi.fn(),
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
        readContextPostData: vi.fn(),
        readContextPostId: vi.fn(),
    },
    mockShareImage: {
        resolveDailyShareImageUrl: vi.fn(),
    },
    mockStore: {
        getServerDailyGpChallengeById: vi.fn(),
        persistServerDailyGpChallenge: vi.fn(),
    },
    mockPostFlair: { resolveMiniRacerPostFlairId: vi.fn() },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));
vi.mock('../src/server/daily/daily-gp-share.js', () => mockShare);
vi.mock('../src/server/daily/daily-gp-post-store.js', () => mockPostStore);
vi.mock('../src/server/daily/daily-autopost-store.js', () => mockAutopostStore);
vi.mock('../src/server/request/request-context.js', () => mockContext);
vi.mock('../src/server/posts/share-image.js', () => mockShareImage);
vi.mock('../src/server/daily/daily-gp-store.js', () => mockStore);
vi.mock('../src/server/posts/post-flair-service.js', () => mockPostFlair);

const { mockRedis } = vi.hoisted(() => ({
    mockRedis: {
        get: vi.fn(),
        set: vi.fn(),
        expire: vi.fn(),
        del: vi.fn(),
        watch: vi.fn(),
    },
}));

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));

const {
    enableDailyAutopost,
    ensureDailyMiniRacerPostForSubreddit,
} = await import('../src/server/daily/daily-post-service.ts');
const {
    readDailyGpPodiumPendingSnapshot,
    readDailyGpPodiumPostRecord,
} = await import('../src/server/podium/daily-podium-post-store.ts');
const {
    getPostBoundDailyGpChallenge,
    normalizePostBoundDailyGpChallenge,
} = await import('../src/server/posts/post-bound-challenge.ts');

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

describe('server mutation soft spots wave 6', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.getRequestAppSlug.mockReturnValue('mini-racer');
        mockContext.readContextPostData.mockReturnValue(null);
        mockContext.readContextPostId.mockReturnValue(null);
        mockStore.persistServerDailyGpChallenge.mockImplementation(async (value) => value);
        mockStore.getServerDailyGpChallengeById.mockResolvedValue(null);
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
        mockShare.ensureDailyGpScoreThread.mockImplementation(async (record) => record);
        mockShare.registerDailyGpPostWithScoreThread.mockResolvedValue({});
        mockShareImage.resolveDailyShareImageUrl.mockReturnValue(null);
        mockPostFlair.resolveMiniRacerPostFlairId.mockResolvedValue('flair-daily-race');
        mockReddit.setPostFlair.mockResolvedValue(undefined);
        mockRedis.get.mockResolvedValue(null);
    });

    describe('daily-post-service', () => {
        it('preserves lastPostedAt when enabling autopost with prior history', async () => {
            const previous = {
                subredditName: 'MiniRacer',
                enabled: false,
                enabledAt: '2026-07-15T00:00:00.000Z',
                updatedAt: 'old',
                lastPostedChallengeId: challenge.id,
                lastPostedAt: '2026-07-16T00:10:00.000Z',
                lastPostUrl: 'https://reddit.com/post',
            };
            mockAutopostStore.upsertDailyAutopostSubscription.mockImplementation(
                async (_name, updater) => updater(previous),
            );

            await enableDailyAutopost('MiniRacer');
            const updater = mockAutopostStore.upsertDailyAutopostSubscription.mock.calls[0][1];
            expect(updater(previous)).toMatchObject({
                enabled: true,
                lastPostedAt: '2026-07-16T00:10:00.000Z',
                lastPostUrl: 'https://reddit.com/post',
            });
        });

        it('defaults enabled to false when creating a post without prior subscription state', async () => {
            mockReddit.submitCustomPost.mockResolvedValue({
                id: 't3_daily',
                url: 'https://reddit.com/daily',
            });
            let capturedSubscription = null;
            mockAutopostStore.upsertDailyAutopostSubscription.mockImplementation(
                async (_name, updater) => {
                    capturedSubscription = updater(null);
                    return capturedSubscription;
                },
            );

            await ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge);

            expect(capturedSubscription).toMatchObject({
                enabled: false,
                enabledAt: null,
                lastPostedChallengeId: challenge.id,
                lastPostUrl: 'https://reddit.com/daily',
            });
        });

        it('resolves raced posts with the exact lock-loss lookup arguments', async () => {
            const raced = {
                postUrl: 'https://reddit.com/raced',
                createdAt: '2026-07-16T00:05:00.000Z',
            };
            mockPostStore.acquireDailyGpPostCreationLock.mockResolvedValue(null);
            mockShare.resolveDailyGpPostRecord.mockResolvedValue(raced);

            await expect(
                ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge),
            ).resolves.toEqual({
                created: false,
                postUrl: raced.postUrl,
            });
            expect(mockShare.resolveDailyGpPostRecord).toHaveBeenCalledWith({
                subredditName: 'MiniRacer',
                challengeId: challenge.id,
                appSlug: 'mini-racer',
                preferredPostUrl: null,
            });
        });

        it('reuses an existing post with enabled defaults from prior subscription state', async () => {
            const existing = {
                postUrl: 'https://reddit.com/existing',
                createdAt: '2026-07-16T00:05:00.000Z',
            };
            const previous = {
                subredditName: 'MiniRacer',
                enabled: true,
                enabledAt: '2026-07-15T00:00:00.000Z',
                updatedAt: 'old',
                lastPostedChallengeId: 'daily-gp-2026-07-15',
                lastPostedAt: '2026-07-15T00:10:00.000Z',
                lastPostUrl: 'https://reddit.com/old',
            };
            mockShare.resolveDailyGpPostRecord.mockResolvedValue(existing);
            mockAutopostStore.readDailyAutopostSubscription.mockResolvedValue(previous);
            let capturedSubscription = null;
            mockAutopostStore.upsertDailyAutopostSubscription.mockImplementation(
                async (_name, updater) => {
                    capturedSubscription = updater(previous);
                    return capturedSubscription;
                },
            );

            await ensureDailyMiniRacerPostForSubreddit('MiniRacer', challenge);

            expect(capturedSubscription).toMatchObject({
                enabled: true,
                enabledAt: previous.enabledAt,
                lastPostedAt: existing.createdAt,
                lastPostUrl: existing.postUrl,
            });
        });
    });

    describe('daily-podium-post-store', () => {
        it('rejects pending snapshots missing required string fields', async () => {
            const base = {
                subredditName: 'MiniRacer',
                challengeId: 'daily-gp-2026-07-10',
                expiresAt: '2026-07-17T06:00:00.000Z',
                podium: {
                    challengeId: 'daily-gp-2026-07-10',
                    challengeDate: '2026-07-10',
                    trackName: 'Circuit',
                    positions: [1, 2, 3].map((rank) => ({
                        rank,
                        displayName: 'No verified finish',
                        identityType: 'empty',
                        formattedTime: null,
                        avatarUrl: null,
                    })),
                },
            };

            for (const patch of [
                { subredditName: null },
                { challengeId: 42 },
                { expiresAt: 'not-a-date' },
            ]) {
                mockRedis.get.mockResolvedValue(JSON.stringify({ ...base, ...patch }));
                await expect(
                    readDailyGpPodiumPendingSnapshot('MiniRacer', base.challengeId),
                ).resolves.toBeNull();
            }
        });

        it('rejects podium post records unless every required field is a non-empty string', async () => {
            const base = {
                subredditName: 'MiniRacer',
                challengeId: 'daily-gp-2026-07-10',
                postId: 't3_podium',
                postUrl: 'https://reddit.com/podium',
                createdAt: '2026-07-17T00:01:00.000Z',
            };

            for (const patch of [
                { subredditName: 7 },
                { challengeId: false },
                { postId: 'bad-id' },
                { postUrl: '' },
            ]) {
                mockRedis.get.mockResolvedValue(JSON.stringify({ ...base, ...patch }));
                await expect(
                    readDailyGpPodiumPostRecord('MiniRacer', base.challengeId),
                ).resolves.toBeNull();
            }
        });
    });

    describe('post-bound-challenge', () => {
        it('rejects normalization when string fields are empty rather than missing', () => {
            expect(normalizePostBoundDailyGpChallenge({
                ...challenge,
                id: '',
            })).toBeNull();
            expect(normalizePostBoundDailyGpChallenge({
                ...challenge,
                trackKey: '',
            })).toBeNull();
            expect(normalizePostBoundDailyGpChallenge({
                ...challenge,
                startsAt: '',
            })).toBeNull();
        });

        it('returns null when Reddit post data is missing entirely', async () => {
            mockContext.readContextPostId.mockReturnValue('t3_daily');
            mockReddit.getPostById.mockResolvedValue({
                getPostData: vi.fn(async () => null),
            });

            await expect(getPostBoundDailyGpChallenge()).resolves.toBeNull();
            expect(mockStore.getServerDailyGpChallengeById).not.toHaveBeenCalled();
        });

        it('ignores challengeId when post data is nullish', async () => {
            mockContext.readContextPostId.mockReturnValue('t3_daily');
            mockReddit.getPostById.mockResolvedValue({
                getPostData: vi.fn(async () => ({
                    challengeId: challenge.id,
                })),
            });
            mockStore.getServerDailyGpChallengeById.mockResolvedValue(challenge);

            await expect(getPostBoundDailyGpChallenge()).resolves.toEqual(challenge);
            expect(mockStore.getServerDailyGpChallengeById).toHaveBeenCalledWith(challenge.id);
        });
    });
});
