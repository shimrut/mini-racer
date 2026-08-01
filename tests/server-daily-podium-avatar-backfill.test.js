import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReddit, mockRedis } = vi.hoisted(() => ({
    mockReddit: { getSnoovatarUrl: vi.fn() },
    mockRedis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit, redis: mockRedis }));
vi.mock('../src/server/daily-podium-autopost-store.js', () => ({
    readDailyPodiumAutopostSubscription: vi.fn(),
    upsertDailyPodiumAutopostSubscription: vi.fn(),
}));
vi.mock('../src/server/daily-podium-post-store.js', () => ({
    acquireDailyGpPodiumPostCreationLock: vi.fn(),
    readDailyGpPodiumPostRecord: vi.fn(),
    releaseDailyGpPodiumPostCreationLock: vi.fn(),
}));
vi.mock('../src/server/request-context.js', () => ({ getRequestAppSlug: vi.fn() }));

const { resolveLegacyDailyGpPodiumAvatars } = await import(
    '../src/server/daily-podium-avatar-backfill.ts'
);

describe('legacy daily podium avatar backfill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(undefined);
        mockRedis.set.mockResolvedValue(undefined);
        mockReddit.getSnoovatarUrl.mockResolvedValue(
            'https://styles.redditmedia.com/t5_avatar/styles/profileIcon.png',
        );
    });

    it('resolves only public Reddit positions and caches the safe result by post', async () => {
        await expect(resolveLegacyDailyGpPodiumAvatars('t3_podium', {
            positions: [
                { rank: 1, displayName: 'u/shimroot', identityType: 'reddit' },
                { rank: 2, displayName: 'Private Otter', identityType: 'private' },
                { rank: 3, displayName: 'No verified finish', identityType: 'empty' },
            ],
        })).resolves.toEqual([{
            rank: 1,
            avatarUrl: 'https://styles.redditmedia.com/t5_avatar/styles/profileIcon.png',
        }]);

        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledWith('shimroot');
        expect(mockReddit.getSnoovatarUrl).toHaveBeenCalledTimes(1);
        expect(mockRedis.set).toHaveBeenCalledWith(
            'dailygp:podium-avatar-backfill:v2:t3_podium',
            expect.stringContaining('profileIcon.png'),
            { expiration: expect.any(Date) },
        );
    });

    it('reuses a cached post backfill without another Reddit lookup', async () => {
        mockRedis.get.mockResolvedValue(JSON.stringify({
            positions: [{ rank: 1, avatarUrl: 'https://styles.redditmedia.com/cached.png' }],
        }));

        await expect(resolveLegacyDailyGpPodiumAvatars('t3_podium', {})).resolves.toEqual([
            { rank: 1, avatarUrl: 'https://styles.redditmedia.com/cached.png' },
        ]);
        expect(mockReddit.getSnoovatarUrl).not.toHaveBeenCalled();
    });
});
