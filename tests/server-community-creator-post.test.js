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
    readContextPostData: vi.fn(),
    readContextSubredditName: vi.fn(),
};
const mockLocks = {
    acquireRedisLock: vi.fn(async () => ({ key: 'lock', value: 'mine', ttlMs: 60_000 })),
    releaseRedisLock: vi.fn(async () => true),
};

vi.mock('@devvit/web/server', () => ({ reddit: mockReddit, redis: mockRedis }));
vi.mock('../src/server/request/request-context.js', () => mockContext);
vi.mock('../src/server/redis/redis-lock.js', () => mockLocks);

const {
    ensureCommunityCreatorPostForSubreddit,
    resolveCreatorToolSubredditName,
} = await import('../src/server/moderator/community-creator-post.ts');

beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.hGet.mockResolvedValue(null);
    mockContext.readContextPostData.mockReturnValue(null);
    mockContext.readContextSubredditName.mockReturnValue('MiniRacer');
});

describe('Community Creator host post', () => {
    it('creates one Creator post and leaves it up so it can open full screen', async () => {
        const post = {
            id: 't3_creator',
            url: 'https://reddit.com/creator',
            lock: vi.fn(),
            remove: vi.fn(),
        };
        mockReddit.submitCustomPost.mockResolvedValue(post);
        await expect(ensureCommunityCreatorPostForSubreddit('MiniRacer')).resolves.toEqual({
            created: true,
            postUrl: post.url,
        });
        expect(mockLocks.acquireRedisLock).toHaveBeenCalled();
        expect(mockReddit.submitCustomPost).toHaveBeenCalledWith(expect.objectContaining({
            subredditName: 'MiniRacer',
            entry: 'map-creator',
            postData: { tool: 'community-creator', subredditName: 'MiniRacer' },
        }));
        expect(post.lock).toHaveBeenCalled();
        expect(post.remove).not.toHaveBeenCalled();
        expect(mockRedis.hSet).toHaveBeenCalled();
        expect(mockLocks.releaseRedisLock).toHaveBeenCalled();
    });

    it('puts a removed Creator post back so it can open full screen', async () => {
        const post = {
            url: 'https://reddit.com/creator',
            removed: true,
            approve: vi.fn(),
        };
        mockRedis.hGet.mockResolvedValue(JSON.stringify({
            postId: 't3_creator',
            postUrl: 'https://reddit.com/creator',
        }));
        mockReddit.getPostById.mockResolvedValue(post);
        await expect(ensureCommunityCreatorPostForSubreddit('MiniRacer')).resolves.toEqual({
            created: false,
            postUrl: post.url,
        });
        expect(post.approve).toHaveBeenCalled();
    });

    it('reuses the existing Creator post', async () => {
        mockRedis.hGet.mockResolvedValue(JSON.stringify({
            postId: 't3_creator',
            postUrl: 'https://reddit.com/creator',
        }));
        mockReddit.getPostById.mockResolvedValue({ url: 'https://reddit.com/creator' });
        await expect(ensureCommunityCreatorPostForSubreddit('MiniRacer')).resolves.toEqual({
            created: false,
            postUrl: 'https://reddit.com/creator',
        });
        expect(mockReddit.submitCustomPost).not.toHaveBeenCalled();
    });

    it('rejects a mismatched tool context and accepts the Creator post', () => {
        mockContext.readContextPostData.mockReturnValue({ tool: 'game', subredditName: 'MiniRacer' });
        expect(resolveCreatorToolSubredditName()).toBeNull();
        mockContext.readContextPostData.mockReturnValue({
            tool: 'community-creator',
            subredditName: 'OtherSub',
        });
        expect(resolveCreatorToolSubredditName()).toBeNull();
        mockContext.readContextPostData.mockReturnValue({
            tool: 'community-creator',
            subredditName: 'MiniRacer',
        });
        expect(resolveCreatorToolSubredditName()).toBe('MiniRacer');
    });
});
