import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockReddit,
    mockAutopostStore,
    mockPostStore,
    mockContext,
    mockSharedCache,
    mockSharedCacheValues,
    mockDailyGpStore,
    mockPostFlair,
} = vi.hoisted(() => ({
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
        writeDailyGpPodiumPostRecordIfAbsent: vi.fn(),
        writeDailyGpPodiumPendingSnapshot: vi.fn(),
    },
    mockContext: { getRequestAppSlug: vi.fn() },
    mockSharedCache: vi.fn(),
    mockSharedCacheValues: new Map(),
    mockDailyGpStore: {
        getServerFinalDailyGpPodiumGhosts: vi.fn(async () => null),
    },
    mockPostFlair: { resolveMiniRacerPostFlairId: vi.fn() },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));
vi.mock('../src/server/daily-podium-autopost-store.js', () => mockAutopostStore);
vi.mock('../src/server/daily-podium-post-store.js', () => mockPostStore);
vi.mock('../src/server/request-context.js', () => mockContext);
vi.mock('../src/server/shared-cache.js', () => ({ cacheSharedJson: mockSharedCache }));
vi.mock('../src/server/daily-gp-store.js', () => mockDailyGpStore);
vi.mock('../src/server/post-flair-service.js', () => mockPostFlair);

const {
    enableDailyPodiumAutopost,
    ensureDailyMiniRacerPodiumPostForSubreddit,
    formatDailyMiniRacerPodiumTextFallback,
    formatDailyMiniRacerPodiumTitle,
    getDailyGpPodiumPublicationDeadline,
    isDailyGpPodiumPublicationOpen,
    isRedditAvatarUrl,
    resolveRedditAvatarUrl,
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
        mockSharedCacheValues.clear();
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-17T00:01:00.000Z'));
        mockPostStore.readDailyGpPodiumPostRecord.mockResolvedValue(null);
        mockPostStore.readDailyGpPodiumPendingSnapshot.mockResolvedValue(null);
        mockPostStore.acquireDailyGpPodiumPostCreationLock.mockResolvedValue({
            key: 'lock',
            value: 'owner',
        });
        mockPostStore.releaseDailyGpPodiumPostCreationLock.mockResolvedValue(undefined);
        mockPostStore.writeDailyGpPodiumPostRecordIfAbsent.mockResolvedValue(true);
        mockPostStore.writeDailyGpPodiumPendingSnapshot.mockResolvedValue(undefined);
        mockPostStore.deleteDailyGpPodiumPendingSnapshot.mockResolvedValue(undefined);
        mockAutopostStore.readDailyPodiumAutopostSubscription.mockResolvedValue(null);
        mockAutopostStore.upsertDailyPodiumAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(null),
        );
        mockDailyGpStore.getServerFinalDailyGpPodiumGhosts.mockResolvedValue(null);
        mockPostFlair.resolveMiniRacerPostFlairId.mockResolvedValue('flair-daily-podium');
        mockReddit.submitCustomPost.mockResolvedValue({
            id: 't3_podium',
            url: 'https://reddit.com/podium',
        });
        mockReddit.getPostById.mockResolvedValue({ id: 't3_existing' });
        mockReddit.getPostsByUser.mockReturnValue({ all: vi.fn(async () => []) });
        mockReddit.getSnoovatarUrl.mockResolvedValue('https://styles.redditmedia.com/avatar.png');
        mockContext.getRequestAppSlug.mockReturnValue('mini-racer');
        mockSharedCache.mockImplementation(async (source, options) => {
            if (mockSharedCacheValues.has(options.key)) {
                return mockSharedCacheValues.get(options.key);
            }
            const value = await source();
            mockSharedCacheValues.set(options.key, value);
            return value;
        });
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
            flairId: 'flair-daily-podium',
            entry: 'podium',
            postData: {
                postType: 'daily-podium',
                challengeId: podium.challengeId,
                podium: {
                    challengeId: podium.challengeId,
                    challengeDate: podium.challengeDate,
                    trackName: podium.trackName,
                    lapCount: 1,
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
        expect(mockPostStore.writeDailyGpPodiumPostRecordIfAbsent).toHaveBeenCalledWith(
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

    it('packs verified ghosts into the post body the same way Head to Head does', async () => {
        const ghost = {
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: 50,
            origin: [0, 0, 0],
            deltas: [1, 0, 0],
        };
        mockDailyGpStore.getServerFinalDailyGpPodiumGhosts.mockResolvedValue({
            trackKey: 'circuit',
            trackFingerprint: 'track-fingerprint',
            ghosts: [
                { rank: 1, ghost },
                { rank: 2, ghost: null },
                { rank: 3, ghost: null },
            ],
        });

        await ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium);

        const submitted = mockReddit.submitCustomPost.mock.calls[0][0];
        expect(submitted.postData.replayDataHash).toMatch(/^[a-f0-9]{64}$/);
        expect(submitted.textFallback.text).toContain('Podium replay data:');
        expect(submitted.textFallback.text).toContain('MINIRACER-PODIUM-REPLAY-V1');
        expect(JSON.stringify(submitted.postData)).not.toContain('playerId');
        expect(JSON.stringify(submitted.postData)).not.toContain('trackKey');
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
        expect(mockPostStore.writeDailyGpPodiumPostRecordIfAbsent).toHaveBeenCalledWith(
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

    it('formats titles and fallback text with anchored challenge dates', () => {
        expect(formatDailyMiniRacerPodiumTitle(podium)).toBe(
            'Mini Racer Podium, 10 Jul: Circuit ProMax',
        );
        expect(formatDailyMiniRacerPodiumTitle({
            ...podium,
            challengeDate: '2026-13-40',
        })).toBe('Mini Racer Podium, 2026-13-40: Circuit ProMax');
        expect(formatDailyMiniRacerPodiumTitle({
            ...podium,
            challengeDate: '2026-07-10-extra',
        })).toBe('Mini Racer Podium, 2026-07-10-extra: Circuit ProMax');

        const sanitized = sanitizeDailyGpPodiumForPost(podium);
        const fallback = formatDailyMiniRacerPodiumTextFallback(sanitized);
        expect(fallback).toContain('Date: 10 Jul 2026');
        expect(fallback).toContain('1. Gold - RaceFan - 18.42s');
        expect(fallback).toContain('2. Silver - Turbo Otter 42 - 18.76s');
    });

    it('strips u/ prefixes for reddit podium names in fallback text', () => {
        const redditPodium = structuredClone(podium);
        redditPodium.positions[0].displayName = 'u/RaceFan';
        const fallback = formatDailyMiniRacerPodiumTextFallback(
            sanitizeDailyGpPodiumForPost(redditPodium),
        );
        expect(fallback).toContain('1. Gold - RaceFan - 18.42s');
        expect(fallback).not.toContain('u/RaceFan');
    });

    it('sanitizes whitespace-only and unsupported identity types', () => {
        const invalid = structuredClone(podium);
        invalid.positions[0] = {
            rank: 1,
            displayName: '   ',
            identityType: 'reddit',
            formattedTime: '18.42s',
        };
        invalid.positions[1] = {
            rank: 2,
            displayName: 'Ghost',
            identityType: 'guest',
            formattedTime: '18.76s',
        };
        const sanitized = sanitizeDailyGpPodiumForPost(invalid);
        expect(sanitized.positions[0].displayName).toBe('No verified finish');
        expect(sanitized.positions[1].displayName).toBe('No verified finish');
    });

    it('accepts only https Reddit-hosted avatar URLs on approved hostnames', () => {
        expect(isRedditAvatarUrl('https://styles.redditmedia.com/avatar.png')).toBe(true);
        expect(isRedditAvatarUrl('https://preview.redd.it/avatar.png')).toBe(true);
        expect(isRedditAvatarUrl('https://i.redd.it/avatar.png')).toBe(true);
        expect(isRedditAvatarUrl('https://www.redditstatic.com/avatar.png')).toBe(true);
        expect(isRedditAvatarUrl('http://styles.redditmedia.com/avatar.png')).toBe(false);
        expect(isRedditAvatarUrl('https://evil-redd.it/avatar.png')).toBe(false);
        expect(isRedditAvatarUrl('https://notreddit.com/avatar.png')).toBe(false);
        expect(isRedditAvatarUrl('javascript:alert(1)')).toBe(false);
        expect(isRedditAvatarUrl(null)).toBe(false);
        expect(isRedditAvatarUrl(42)).toBe(false);
    });

    it('resolves avatars only for reddit identities with approved urls', async () => {
        mockReddit.getSnoovatarUrl.mockResolvedValue('https://i.redd.it/avatar.png');
        await expect(resolveRedditAvatarUrl('u/RaceFan')).resolves.toBe(
            'https://i.redd.it/avatar.png',
        );
        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledWith('RaceFan');

        mockReddit.getSnoovatarUrl.mockResolvedValue('https://evil.com/avatar.png');
        await expect(resolveRedditAvatarUrl('DifferentFan')).resolves.toBeNull();
    });

    it('uses one normalized shared-cache key for equivalent Snoovatar lookups', async () => {
        mockReddit.getSnoovatarUrl.mockResolvedValue('https://i.redd.it/avatar.png');
        await resolveRedditAvatarUrl('  u/RaceFan  ');
        await resolveRedditAvatarUrl('racefan');

        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledOnce();
        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledWith('RaceFan');
        expect(mockSharedCache).toHaveBeenCalledTimes(2);
        expect(mockSharedCache.mock.calls.map(([, options]) => options)).toEqual([
            {
                key: 'mini-racer:snoovatar:v1:racefan',
                ttl: 60 * 60,
            },
            {
                key: 'mini-racer:snoovatar:v1:racefan',
                ttl: 60 * 60,
            },
        ]);
    });

    it('caches valid and absent Snoovatar results while preserving transient-error fallback', async () => {
        mockReddit.getSnoovatarUrl.mockResolvedValueOnce('https://i.redd.it/avatar.png');
        await expect(resolveRedditAvatarUrl('RaceFan')).resolves.toBe('https://i.redd.it/avatar.png');
        await expect(resolveRedditAvatarUrl('racefan')).resolves.toBe('https://i.redd.it/avatar.png');

        mockReddit.getSnoovatarUrl.mockResolvedValueOnce(null);
        await expect(resolveRedditAvatarUrl('NoAvatar')).resolves.toBeNull();
        await expect(resolveRedditAvatarUrl('noavatar')).resolves.toBeNull();

        mockReddit.getSnoovatarUrl.mockRejectedValueOnce(new Error('Reddit unavailable'));
        await expect(resolveRedditAvatarUrl('RetryLater')).resolves.toBeNull();
        mockReddit.getSnoovatarUrl.mockResolvedValueOnce('https://i.redd.it/retried.png');
        await expect(resolveRedditAvatarUrl('retrylater')).resolves.toBe(
            'https://i.redd.it/retried.png',
        );

        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledTimes(4);
        expect(mockSharedCache).toHaveBeenCalledTimes(6);
        expect(mockSharedCache.mock.calls.map(([, options]) => options.key)).toEqual([
            'mini-racer:snoovatar:v1:racefan',
            'mini-racer:snoovatar:v1:racefan',
            'mini-racer:snoovatar:v1:noavatar',
            'mini-racer:snoovatar:v1:noavatar',
            'mini-racer:snoovatar:v1:retrylater',
            'mini-racer:snoovatar:v1:retrylater',
        ]);
    });

    it('enables podium automation with a fresh enabledAt when no history exists', async () => {
        await enableDailyPodiumAutopost('MiniRacer');
        const updater = mockAutopostStore.upsertDailyPodiumAutopostSubscription.mock.calls[0][1];
        const created = updater(null);
        expect(created.enabled).toBe(true);
        expect(created.enabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(created.lastPostedChallengeId).toBeNull();
        expect(created.lastPostUrl).toBeNull();
    });

    it('discards a pending snapshot when its expiration no longer matches the deadline', async () => {
        mockPostStore.readDailyGpPodiumPendingSnapshot.mockResolvedValue({
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            expiresAt: '2026-07-17T05:00:00.000Z',
            podium: sanitizeDailyGpPodiumForPost(podium),
        });

        await ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium);

        expect(mockPostStore.deleteDailyGpPodiumPendingSnapshot).toHaveBeenCalledWith(
            'MiniRacer',
            podium.challengeId,
        );
        expect(mockPostStore.writeDailyGpPodiumPendingSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ expiresAt: '2026-07-17T06:00:00.000Z' }),
        );
    });

    it('prefers the subscription post url when recovering a canonical podium', async () => {
        const preferred = {
            id: 't3_preferred',
            url: 'https://reddit.com/preferred-podium',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        const alternate = {
            id: 't3_alternate',
            url: 'https://reddit.com/alternate-podium',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockAutopostStore.readDailyPodiumAutopostSubscription.mockResolvedValue({
            lastPostedChallengeId: podium.challengeId,
            lastPostUrl: preferred.url,
        });
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [alternate, preferred]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: preferred.url,
        });
        expect(mockPostStore.writeDailyGpPodiumPostRecordIfAbsent).toHaveBeenCalledWith(
            expect.objectContaining({ postId: preferred.id }),
        );
    });

    it('ignores recovered posts with invalid ids or urls', async () => {
        const invalid = {
            id: 'invalid',
            url: '',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [invalid]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/podium',
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalled();
    });

    it('matches recovered posts using normalized subreddit names', async () => {
        const recovered = {
            id: 't3_recovered',
            url: 'https://reddit.com/recovered-podium',
            subredditName: '  MINIRACER  ',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [recovered]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: recovered.url,
        });
    });

    it('opens the publication window only after day seven and before the six-hour deadline', () => {
        const deadline = getDailyGpPodiumPublicationDeadline(podium);
        expect(deadline?.toISOString()).toBe('2026-07-17T06:00:00.000Z');
        expect(isDailyGpPodiumPublicationOpen(
            podium,
            new Date('2026-07-17T00:00:00.000Z'),
        )).toBe(true);
        expect(isDailyGpPodiumPublicationOpen(
            podium,
            new Date('2026-07-16T23:59:59.999Z'),
        )).toBe(false);
        expect(isDailyGpPodiumPublicationOpen(
            podium,
            new Date('2026-07-17T06:00:00.000Z'),
        )).toBe(false);
        expect(getDailyGpPodiumPublicationDeadline({
            ...podium,
            challengeDate: 'not-a-date',
        })).toBeNull();
        expect(getDailyGpPodiumPublicationDeadline({
            ...podium,
            challengeDate: '2026-00-00',
        })).toBeNull();
    });

    it('requires the app slug before creating a podium post', async () => {
        mockContext.getRequestAppSlug.mockReturnValue(null);
        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('did not provide the Mini Racer app identity');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('recovers a stale stored record when Reddit no longer returns the post', async () => {
        const recoveredPodium = {
            id: 't3_recovered',
            url: 'https://reddit.com/recovered-podium',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockPostStore.readDailyGpPodiumPostRecord
            .mockResolvedValueOnce({
                subredditName: 'MiniRacer',
                challengeId: podium.challengeId,
                postId: 't3_stale',
                postUrl: 'https://reddit.com/stale',
                createdAt: '2026-07-17T00:01:00.000Z',
            })
            .mockResolvedValue(null);
        mockReddit.getPostById.mockRejectedValue(new Error('missing post'));
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [recoveredPodium]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: recoveredPodium.url,
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('reuses a raced canonical post when lock acquisition fails', async () => {
        const raced = {
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            postId: 't3_raced',
            postUrl: 'https://reddit.com/raced',
            createdAt: '2026-07-17T00:01:00.000Z',
        };
        mockPostStore.acquireDailyGpPodiumPostCreationLock.mockResolvedValue(null);
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
        expect(mockReddit.getPostsByUser).toHaveBeenCalledWith({
            username: 'mini-racer',
            sort: 'new',
            timeframe: 'month',
            limit: 100,
            pageSize: 100,
        });
    });

    it('preserves lastPostedAt when enabling autopost with prior history', async () => {
        const previous = {
            subredditName: 'MiniRacer',
            enabled: false,
            enabledAt: '2026-07-15T00:00:00.000Z',
            updatedAt: 'old',
            lastPostedChallengeId: 'daily-gp-2026-07-01',
            lastPostedAt: '2026-07-08T12:00:00.000Z',
            lastPostUrl: 'https://reddit.com/old',
        };
        mockAutopostStore.upsertDailyPodiumAutopostSubscription.mockImplementation(
            async (_name, updater) => updater(previous),
        );

        await enableDailyPodiumAutopost('MiniRacer');
        const updater = mockAutopostStore.upsertDailyPodiumAutopostSubscription.mock.calls[0][1];
        expect(updater(previous).lastPostedAt).toBe('2026-07-08T12:00:00.000Z');
    });

    it('updates podium subscription metadata after creating a post', async () => {
        await ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium);

        const updater = mockAutopostStore.upsertDailyPodiumAutopostSubscription.mock.calls.at(-1)[1];
        const sameChallenge = updater({
            enabled: true,
            enabledAt: '2026-06-01T00:00:00.000Z',
            lastPostedChallengeId: podium.challengeId,
            lastPostedAt: '2026-06-02T00:00:00.000Z',
        });
        expect(sameChallenge).toMatchObject({
            enabled: true,
            enabledAt: '2026-06-01T00:00:00.000Z',
            lastPostedChallengeId: podium.challengeId,
            lastPostedAt: '2026-06-02T00:00:00.000Z',
            lastPostUrl: 'https://reddit.com/podium',
        });

        const newChallenge = updater({
            enabled: false,
            enabledAt: null,
            lastPostedChallengeId: 'daily-gp-2026-06-01',
            lastPostedAt: '2026-06-01T00:00:00.000Z',
        });
        expect(newChallenge.enabled).toBe(false);
        expect(newChallenge.enabledAt).toBeNull();
        expect(newChallenge.lastPostedChallengeId).toBe(podium.challengeId);
        expect(newChallenge.lastPostedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(newChallenge.lastPostUrl).toBe('https://reddit.com/podium');
    });

    it('skips Reddit listing recovery when the stored record is still valid', async () => {
        mockPostStore.readDailyGpPodiumPostRecord.mockResolvedValue({
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            postId: 't3_existing',
            postUrl: 'https://reddit.com/existing',
            createdAt: '2026-07-17T00:01:00.000Z',
        });
        mockReddit.getPostById.mockResolvedValue({ id: 't3_existing' });

        await ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium);

        expect(mockReddit.getPostsByUser).not.toHaveBeenCalled();
    });

    it('creates a new post when Reddit listing recovery has no all() helper', async () => {
        mockReddit.getPostsByUser.mockResolvedValue({});

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/podium',
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalled();
    });

    it('ignores recovered posts from other subreddits', async () => {
        const foreign = {
            id: 't3_foreign',
            url: 'https://reddit.com/foreign-podium',
            subredditName: 'OtherSub',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [foreign]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/podium',
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalled();
    });

    it('ignores recovered posts with mismatched challenge ids or post types', async () => {
        const wrongType = {
            id: 't3_wrong-type',
            url: 'https://reddit.com/wrong-type',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-race',
                challengeId: podium.challengeId,
            })),
        };
        const wrongChallenge = {
            id: 't3_wrong-challenge',
            url: 'https://reddit.com/wrong-challenge',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: 'daily-gp-2026-06-01',
            })),
        };
        const throwing = {
            id: 't3_throws',
            url: 'https://reddit.com/throws',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => {
                throw new Error('unavailable');
            }),
        };
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [wrongType, wrongChallenge, throwing]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/podium',
        });
    });

    it('rejects recovered posts missing t3_ ids or non-empty urls', async () => {
        const missingPrefix = {
            id: 'abc123',
            url: 'https://reddit.com/missing-prefix',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        const emptyUrl = {
            id: 't3_empty-url',
            url: '',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [missingPrefix, emptyUrl]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/podium',
        });
    });

    it('returns an existing registry record without rewriting it during recovery', async () => {
        const existing = {
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            postId: 't3_existing',
            postUrl: 'https://reddit.com/existing',
            createdAt: '2026-07-17T00:01:00.000Z',
        };
        const recovered = {
            id: 't3_recovered',
            url: 'https://reddit.com/recovered',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockPostStore.readDailyGpPodiumPostRecord
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(existing);
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [recovered]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: existing.postUrl,
        });
        expect(mockPostStore.writeDailyGpPodiumPostRecordIfAbsent).not.toHaveBeenCalled();
    });

    it('reads the raced winner when registry write loses a race', async () => {
        const winner = {
            subredditName: 'MiniRacer',
            challengeId: podium.challengeId,
            postId: 't3_winner',
            postUrl: 'https://reddit.com/winner',
            createdAt: '2026-07-17T00:01:00.000Z',
        };
        const recovered = {
            id: 't3_recovered',
            url: 'https://reddit.com/recovered',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockPostStore.readDailyGpPodiumPostRecord
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(winner);
        mockPostStore.writeDailyGpPodiumPostRecordIfAbsent.mockResolvedValue(false);
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [recovered]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).resolves.toEqual({
            created: false,
            postUrl: winner.postUrl,
        });
    });

    it('throws when registry write loses a race with no canonical winner', async () => {
        const recovered = {
            id: 't3_recovered',
            url: 'https://reddit.com/recovered',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({
                postType: 'daily-podium',
                challengeId: podium.challengeId,
            })),
        };
        mockPostStore.readDailyGpPodiumPostRecord
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockPostStore.writeDailyGpPodiumPostRecordIfAbsent.mockResolvedValue(false);
        mockReddit.getPostsByUser.mockReturnValue({
            all: vi.fn(async () => [recovered]),
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('registry race left no canonical record');
    });

    it('rejects Reddit posts whose ids do not start with t3_ or urls are empty', async () => {
        mockReddit.submitCustomPost.mockResolvedValue({
            id: 'abc123',
            url: 'https://reddit.com/podium',
        });
        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('did not return the podium post identity');

        mockReddit.submitCustomPost.mockResolvedValue({
            id: 't3_podium',
            url: '',
        });
        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('did not return the podium post identity');
    });

    it('closes the publication window after lock acquisition but before avatar lookup', async () => {
        let now = Date.parse('2026-07-17T05:59:00.000Z');
        Date.now.mockImplementation(() => now);
        mockPostStore.readDailyGpPodiumPostRecord
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockReddit.getSnoovatarUrl.mockImplementation(async () => {
            now = Date.parse('2026-07-17T06:00:00.000Z');
            return 'https://styles.redditmedia.com/avatar.png';
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('publication window has closed');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('closes the publication window after avatar lookup but before submission', async () => {
        let now = Date.parse('2026-07-17T05:59:30.000Z');
        Date.now.mockImplementation(() => now);
        mockPostStore.readDailyGpPodiumPostRecord
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockReddit.getSnoovatarUrl.mockImplementation(async () => {
            now = Date.parse('2026-07-17T06:00:00.000Z');
            return 'https://styles.redditmedia.com/avatar.png';
        });

        await expect(
            ensureDailyMiniRacerPodiumPostForSubreddit('MiniRacer', podium),
        ).rejects.toThrow('publication window has closed');
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it.each([
        ['2026-01-01', '1 Jan'],
        ['2026-02-15', '15 Feb'],
        ['2026-03-20', '20 Mar'],
        ['2026-04-05', '5 Apr'],
        ['2026-05-10', '10 May'],
        ['2026-06-30', '30 Jun'],
        ['2026-07-10', '10 Jul'],
        ['2026-08-11', '11 Aug'],
        ['2026-09-12', '12 Sep'],
        ['2026-10-13', '13 Oct'],
        ['2026-11-14', '14 Nov'],
        ['2026-12-25', '25 Dec'],
    ])('formats anchored challenge date %s as %s', (challengeDate, expected) => {
        expect(formatDailyMiniRacerPodiumTitle({
            ...podium,
            challengeDate,
        })).toBe(`Mini Racer Podium, ${expected}: Circuit ProMax`);
    });

    it('returns raw challenge dates that fail anchored parsing or bounds checks', () => {
        const invalidDates = [
            'prefix2026-07-10',
            '2026-13-01',
            '2026-00-15',
            '2026-07-00',
            '2026-07-32',
        ];
        for (const challengeDate of invalidDates) {
            expect(formatDailyMiniRacerPodiumTitle({
                ...podium,
                challengeDate,
            })).toBe(`Mini Racer Podium, ${challengeDate}: Circuit ProMax`);
        }
        expect(formatDailyMiniRacerPodiumTitle({
            ...podium,
            challengeDate: '2026-07-31',
        })).toBe('Mini Racer Podium, 31 Jul: Circuit ProMax');
    });

    it('builds the full markdown fallback with newline separators', () => {
        const sanitized = sanitizeDailyGpPodiumForPost(podium);
        expect(formatDailyMiniRacerPodiumTextFallback(sanitized)).toBe([
            '# Mini Racer Final Podium',
            '',
            'Track: **Circuit ProMax**',
            'Date: 10 Jul 2026',
            'Race format: 1 lap',
            '',
            '1. Gold - RaceFan - 18.42s',
            '2. Silver - Turbo Otter 42 - 18.76s',
            '3. Bronze - Neon Falcon - 18.91s',
            '',
            'These are the final verified results after the track left the seven-day playable window.',
        ].join('\n'));
    });

    it('keeps private display names and omits time suffixes for empty finishes', () => {
        const incomplete = structuredClone(podium);
        incomplete.positions[1].displayName = 'u/ShouldStayHidden';
        incomplete.positions[2] = {
            rank: 3,
            displayName: '',
            identityType: 'empty',
            formattedTime: null,
        };
        const sanitized = sanitizeDailyGpPodiumForPost(incomplete);
        const fallback = formatDailyMiniRacerPodiumTextFallback(sanitized);
        expect(fallback).toContain('2. Silver - u/ShouldStayHidden - 18.76s');
        expect(fallback).toContain('3. Bronze - No verified finish');
        expect(fallback).not.toContain('No verified finish -');
    });

    it('sanitizes undefined positions and whitespace-only finish times', () => {
        const sparse = {
            ...podium,
            positions: [
                undefined,
                {
                    rank: 2,
                    displayName: 'Ghost',
                    identityType: 'private',
                    formattedTime: '   ',
                },
                null,
            ],
        };
        const sanitized = sanitizeDailyGpPodiumForPost(sparse);
        expect(sanitized.positions.map((position) => position.displayName)).toEqual([
            'No verified finish',
            'No verified finish',
            'No verified finish',
        ]);
    });

    it('accepts exact redd.it, redditmedia.com, and redditstatic.com avatar hosts', () => {
        expect(isRedditAvatarUrl('https://redd.it/avatar.png')).toBe(true);
        expect(isRedditAvatarUrl('https://redditmedia.com/avatar.png')).toBe(true);
        expect(isRedditAvatarUrl('https://redditstatic.com/avatar.png')).toBe(true);
        expect(isRedditAvatarUrl('not-a-url')).toBe(false);
        expect(isRedditAvatarUrl(undefined)).toBe(false);
    });

    it('normalizes a leading u/ prefix while preserving non-prefix text', async () => {
        mockReddit.getSnoovatarUrl.mockResolvedValue('https://i.redd.it/avatar.png');
        await resolveRedditAvatarUrl('prefix/u/RaceFan');
        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledWith('prefix/u/RaceFan');
    });
});
