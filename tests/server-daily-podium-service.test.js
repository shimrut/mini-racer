import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReddit, mockAutopostStore, mockPostStore, mockContext } = vi.hoisted(() => ({
    mockReddit: {
        submitCustomPost: vi.fn(),
        getPostById: vi.fn(),
        getPostsByUser: vi.fn(),
        getSnoovatarUrl: vi.fn(),
    },
    mockAutopostStore: {
        readDailyPodiumAutopostSubscription: vi.fn(),
        upsertDailyPodiumAutopostSubscription: vi.fn(),
    },
    mockPostStore: {
        acquireDailyGpPodiumPostCreationLock: vi.fn(),
        deleteDailyGpPodiumPendingSnapshot: vi.fn(),
        readDailyGpPodiumPendingSnapshot: vi.fn(),
        readDailyGpPodiumPostRecord: vi.fn(),
        releaseDailyGpPodiumPostCreationLock: vi.fn(),
        writeDailyGpPodiumPostRecord: vi.fn(),
        writeDailyGpPodiumPendingSnapshot: vi.fn(),
    },
    mockContext: { getRequestAppSlug: vi.fn() },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));
vi.mock('../src/server/daily-podium-autopost-store.js', () => mockAutopostStore);
vi.mock('../src/server/daily-podium-post-store.js', () => mockPostStore);
vi.mock('../src/server/request-context.js', () => mockContext);

const {
    enableDailyPodiumAutopost,
    ensureDailyMiniRacerPodiumPostForSubreddit,
    formatDailyMiniRacerPodiumTextFallback,
    sanitizeDailyGpPodiumForPost,
} = await import('../src/server/daily-podium-service.ts');

const podium = {
    challengeId: 'daily-gp-2026-07-10',
    challengeDate: '2026-07-10',
    trackKey: 'circuit',
    trackName: 'Circuit ProMax',
    positions: [
        {
            rank: 1,
            displayName: 'RaceFan',
            identityType: 'reddit',
            formattedTime: '18.42s',
            playerId: 'reddit:racefan',
        },
        {
            rank: 2,
            displayName: 'Turbo Otter 42',
            identityType: 'private',
            formattedTime: '18.76s',
            profile: { secret: true },
        },
        {
            rank: 3,
            displayName: 'Neon Falcon',
            identityType: 'private',
            formattedTime: '18.91s',
        },
    ],
};

describe('daily podium post workflow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-17T00:01:00.000Z'));
        mockPostStore.readDailyGpPodiumPostRecord.mockResolvedValue(null);
        mockPostStore.readDailyGpPodiumPendingSnapshot.mockResolvedValue(null);
        mockPostStore.acquireDailyGpPodiumPostCreationLock.mockResolvedValue({
            key: 'lock',
            value: 'owner',
        });
        mockPostStore.releaseDailyGpPodiumPostCreationLock.mockResolvedValue(undefined);
        mockPostStore.writeDailyGpPodiumPostRecord.mockResolvedValue(undefined);
        mockPostStore.writeDailyGpPodiumPendingSnapshot.mockResolvedValue(undefined);
        mockPostStore.deleteDailyGpPodiumPendingSnapshot.mockResolvedValue(undefined);
        mockAutopostStore.readDailyPodiumAutopostSubscription.mockResolvedValue(null);
        mockAutopostStore.upsertDailyPodiumAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(null),
        );
        mockReddit.submitCustomPost.mockResolvedValue({
            id: 't3_podium',
            url: 'https://reddit.com/podium',
        });
        mockReddit.getPostById.mockResolvedValue({ id: 't3_existing' });
        mockReddit.getPostsByUser.mockReturnValue({ all: vi.fn(async () => []) });
        mockReddit.getSnoovatarUrl.mockResolvedValue('https://styles.redditmedia.com/avatar.png');
        mockContext.getRequestAppSlug.mockReturnValue('mini-racer');
    });

    it('enables podium automation while retaining its post history', async () => {
        const previous = {
            subredditName: 'MiniRacer',
            enabled: false,
            enabledAt: '2026-07-15T00:00:00.000Z',
            updatedAt: 'old',
            lastPostedChallengeId: podium.challengeId,
            lastPostedAt: '2026-07-17T00:01:00.000Z',
            lastPostUrl: 'https://reddit.com/podium',
        };
        mockAutopostStore.upsertDailyPodiumAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(previous),
        );

        await enableDailyPodiumAutopost('MiniRacer');
        const updater = mockAutopostStore.upsertDailyPodiumAutopostSubscription.mock.calls[0][1];
        expect(updater(previous)).toMatchObject({
            enabled: true,
            enabledAt: previous.enabledAt,
            lastPostedChallengeId: podium.challengeId,
            lastPostUrl: 'https://reddit.com/podium',
        });
    });

    it('creates an immutable sanitized custom post without a score thread', async () => {
        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/podium',
        });

        expect(mockReddit.submitCustomPost).toHaveBeenCalledWith({
            subredditName: 'MiniRacer',
            title: 'Mini Racer Podium, 10 Jul: Circuit ProMax',
            entry: 'podium',
            postData: {
                postType: 'daily-podium',
                challengeId: podium.challengeId,
                podium: {
                    challengeId: podium.challengeId,
                    challengeDate: podium.challengeDate,
                    trackName: podium.trackName,
                    positions: podium.positions.map(({ playerId, profile, ...position }) => ({
                        ...position,
                        avatarUrl: position.identityType === 'reddit'
                            ? 'https://styles.redditmedia.com/avatar.png'
                            : null,
                    })),
                },
            },
            textFallback: {
                text: expect.stringContaining('1. Gold - RaceFan - 18.42s'),
            },
        });
        const serializedPostData = JSON.stringify(
            mockReddit.submitCustomPost.mock.calls[0][0].postData,
        );
        expect(serializedPostData).not.toContain('playerId');
        expect(serializedPostData).not.toContain('profile');
        expect(serializedPostData).not.toContain('trackKey');
        expect(serializedPostData).not.toContain('timeSec');
        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledOnce();
        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledWith('RaceFan');
        expect(mockPostStore.writeDailyGpPodiumPendingSnapshot).toHaveBeenCalledWith({
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            expiresAt: '2026-07-17T06:00:00.000Z',
            podium: expect.objectContaining({
                challengeId: podium.challengeId,
                positions: expect.any(Array),
            }),
        });
        expect(mockPostStore.writeDailyGpPodiumPostRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                subredditName: 'MiniRacer',
                challengeId: podium.challengeId,
                postId: 't3_podium',
                postUrl: 'https://reddit.com/podium',
            }),
        );
        expect(mockPostStore.releaseDailyGpPodiumPostCreationLock).toHaveBeenCalledWith({
            key: 'lock',
            value: 'owner',
        });
    });

    it('reuses the frozen sanitized snapshot after a failed post attempt', async () => {
        const frozen = sanitizeDailyGpPodiumForPost(podium);
        mockPostStore.readDailyGpPodiumPendingSnapshot.mockResolvedValue({
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            expiresAt: '2026-07-17T06:00:00.000Z',
            podium: frozen,
        });
        const changed = structuredClone(podium);
        changed.positions[0].displayName = 'Changed Later';

        await ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', changed);

        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledWith('RaceFan');
        expect(mockReddit.getSnoovatarUrl).not.toHaveBeenCalledWith('Changed Later');
        expect(mockPostStore.writeDailyGpPodiumPendingSnapshot).not.toHaveBeenCalled();
        expect(mockPostStore.deleteDailyGpPodiumPendingSnapshot).toHaveBeenCalledWith(
            'MiniRacer',
            podium.challengeId,
        );
    });

    it('does not publish at or after the six-hour deadline', async () => {
        Date.now.mockReturnValue(Date.parse('2026-07-17T06:00:00.000Z'));

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('publication window has closed');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockPostStore.writeDailyGpPodiumPendingSnapshot).not.toHaveBeenCalled();
    });

    it.each([0, 1, 2])('fills missing podium position %s with a placeholder', (index) => {
        const incomplete = structuredClone(podium);
        incomplete.positions[index] = {
            rank: index + 1,
            displayName: '',
            identityType: 'empty',
            formattedTime: null,
        };

        const sanitized = sanitizeDailyGpPodiumForPost(incomplete);
        expect(sanitized.positions[index]).toEqual({
            rank: index + 1,
            displayName: 'No verified finish',
            identityType: 'empty',
            formattedTime: null,
            avatarUrl: null,
        });
        expect(formatDailyMiniRacerPodiumTextFallback(sanitized)).toContain(
            `${index + 1}. ${['Gold', 'Silver', 'Bronze'][index]} - No verified finish`,
        );
    });

    it('uses the generic client fallback when Reddit has no usable Snoovatar', async () => {
        mockReddit.getSnoovatarUrl.mockResolvedValue('javascript:alert(1)');

        await ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium);

        const postedPodium = mockReddit.submitCustomPost.mock.calls[0][0].postData.podium;
        expect(postedPodium.positions.map((position) => position.avatarUrl)).toEqual([
            null,
            null,
            null,
        ]);
    });

    it('still publishes with the generic fallback when Reddit avatar lookup fails', async () => {
        mockReddit.getSnoovatarUrl.mockRejectedValue(new Error('Reddit unavailable'));

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({ created: true, postUrl: 'https://reddit.com/podium' });

        expect(
            mockReddit.submitCustomPost.mock.calls[0][0].postData.podium.positions[0].avatarUrl,
        ).toBeNull();
    });

    it('reuses the canonical podium post without submitting another post', async () => {
        mockPostStore.readDailyGpPodiumPostRecord.mockResolvedValue({
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            postId: 't3_existing',
            postUrl: 'https://reddit.com/existing',
            createdAt: '2026-07-17T00:01:00.000Z',
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: 'https://reddit.com/existing',
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockPostStore.acquireDailyGpPodiumPostCreationLock).not.toHaveBeenCalled();
    });

    it('recovers only a discriminator-matched podium post after a missing Redis record', async () => {
        const unrelatedRacePost = {
            id: 't3_race',
            url: 'https://reddit.com/race',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({ challengeId: podium.challengeId })),
        };
        const recoveredPodium = {
            id: 't3_recovered',
            url: 'https://reddit.com/recovered-podium',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [unrelatedRacePost, recoveredPodium]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: recoveredPodium.url,
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockPostStore.writeDailyGpPodiumPostRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                postId: recoveredPodium.id,
                challengeId: podium.challengeId,
            }),
        );
    });

    it('reuses a canonical post created while acquiring the lock', async () => {
        const raced = {
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            postId: 't3_raced',
            postUrl: 'https://reddit.com/raced',
            createdAt: '2026-07-17T00:01:00.000Z',
        };
        mockPostStore.readDailyGpPodiumPostRecord
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(raced);

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: raced.postUrl,
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockAutopostStore.upsertDailyPodiumAutopostSubscription).toHaveBeenCalled();
        expect(mockPostStore.releaseDailyGpPodiumPostCreationLock).toHaveBeenCalledWith({
            key: 'lock',
            value: 'owner',
        });
    });

    it('reports lock contention when no raced canonical record is visible', async () => {
        mockPostStore.acquireDailyGpPodiumPostCreationLock.mockResolvedValue(null);
        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('already being created');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('allows only one Reddit submission across overlapping ensure calls', async () => {
        let finishSubmission;
        mockReddit.submitCustomPost.mockImplementation(() => new Promise((resolve) => {
            finishSubmission = () => resolve({
                id: 't3_podium',
                url: 'https://reddit.com/podium',
            });
        }));
        mockPostStore.acquireDailyGpPodiumPostCreationLock
            .mockResolvedValueOnce({ key: 'lock', value: 'owner' })
            .mockResolvedValueOnce(null);

        const first = ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium);
        await vi.waitFor(() => expect(mockReddit.submitCustomPost).toHaveBeenCalledTimes(1));
        const second = ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium);

        await expect(second).rejects.toThrow('already being created');
        finishSubmission();
        await expect(first).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/podium',
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledTimes(1);
    });

    it('releases the creation lock when Reddit returns an invalid post', async () => {
        mockReddit.submitCustomPost.mockResolvedValue({ id: 'invalid', url: '' });
        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('did not return the podium post identity');
        expect(mockPostStore.releaseDailyGpPodiumPostCreationLock).toHaveBeenCalledWith({
            key: 'lock',
            value: 'owner',
        });
    });
});
