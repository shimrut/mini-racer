import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockReddit,
    mockContext,
    mockServerContext,
    sharedCache,
} = vi.hoisted(() => ({
    mockReddit: {
        getSubredditInfoById: vi.fn(),
        getSubredditByName: vi.fn(),
    },
    mockContext: {
        getRequestUsername: vi.fn(),
        readContextSubredditName: vi.fn(),
    },
    // Without a subreddit in the context, the shared cache is not used.
    mockServerContext: { subredditId: undefined },
    sharedCache: new Map(),
}));

vi.mock('@devvit/web/server', () => ({
    reddit: mockReddit,
    context: mockServerContext,
    // Like Devvit's cache: keeps a returned value for its key, never a thrown read.
    cache: async (source, { key }) => {
        if (!sharedCache.has(key)) sharedCache.set(key, await source());
        return sharedCache.get(key);
    },
}));
vi.mock('../src/server/request/request-context.js', () => mockContext);

const {
    assertModeratorForSubreddit,
    isModeratorForSubreddit,
    resolveMenuTargetSubredditName,
} = await import('../src/server/moderator/moderator-access.ts');

describe('moderator workflows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sharedCache.clear();
        mockServerContext.subredditId = undefined;
        mockContext.getRequestUsername.mockReturnValue('RaceMod');
        mockContext.readContextSubredditName.mockReturnValue(null);
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


    it('shares the moderator list, so a second check does not call Reddit', async () => {
        mockServerContext.subredditId = 't5_mini';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockReddit.getSubredditByName.mockRejectedValueOnce(new Error('unavailable'));
        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(false);
        errorSpy.mockRestore();

        mockReddit.getSubredditByName.mockResolvedValue({
            getModerators: () => ({ all: async () => [{ username: 'RaceMod' }] }),
        });
        await expect(isModeratorForSubreddit('MiniRacer', 'RaceMod')).resolves.toBe(true);
        await expect(isModeratorForSubreddit('miniracer', 'OtherMod')).resolves.toBe(false);
        await expect(assertModeratorForSubreddit('MiniRacer')).resolves.toBe('RaceMod');
        // One failed read that was not kept, then one read for all three checks.
        expect(mockReddit.getSubredditByName).toHaveBeenCalledTimes(2);
    });
});
