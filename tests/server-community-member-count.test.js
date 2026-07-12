import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis, mockReddit } = vi.hoisted(() => ({
    mockRedis: {
        get: vi.fn(),
        set: vi.fn(),
    },
    mockReddit: {
        getSubredditInfoById: vi.fn(),
        getSubredditInfoByName: vi.fn(),
    },
}));

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('@devvit/web/server', () => ({ reddit: mockReddit }));

const { getCommunityMemberCount } = await import('../src/server/community-member-count.ts');

describe('leaderboard community member count', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.set.mockResolvedValue('OK');
    });

    it('fetches the public subscriber count once and caches it for later standings requests', async () => {
        mockReddit.getSubredditInfoById.mockResolvedValue({ subscribersCount: 321 });

        const first = await getCommunityMemberCount({
            subredditId: 't5_mini',
            subredditName: 'MiniRacerGame',
        });

        expect(first).toBe(321);
        expect(mockReddit.getSubredditInfoById).toHaveBeenCalledWith('t5_mini');
        expect(mockReddit.getSubredditInfoByName).not.toHaveBeenCalled();
        expect(mockRedis.set).toHaveBeenCalledWith(
            'dailygp:community-member-count:id:t5_mini',
            '321',
            { expiration: expect.any(Date) },
        );

        mockRedis.get.mockResolvedValue('321');
        const cached = await getCommunityMemberCount({
            subredditId: 't5_mini',
            subredditName: 'MiniRacerGame',
        });

        expect(cached).toBe(321);
        expect(mockReddit.getSubredditInfoById).toHaveBeenCalledTimes(1);
    });

    it('uses the subreddit name only when an ID is unavailable', async () => {
        mockReddit.getSubredditInfoByName.mockResolvedValue({ subscribersCount: '42' });

        const count = await getCommunityMemberCount({ subredditName: 'MiniRacerGame' });

        expect(count).toBe(42);
        expect(mockReddit.getSubredditInfoByName).toHaveBeenCalledWith('MiniRacerGame');
        expect(mockRedis.set).toHaveBeenCalledWith(
            'dailygp:community-member-count:name:miniracergame',
            '42',
            { expiration: expect.any(Date) },
        );
    });

    it('leaves the leaderboard entry count as fallback when Reddit has no usable count', async () => {
        mockReddit.getSubredditInfoById.mockResolvedValue({ subscribersCount: 0 });

        await expect(getCommunityMemberCount({ subredditId: 't5_mini' })).resolves.toBeUndefined();
        expect(mockRedis.set).not.toHaveBeenCalled();
    });
});
