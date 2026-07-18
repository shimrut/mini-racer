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
        const getModerators = vi.fn(() => ({
            all: async () => [{ username: 'racemod' }],
        }));
        mockReddit.getSubredditByName.mockResolvedValue({ getModerators });

        await expect(resolveMenuTargetSubredditName('t5_mini')).resolves.toBe('MiniRacer');
        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(true);
        await expect(assertModeratorForSubreddit('MiniRacer')).resolves.toBe('RaceMod');
        expect(getModerators).toHaveBeenCalledWith({ limit: 1000, pageSize: 100 });
    });

    it('falls back to context subreddit name and trims whitespace', async () => {
        mockReddit.getSubredditInfoById.mockResolvedValue({ name: null });
        mockContext.readContextSubredditName.mockReturnValue('  ContextSub  ');
        await expect(resolveMenuTargetSubredditName('t5_blank')).resolves.toBe('ContextSub');

        mockReddit.getSubredditInfoById.mockResolvedValue({ name: '  ' });
        mockContext.readContextSubredditName.mockReturnValue('IgnoredFallback');
        await expect(resolveMenuTargetSubredditName('t5_spaces')).resolves.toBeNull();

        mockReddit.getSubredditInfoById.mockClear();
        mockContext.readContextSubredditName.mockReturnValue('PlainSub');
        await expect(resolveMenuTargetSubredditName('plain-name')).resolves.toBe('PlainSub');
        expect(mockReddit.getSubredditInfoById).not.toHaveBeenCalled();

        mockContext.readContextSubredditName.mockReturnValue('   ');
        await expect(resolveMenuTargetSubredditName('plain-name')).resolves.toBeNull();

        mockContext.readContextSubredditName.mockReturnValue(42);
        await expect(resolveMenuTargetSubredditName('plain-name')).resolves.toBeNull();
    });

    it('requires a matching moderator username and rejects empty lists', async () => {
        mockReddit.getSubredditByName.mockResolvedValue({
            getModerators: () => ({
                all: async () => [
                    { username: null },
                    { username: '  OtherMod  ' },
                    {},
                ],
            }),
        });
        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(false);

        mockReddit.getSubredditByName.mockResolvedValue({
            getModerators: () => ({
                all: async () => [{ username: '  RaceMod  ' }],
            }),
        });
        await expect(isModeratorForSubreddit('MiniRacer', '  racemod  ')).resolves.toBe(true);
    });

    it('matches with some() so one valid moderator is enough among others', async () => {
        mockReddit.getSubredditByName.mockResolvedValue({
            getModerators: () => ({
                all: async () => [
                    null,
                    { username: 12 },
                    { username: 'someone-else' },
                    { username: 'RaceMod' },
                ],
            }),
        });
        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(true);
    });

    it('treats a missing username property as non-matching without throwing', async () => {
        mockReddit.getSubredditByName.mockResolvedValue({
            getModerators: () => ({
                all: async () => [Object.create(null)],
            }),
        });
        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(false);
    });

    it('fails moderator authorization when Reddit cannot verify access', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockReddit.getSubredditByName.mockRejectedValue(new Error('unavailable'));

        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(
            'Failed to verify moderator access for r/MiniRacer:',
            expect.any(Error),
        );
        await expect(assertModeratorForSubreddit('MiniRacer')).rejects.toThrow(
            'Moderator access required for r/MiniRacer.',
        );
    });

    it('rejects assertModerator when Reddit provides no acting username', async () => {
        mockContext.getRequestUsername.mockReturnValue(null);
        await expect(assertModeratorForSubreddit('MiniRacer')).rejects.toThrow(
            'Reddit did not provide the acting username.',
        );
        expect(mockReddit.getSubredditByName).not.toHaveBeenCalled();
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
