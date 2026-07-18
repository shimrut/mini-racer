import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockReddit,
    mockContext,
    mockCommunityMemberCount,
} = vi.hoisted(() => ({
    mockReddit: {
        getSubredditInfoById: vi.fn(),
        getSubredditByName: vi.fn(),
        getPostById: vi.fn(),
        submitCustomPost: vi.fn(),
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

    it('resolves member-count subreddit context through documented fallbacks', async () => {
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
