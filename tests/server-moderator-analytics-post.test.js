import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedis = {
    hGet: vi.fn(),
    hSet: vi.fn(),
};
const mockReddit = {
    getPostById: vi.fn(),
    submitCustomPost: vi.fn(),
};
const mockContext = {
    readContextSubredditName: vi.fn(),
    readContextPostData: vi.fn(),
};

vi.mock('@devvit/web/server', () => ({
    reddit: mockReddit,
    redis: mockRedis,
}));
vi.mock('../src/server/request/request-context.js', () => mockContext);

describe('moderator analytics post', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.readContextSubredditName.mockReturnValue(null);
        mockContext.readContextPostData.mockReturnValue(null);
    });

    it('reuses the stored analytics post when Reddit still has it', async () => {
        mockRedis.hGet.mockResolvedValue(JSON.stringify({
            postId: 't3_analytics',
            postUrl: 'https://reddit.com/old',
            updatedAt: '2026-07-18T00:00:00.000Z',
        }));
        mockReddit.getPostById.mockResolvedValue({
            url: 'https://reddit.com/current',
        });
        const {
            ensureModeratorAnalyticsPostForSubreddit,
        } = await import('../src/server/moderator/moderator-analytics-post.ts');

        await expect(ensureModeratorAnalyticsPostForSubreddit('MiniRacer')).resolves.toEqual({
            created: false,
            postUrl: 'https://reddit.com/current',
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            'dailygp:mod-analytics:posts',
            expect.objectContaining({
                MiniRacer: expect.stringContaining('https://reddit.com/current'),
            }),
        );
    });

    it('creates, locks, and hides a new analytics post on the old Redis key', async () => {
        mockRedis.hGet.mockResolvedValue(null);
        const post = {
            id: 't3_new',
            url: 'https://reddit.com/new',
            lock: vi.fn(),
            remove: vi.fn(),
        };
        mockReddit.submitCustomPost.mockResolvedValue(post);
        const {
            ensureModeratorAnalyticsPostForSubreddit,
        } = await import('../src/server/moderator/moderator-analytics-post.ts');

        await expect(ensureModeratorAnalyticsPostForSubreddit('MiniRacer')).resolves.toEqual({
            created: true,
            postUrl: 'https://reddit.com/new',
        });
        expect(mockReddit.submitCustomPost).toHaveBeenCalledWith(expect.objectContaining({
            entry: 'mod-analytics',
            subredditName: 'MiniRacer',
        }));
        expect(post.lock).toHaveBeenCalled();
        expect(post.remove).toHaveBeenCalledWith(false);
    });

    it('resolves the tool subreddit from context or post data', async () => {
        const {
            resolveAnalyticsToolSubredditName,
        } = await import('../src/server/moderator/moderator-analytics-post.ts');

        mockContext.readContextSubredditName.mockReturnValue('FromContext');
        await expect(resolveAnalyticsToolSubredditName()).resolves.toBe('FromContext');

        mockContext.readContextSubredditName.mockReturnValue(null);
        mockContext.readContextPostData.mockReturnValue({ subredditName: 'FromPost' });
        await expect(resolveAnalyticsToolSubredditName()).resolves.toBe('FromPost');
    });
});
