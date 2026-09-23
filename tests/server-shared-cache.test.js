import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cache: vi.fn(),
    context: { subredditId: null },
}));

vi.mock('@devvit/web/server', () => ({
    cache: mocks.cache,
    context: mocks.context,
}));

const { cacheSharedJson } = await import('../src/server/redis/shared-cache.ts');

describe('shared Devvit cache adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.context.subredditId = null;
    });

    it('uses the source directly outside a Reddit request', async () => {
        const source = vi.fn(async () => ({ value: 42 }));

        await expect(cacheSharedJson(source, { key: 'standalone', ttl: 10 }))
            .resolves.toEqual({ value: 42 });
        expect(source).toHaveBeenCalledOnce();
        expect(mocks.cache).not.toHaveBeenCalled();
    });

    it('delegates to Devvit cache with the source and options in request context', async () => {
        mocks.context.subredditId = 'subreddit-1';
        const source = vi.fn(async () => ({ value: 42 }));
        mocks.cache.mockImplementation(async (cachedSource, options) => {
            expect(options).toEqual({ key: 'standings', ttl: 10 });
            return cachedSource();
        });

        await expect(cacheSharedJson(source, { key: 'standings', ttl: 10 }))
            .resolves.toEqual({ value: 42 });
        expect(mocks.cache).toHaveBeenCalledOnce();
        expect(source).toHaveBeenCalledOnce();
    });

    it('keeps a successful source result when cache storage fails afterward', async () => {
        mocks.context.subredditId = 'subreddit-1';
        const source = vi.fn(async () => ({ value: 42 }));
        mocks.cache.mockImplementation(async (cachedSource) => {
            await cachedSource();
            throw new Error('cache unavailable');
        });

        await expect(cacheSharedJson(source, { key: 'standings', ttl: 10 }))
            .resolves.toEqual({ value: 42 });
        expect(source).toHaveBeenCalledOnce();
    });

    it('retries the source when cache fails before invoking it', async () => {
        mocks.context.subredditId = 'subreddit-1';
        const source = vi.fn(async () => ({ value: 42 }));
        mocks.cache.mockRejectedValue(new Error('cache unavailable'));

        await expect(cacheSharedJson(source, { key: 'standings', ttl: 10 }))
            .resolves.toEqual({ value: 42 });
        expect(source).toHaveBeenCalledOnce();
    });

    it('preserves source errors instead of caching an error-derived null', async () => {
        mocks.context.subredditId = 'subreddit-1';
        const source = vi.fn(async () => {
            throw new Error('Reddit unavailable');
        });
        mocks.cache.mockImplementation((cachedSource) => cachedSource());

        await expect(cacheSharedJson(source, { key: 'avatar', ttl: 3600 }))
            .rejects.toThrow('Reddit unavailable');
        expect(source).toHaveBeenCalledOnce();
    });
});
