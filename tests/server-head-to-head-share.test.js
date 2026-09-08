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
};
vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ reddit }));
const { confirmHeadToHeadBrag } = await import('../src/server/head-to-head-brag.ts');
const { confirmHeadToHeadComment } = await import('../src/server/head-to-head-comment.ts');
const { writeHeadToHeadSharePreview } = await import('../src/server/head-to-head-share.ts');
const context = { username: 'Racer', subredditName: 'MiniRacer' };
const preview = { ...context, postId: 't3_challenge', commentText: 'Approved text' };

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
            strings.set(`${key}:lock`, 'replacement-lease');
            return { url: 'https://reddit.com/post' };
        });
        expect((await confirm(input, context)).body.status).toBe(inProgressStatus);
        expect(reddit.submitComment).not.toHaveBeenCalled();
        expect(strings.has(key)).toBe(true);
        expect(strings.get(`${key}:lock`)).toBe('replacement-lease');
    });

    it.each([
        { username: 'OtherRacer', subredditName: 'MiniRacer' },
        { username: 'Racer', subredditName: 'OtherCommunity' },
    ])('keeps the token restricted to its account and community: %j', async (otherContext) => {
        expect((await confirm(input, otherContext)).body.status).toBe('share_forbidden');
        expect(reddit.submitComment).not.toHaveBeenCalled();
        expect(strings.has(key)).toBe(true);
    });

    it('leaves the preview available for retry when Reddit rejects submission', async () => {
        reddit.submitComment.mockRejectedValueOnce(new Error('Reddit unavailable'));
        await expect(confirm(input, context)).rejects.toThrow('Reddit unavailable');
        expect(strings.has(`${key}:lock`)).toBe(false);
        expect((await confirm(input, context)).body.status).toBe(successStatus);
    });

    it('removes an incorrectly attributed comment and keeps the preview', async () => {
        const deleteComment = vi.fn(async () => undefined);
        reddit.submitComment.mockResolvedValueOnce({
            id: 't1_result', authorName: 'AppAccount', delete: deleteComment,
        });
        expect((await confirm(input, context)).body.status).toBe('user_action_unavailable');
        expect(deleteComment).toHaveBeenCalledOnce();
        expect(strings.has(key)).toBe(true);
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
