import { beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
const redis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options = {}) => {
        if (options.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    expire: vi.fn(async () => true),
    del: vi.fn(async (key) => Number(strings.delete(key))),
    watch: vi.fn(async () => ({
        multi: async () => undefined,
        unwatch: async () => undefined,
        del: async (key) => Number(strings.delete(key)),
        exec: async () => [1],
        discard: async () => undefined,
    })),
};
const reddit = {
    getPostById: vi.fn(async () => ({ url: 'https://reddit.com/post' })),
    submitComment: vi.fn(async () => ({ id: 't1_result', authorName: 'Racer' })),
    getComments: vi.fn(async () => ({ all: async () => [] })),
};
vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ reddit }));
const { confirmHeadToHeadBrag } = await import('../src/server/head-to-head-brag.ts');
const { confirmHeadToHeadComment } = await import('../src/server/head-to-head-comment.ts');
const { writeHeadToHeadSharePreview } = await import('../src/server/head-to-head-share.ts');
const context = { username: 'Racer', subredditName: 'MiniRacer' };
const resultKey = (action) => `miniracer:head-to-head:shared:${action}:challenge:racer:9000`;
const previewFor = (action) => ({
    ...context,
    postId: 't3_challenge',
    commentText: 'Approved text',
    resultKey: resultKey(action),
});
const preview = previewFor('brag');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

describe.each([
    ['brag', confirmHeadToHeadBrag, 'shared', 'share_in_progress'],
    ['comment', confirmHeadToHeadComment, 'commented', 'comment_in_progress'],
])('%s confirmation safeguards', (action, confirm, successStatus, inProgressStatus) => {
    const key = `miniracer:head-to-head:${action}:preview:token`;
    const lockKey = `${resultKey(action)}:lock`;
    const preview = previewFor(action);
    const input = { shareToken: 'token' };
    beforeEach(() => {
        strings.clear();
        strings.set(key, JSON.stringify(preview));
        vi.clearAllMocks();
    });

    it('accepts older preview records and consumes their token once', async () => {
        strings.set(key, JSON.stringify({
            ...preview, challengeId: 'challenge', bestTimeMs: 9000,
            reportedTimeMs: 11000, differenceMs: 1000, createdAt: '2026-09-06',
        }));
        expect((await confirm(input, context)).body).toMatchObject({
            status: successStatus, commentText: preview.commentText,
            commentId: 't1_result', commentUrl: 'https://reddit.com/post',
        });
        expect((await confirm(input, context)).body.status).toBe('preview_expired');
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);
    });

    it('rejects a delayed confirmation whose token was consumed before it acquired the lock', async () => {
        const waiting = deferred();
        const resume = deferred();
        redis.set.mockImplementationOnce(async (lockKey, value) => {
            waiting.resolve();
            await resume.promise;
            if (strings.has(lockKey)) return '';
            strings.set(lockKey, value);
            return 'OK';
        });
        const delayed = confirm(input, context);
        await waiting.promise;
        expect((await confirm(input, context)).body.status).toBe(successStatus);
        resume.resolve();
        expect((await delayed).body.status).toBe('preview_expired');
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);
    });

    it('refuses a second confirmation while the first is posting', async () => {
        const waiting = deferred();
        const resume = deferred();
        reddit.submitComment.mockImplementationOnce(async () => {
            waiting.resolve();
            await resume.promise;
            return { id: 't1_result', authorName: 'Racer' };
        });
        const first = confirm(input, context);
        await waiting.promise;
        expect((await confirm(input, context)).body.status).toBe(inProgressStatus);
        resume.resolve();
        expect((await first).body.status).toBe(successStatus);
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);
    });

    it('does not post or remove another lease when ownership is lost during post lookup', async () => {
        reddit.getPostById.mockImplementationOnce(async () => {
            strings.set(lockKey, 'replacement-lease');
            return { url: 'https://reddit.com/post' };
        });
        expect((await confirm(input, context)).body.status).toBe(inProgressStatus);
        expect(reddit.submitComment).not.toHaveBeenCalled();
        expect(strings.has(key)).toBe(true);
        expect(strings.get(lockKey)).toBe('replacement-lease');
    });

    it.each([
        { username: 'OtherRacer', subredditName: 'MiniRacer' },
        { username: 'Racer', subredditName: 'OtherCommunity' },
    ])('keeps the token restricted to its account and community: %j', async (otherContext) => {
        expect((await confirm(input, otherContext)).body.status).toBe('share_forbidden');
        expect(reddit.submitComment).not.toHaveBeenCalled();
        expect(strings.has(key)).toBe(true);
    });

    it('leaves the preview available for retry when Reddit refuses the submission', async () => {
        reddit.submitComment.mockRejectedValueOnce(new Error('This user account is not valid'));
        await expect(confirm(input, context)).rejects.toThrow('This user account is not valid');
        expect(reddit.getComments).not.toHaveBeenCalled();
        expect(strings.has(lockKey)).toBe(false);
        expect((await confirm(input, context)).body.status).toBe(successStatus);
    });

    it('leaves the preview available when Reddit fails to mint an edge context', async () => {
        reddit.submitComment.mockRejectedValueOnce(new Error(
            '2 UNKNOWN: grpc invocation failed with status 2; failed to mint edge context: failed get refresh token: refresh token not found in cache',
        ));
        await expect(confirm(input, context)).rejects.toThrow('failed to mint edge context');
        expect(reddit.getComments).not.toHaveBeenCalled();
        expect((await confirm(input, context)).body.status).toBe(successStatus);
    });

    it('answers unconfirmed when Reddit fails in a way that may have posted', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        reddit.submitComment.mockRejectedValueOnce(new Error('Reddit unavailable'));
        expect(await confirm(input, context)).toMatchObject({
            status: 409, body: { status: 'comment_unconfirmed' },
        });
        // The record is there without a link, so the result is guarded by the thread, not the term.
        expect(JSON.parse(strings.get(resultKey(action)))).toMatchObject({
            commentText: 'Approved text', username: 'Racer',
        });
        error.mockRestore();
    });

    it('finds the comment an unconfirmed attempt left, and posts nothing', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        reddit.submitComment.mockRejectedValueOnce(new Error('Reddit unavailable'));
        expect((await confirm(input, context)).body.status).toBe('comment_unconfirmed');
        reddit.getComments.mockResolvedValueOnce({
            all: async () => [{
                id: 't1_live',
                url: 'https://reddit.com/live',
                authorName: 'Racer',
                body: 'Approved text',
                createdAt: new Date(),
            }],
        });

        expect((await confirm(input, context)).body).toMatchObject({
            status: successStatus, commentId: 't1_live', commentUrl: 'https://reddit.com/live',
        });
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });

    it('posts once more when the thread shows the unconfirmed attempt never landed', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        reddit.submitComment.mockRejectedValueOnce(new Error('Reddit unavailable'));
        expect((await confirm(input, context)).body.status).toBe('comment_unconfirmed');

        expect((await confirm(input, context)).body.status).toBe(successStatus);
        expect(reddit.submitComment).toHaveBeenCalledTimes(2);
        error.mockRestore();
    });

    it('answers unconfirmed again when the thread cannot be read', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        reddit.submitComment.mockRejectedValueOnce(new Error('Reddit unavailable'));
        reddit.getComments.mockRejectedValueOnce(new Error('listing unavailable'));
        expect((await confirm(input, context)).body.status).toBe('comment_unconfirmed');
        reddit.getComments.mockRejectedValueOnce(new Error('listing unavailable'));

        expect((await confirm(input, context)).body.status).toBe('comment_unconfirmed');
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });

    it('ignores an older comment that repeats the same words', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        reddit.submitComment.mockRejectedValueOnce(new Error('failed to look up created comment'));
        reddit.getComments.mockResolvedValueOnce({
            all: async () => [{
                id: 't1_older',
                url: 'https://reddit.com/older',
                authorName: 'Racer',
                body: 'Approved text',
                createdAt: new Date(Date.now() - 60_000),
            }],
        });
        expect(await confirm(input, context)).toMatchObject({
            status: 409, body: { status: 'comment_unconfirmed' },
        });
        error.mockRestore();
    });

    it('reports the comment as posted when Reddit posts it but its reply fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        reddit.submitComment.mockRejectedValueOnce(new Error('failed to look up created comment'));
        reddit.getComments.mockResolvedValueOnce({
            all: async () => [
                { id: 't1_other', authorName: 'Racer', body: 'Other text', createdAt: new Date() },
                {
                    id: 't1_found',
                    url: 'https://reddit.com/found',
                    authorName: 'racer',
                    body: 'Approved text',
                    createdAt: new Date(),
                },
            ],
        });
        expect((await confirm(input, context)).body).toMatchObject({
            status: successStatus, commentId: 't1_found', commentUrl: 'https://reddit.com/found',
        });
        expect(reddit.getComments).toHaveBeenCalledWith(expect.objectContaining({
            postId: 't3_challenge', commentId: undefined, sort: 'new',
        }));
        expect(strings.has(key)).toBe(false);
        warn.mockRestore();
    });

    it('keeps a posted result when lock cleanup fails', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        redis.watch.mockRejectedValueOnce(new Error('exceeded max concurrency limit on redis transactions'));
        expect((await confirm(input, context)).body.status).toBe(successStatus);
        expect(strings.has(key)).toBe(false);
        expect(error).toHaveBeenCalledWith('Head to Head share lock cleanup failed:', expect.any(Error));
        error.mockRestore();
    });

    it('rejects an incorrectly attributed comment and removes it', async () => {
        const deleteComment = vi.fn(async () => undefined);
        reddit.submitComment.mockResolvedValueOnce({
            id: 't1_result', authorName: 'AppAccount', delete: deleteComment,
        });
        expect((await confirm(input, context)).body).toMatchObject({
            status: 'user_action_unavailable',
            error: `Reddit user-attributed ${action === 'brag' ? 'sharing' : 'commenting'} is not available for this app version.`,
        });
        expect(deleteComment).toHaveBeenCalledOnce();
        expect(strings.has(resultKey(action))).toBe(false);
    });

    it('answers posted_without_link when Reddit returns no comment id, and posts once', async () => {
        reddit.submitComment.mockResolvedValueOnce({ id: 'not-a-comment-id', authorName: 'Racer' });
        expect((await confirm(input, context)).body).toMatchObject({
            status: 'posted_without_link',
        });
        const stored = JSON.parse(strings.get(resultKey(action)));
        expect(stored.postedAt).toEqual(expect.any(String));
        expect(stored.commentId).toBeUndefined();

        expect((await confirm(input, context)).body.status).toBe('posted_without_link');
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);
    });

    it('keeps the claim text, player and time when it records a publication', async () => {
        const claimedBefore = Date.now();
        expect((await confirm(input, context)).body.status).toBe(successStatus);
        const stored = JSON.parse(strings.get(resultKey(action)));
        expect(stored).toMatchObject({ commentText: 'Approved text', username: 'Racer' });
        // The walk searches from createdAt, so it must stay the claim, not the time of the post.
        expect(Date.parse(stored.createdAt)).toBeLessThanOrEqual(Date.parse(stored.postedAt));
        expect(Date.parse(stored.createdAt)).toBeGreaterThanOrEqual(claimedBefore - 1000);
    });

    it('resolves the link for a recorded publication, and posts nothing', async () => {
        strings.set(resultKey(action), JSON.stringify({
            commentText: 'Approved text',
            username: 'Racer',
            createdAt: new Date().toISOString(),
            postedAt: new Date().toISOString(),
            authorName: 'Racer',
        }));
        reddit.getComments.mockResolvedValueOnce({
            all: async () => [{
                id: 't1_late',
                url: 'https://reddit.com/late',
                authorName: 'Racer',
                body: 'Approved text',
                createdAt: new Date(),
            }],
        });

        expect((await confirm(input, context)).body).toMatchObject({
            status: successStatus, commentId: 't1_late', commentUrl: 'https://reddit.com/late',
        });
        expect(reddit.submitComment).not.toHaveBeenCalled();
    });

    it('answers posted_without_link when the walk for a recorded publication cannot finish', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        strings.set(resultKey(action), JSON.stringify({
            commentText: 'Approved text',
            username: 'Racer',
            createdAt: new Date().toISOString(),
            postedAt: new Date().toISOString(),
            authorName: 'Racer',
        }));
        reddit.getComments.mockRejectedValueOnce(new Error('listing unavailable'));

        expect((await confirm(input, context)).body.status).toBe('posted_without_link');
        expect(reddit.submitComment).not.toHaveBeenCalled();
        error.mockRestore();
    });

    it('stores no id when the walk finds a comment without a t1_ id', async () => {
        strings.set(resultKey(action), JSON.stringify({
            commentText: 'Approved text',
            username: 'Racer',
            createdAt: new Date().toISOString(),
            postedAt: new Date().toISOString(),
            authorName: 'Racer',
        }));
        reddit.getComments.mockResolvedValueOnce({
            all: async () => [{
                id: 'not-a-comment-id',
                authorName: 'Racer',
                body: 'Approved text',
                createdAt: new Date(),
            }],
        });

        expect((await confirm(input, context)).body.status).toBe('posted_without_link');
        expect(JSON.parse(strings.get(resultKey(action))).commentId).toBeUndefined();
        expect(reddit.submitComment).not.toHaveBeenCalled();
    });

    it('recovers a claim receipt that predates authorName, and calls it posted', async () => {
        // Receipts already in the wild carry no authorName. The walk matches only the player, so
        // the id it finds is the player's, and the author check must not run on that answer.
        strings.set(resultKey(action), JSON.stringify({
            commentText: 'Approved text',
            username: 'Racer',
            createdAt: new Date().toISOString(),
        }));
        reddit.getComments.mockResolvedValueOnce({
            all: async () => [{
                id: 't1_old',
                url: 'https://reddit.com/old',
                authorName: 'Racer',
                body: 'Approved text',
                createdAt: new Date(),
            }],
        });

        expect((await confirm(input, context)).body).toMatchObject({
            status: successStatus, commentId: 't1_old',
        });
        expect(reddit.submitComment).not.toHaveBeenCalled();
    });

    it('posts one comment for two previews of the same result', async () => {
        const second = `miniracer:head-to-head:${action}:preview:second`;
        strings.set(second, JSON.stringify(preview));
        expect((await confirm(input, context)).body.status).toBe(successStatus);

        const repeat = await confirm({ shareToken: 'second' }, context);

        expect(repeat.body).toMatchObject({ status: successStatus, commentId: 't1_result' });
        expect(reddit.submitComment).toHaveBeenCalledTimes(1);
        expect(strings.has(second)).toBe(false);
    });

    it('expires a preview written before this version, which names no result', async () => {
        strings.set(key, JSON.stringify({ ...preview, resultKey: undefined }));
        expect((await confirm(input, context)).body.status).toBe('preview_expired');
        expect(reddit.submitComment).not.toHaveBeenCalled();
    });
});

describe('Head to Head share preview storage', () => {
    it('sets the preview expiry atomically', async () => {
        vi.clearAllMocks();
        const key = 'miniracer:head-to-head:brag:preview:atomic';
        const record = { ...preview };

        await writeHeadToHeadSharePreview(key, record);

        expect(redis.set).toHaveBeenCalledWith(
            key,
            JSON.stringify(record),
            { expiration: expect.any(Date) },
        );
        expect(redis.expire).not.toHaveBeenCalled();
    });
});
