import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockReddit,
    mockRedis,
    mockContext,
    mockCommunityMemberCount,
} = vi.hoisted(() => ({
    mockReddit: {
        getSubredditInfoById: vi.fn(),
        getSubredditByName: vi.fn(),
        getPostById: vi.fn(),
        submitCustomPost: vi.fn(),
    },
    mockRedis: {
        hGet: vi.fn(),
        hSet: vi.fn(),
    },
    mockContext: {
        getRequestUsername: vi.fn(),
        readContextPostData: vi.fn(),
        readContextPostId: vi.fn(),
        readContextSubredditId: vi.fn(),
        readContextSubredditName: vi.fn(),
    },
    mockCommunityMemberCount: vi.fn(),
}));

vi.mock('@devvit/web/server', () => ({
    reddit: mockReddit,
    redis: mockRedis,
}));
vi.mock('../src/server/request-context.js', () => mockContext);
vi.mock('../src/server/community-member-count.js', () => ({
    getCommunityMemberCount: mockCommunityMemberCount,
}));

const {
    assertModeratorForSubreddit,
    isModeratorForSubreddit,
    resolveMenuTargetSubredditName,
} = await import('../src/server/moderator-access.ts');
const {
    ensureModeratorAnalyticsPostForSubreddit,
    resolveAnalyticsToolSubredditName,
} = await import('../src/server/moderator-analytics-post.ts');
const {
    getCommunityMemberTotalForLeaderboard,
    getPostSubredditContext,
} = await import('../src/server/community-context.ts');

describe('moderator and community workflows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.getRequestUsername.mockReturnValue('RaceMod');
        mockContext.readContextPostData.mockReturnValue(null);
        mockContext.readContextPostId.mockReturnValue(null);
        mockContext.readContextSubredditId.mockReturnValue(null);
        mockContext.readContextSubredditName.mockReturnValue(null);
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hSet.mockResolvedValue(1);
        mockCommunityMemberCount.mockResolvedValue(321);
    });

    it('resolves menu subreddit targets and matches moderators case-insensitively', async () => {
        mockReddit.getSubredditInfoById.mockResolvedValue({ name: 'MiniRacer' });
        mockReddit.getSubredditByName.mockResolvedValue({
            getModerators: () => ({
                all: async () => [{ username: 'racemod' }],
            }),
        });

        await expect(resolveMenuTargetSubredditName('t5_mini')).resolves.toBe('MiniRacer');
        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(true);
        await expect(assertModeratorForSubreddit('MiniRacer')).resolves.toBe('RaceMod');
    });

    it('fails moderator authorization when Reddit cannot verify access', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mockReddit.getSubredditByName.mockRejectedValue(new Error('unavailable'));

        await expect(assertModeratorForSubreddit('MiniRacer')).rejects.toThrow(
            'Moderator access required for r/MiniRacer.',
        );
    });

    it('reuses a stored moderator analytics post and refreshes its URL', async () => {
        mockRedis.hGet.mockResolvedValue(JSON.stringify({
            postId: 't3_analytics',
            postUrl: 'https://reddit.com/old',
            updatedAt: '2026-07-15T00:00:00.000Z',
        }));
        mockReddit.getPostById.mockResolvedValue({
            url: 'https://reddit.com/new',
        });

        await expect(
            ensureModeratorAnalyticsPostForSubreddit('MiniRacer'),
        ).resolves.toEqual({
            created: false,
            postUrl: 'https://reddit.com/new',
        });
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            'dailygp:mod-analytics:posts',
            { MiniRacer: expect.stringContaining('https://reddit.com/new') },
        );
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('creates, locks, removes, and stores a moderator analytics post', async () => {
        const post = {
            id: 't3_analytics',
            url: 'https://reddit.com/analytics',
            lock: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
        };
        mockReddit.submitCustomPost.mockResolvedValue(post);

        await expect(
            ensureModeratorAnalyticsPostForSubreddit('MiniRacer'),
        ).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/analytics',
        });
        expect(post.lock).toHaveBeenCalledTimes(1);
        expect(post.remove).toHaveBeenCalledWith(false);
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            'dailygp:mod-analytics:posts',
            { MiniRacer: expect.stringContaining('"postId":"t3_analytics"') },
        );
    });

    it('resolves analytics and member-count subreddit context through documented fallbacks', async () => {
        mockContext.readContextPostData.mockReturnValue({ subredditName: 'PostDataSub' });
        await expect(resolveAnalyticsToolSubredditName()).resolves.toBe('PostDataSub');

        mockContext.readContextPostData.mockReturnValue(null);
        mockContext.readContextPostId.mockReturnValue('t3_daily');
        mockReddit.getPostById.mockResolvedValue({
            subredditId: 't5_mini',
            subredditName: 'MiniRacer',
        });
        await expect(getPostSubredditContext()).resolves.toEqual({
            id: 't5_mini',
            name: 'MiniRacer',
        });
        await expect(getCommunityMemberTotalForLeaderboard()).resolves.toBe(321);
        expect(mockCommunityMemberCount).toHaveBeenCalledWith({
            subredditId: 't5_mini',
            subredditName: 'MiniRacer',
        });
    });
});
