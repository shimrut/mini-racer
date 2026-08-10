import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
const redis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options = {}) => {
        if (options.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (key) => strings.delete(key)),
    expire: vi.fn(async () => true),
    expireTime: vi.fn(async () => Math.floor(Date.now() / 1000) + 60),
    incrBy: vi.fn(async (key, amount) => {
        const next = Number(strings.get(key) || 0) + amount;
        strings.set(key, String(next));
        return next;
    }),
    watch: vi.fn(async () => {
        const commands = [];
        return {
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            set: vi.fn(async (...args) => commands.push(() => redis.set(...args))),
            expire: vi.fn(async (...args) => commands.push(() => redis.expire(...args))),
            del: vi.fn(async (...args) => commands.push(() => redis.del(...args))),
            exec: vi.fn(async () => {
                const results = [];
                for (const command of commands) results.push(await command());
                return results;
            }),
        };
    }),
};

const anchor = {
    id: 't1_scorethread',
    authorName: 'mini-racer',
    body: 'anchor',
    removed: false,
    distinguish: vi.fn(async () => undefined),
};
let submittedUserAuthor = 'RaceFan';
let submittedUserRemoved = false;
const userComment = {
    id: 't1_sharedresult',
    get authorName() { return submittedUserAuthor; },
    url: 'https://reddit.com/r/miniracer/comments/daily/result',
    get removed() { return submittedUserRemoved; },
    delete: vi.fn(async () => undefined),
};
const reddit = {
    getPostById: vi.fn(async () => ({ id: 't3_daily', url: 'https://reddit.com/r/miniracer/comments/daily' })),
    getCommentById: vi.fn(async (id) => id === anchor.id ? anchor : userComment),
    getComments: vi.fn(async () => ({ all: async () => [] })),
    getPostsByUser: vi.fn(async () => ({ all: async () => [] })),
    submitComment: vi.fn(async ({ runAs }) => runAs === 'APP' ? anchor : userComment),
};

const challenge = {
    id: 'daily-gp-2026-07-14',
    challengeDate: '2026-07-14',
    trackKey: 'circuit',
    startsAt: '2026-07-14T00:00:00.000Z',
    endsAt: '2026-07-15T00:00:00.000Z',
    availableUntil: '2026-07-21T00:00:00.000Z',
    status: 'active',
    objectiveType: 'single_lap_fastest',
    objectiveParams: {},
    skin: 'default',
};

vi.mock('@devvit/redis', () => ({ redis }));
vi.mock('@devvit/web/server', () => ({ reddit }));
vi.mock('../src/server/daily-gp-store.js', () => ({
    getServerDailyGpPlayableChallenge: vi.fn(async () => challenge),
    getServerDailyGpPlayerBest: vi.fn(async () => ({ challenge, bestTimeMs: 42380 })),
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: vi.fn(() => ({
        ok: true,
        run: { bestTimeMs: 42380, bestTimeSec: 42.38 },
    })),
}));

const {
    getServerDailyGpPlayerBest,
} = await import('../src/server/daily-gp-store.js');
const { validateDailyGpReplayDetailed } = await import('../src/server/replay-validator.js');
const {
    DAILY_GP_SCORE_THREAD_TEXT,
    confirmDailyGpShare,
    ensureDailyGpScoreThread,
    formatDailyGpShareComment,
    previewDailyGpShare,
    registerDailyGpPost,
    registerDailyGpPostWithScoreThread,
} = await import('../src/server/daily-gp-share.ts');

const requestContext = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    appSlug: 'mini-racer',
};

describe('daily GP result sharing', () => {
    beforeEach(async () => {
        strings.clear();
        vi.clearAllMocks();
        submittedUserAuthor = 'RaceFan';
        submittedUserRemoved = false;
        reddit.getComments.mockImplementation(async () => ({ all: async () => [] }));
        reddit.submitComment.mockImplementation(async ({ runAs }) => runAs === 'APP' ? anchor : userComment);
        await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('pins the exact score-thread anchor copy', () => {
        expect(DAILY_GP_SCORE_THREAD_TEXT).toBe(
            '🏁 Mini Racer score thread\n\nShare your race time from the game and it will appear as a reply here from your Reddit account.',
        );
    });

    it('formats the agreed medal and no-medal comment copy', () => {
        expect(formatDailyGpShareComment(42380, 'gold', 'Classic Circuit')).toBe(
            'I earned the Gold medal 🥇 with a 42.380 lap in Classic Circuit.',
        );
        expect(formatDailyGpShareComment(42380, 'silver', 'Classic Circuit')).toBe(
            'I earned the Silver medal 🥈 with a 42.380 lap in Classic Circuit.',
        );
        expect(formatDailyGpShareComment(42380, 'bronze', 'Classic Circuit')).toBe(
            'I earned the Bronze medal 🥉 with a 42.380 lap in Classic Circuit.',
        );
        expect(formatDailyGpShareComment(52410, null, 'Classic Circuit')).toBe(
            'I set a 52.410 lap in Classic Circuit. 🏁',
        );
        expect(formatDailyGpShareComment(42380, 'author')).toBe(
            'I earned the Author medal 🏆 with a 42.380 lap in Mini Racer.',
        );
        expect(formatDailyGpShareComment(990, null)).toBe(
            'I set a 00.990 lap in Mini Racer. 🏁',
        );
        expect(formatDailyGpShareComment(42385, 'gold', 'X')).toBe(
            'I earned the Gold medal 🥇 with a 42.385 lap in X.',
        );
        expect(formatDailyGpShareComment(42380, 'gold', '')).toBe(
            'I earned the Gold medal 🥇 with a 42.380 lap in Mini Racer.',
        );
    });

    it('describes multi-lap results as complete races', () => {
        expect(formatDailyGpShareComment(24630, 'gold', 'Circuit', 2)).toBe(
            'I earned the Gold medal 🥇 with a 24.630 2-lap race in Circuit.',
        );
        expect(formatDailyGpShareComment(30100, null, 'Circuit', 3)).toBe(
            'I set a 30.100 3-lap race in Circuit. 🏁',
        );
    });

    it('does not finish registering a new post until its score thread is pinned', async () => {
        strings.clear();

        const registered = await registerDailyGpPostWithScoreThread({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
            appSlug: 'mini-racer',
        });

        expect(reddit.submitComment).toHaveBeenCalledWith({
            id: 't3_daily',
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
        expect(anchor.distinguish).toHaveBeenCalledWith(true);
        expect(registered.scoreThreadCommentId).toBe(anchor.id);
    });

    it('renews the score-thread lease while Reddit comment discovery is pending', async () => {
        vi.useFakeTimers();
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        let finishListing;
        reddit.getComments.mockResolvedValue({
            all: () => new Promise((resolve) => { finishListing = () => resolve([]); }),
        });

        const pending = ensureDailyGpScoreThread(post, 'mini-racer');
        await vi.waitFor(() => expect(finishListing).toBeTypeOf('function'));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(redis.expire).toHaveBeenCalledWith(
            `dailygp:score-thread-lock:${post.postId}`,
            30,
        );
        await expect(ensureDailyGpScoreThread(post, 'mini-racer')).rejects.toThrow(
            'Score thread is being prepared.',
        );

        finishListing();
        await expect(pending).resolves.toMatchObject({ scoreThreadCommentId: anchor.id });
        expect(reddit.submitComment.mock.calls.filter(([input]) => input.runAs === 'APP')).toHaveLength(1);
    });

    it('keeps the first registered postId when a later registration races', async () => {
        const original = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        const raced = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_duplicate',
            postUrl: 'https://reddit.com/r/miniracer/comments/duplicate',
        });

        expect(raced).toEqual(original);
        expect(raced.postId).toBe('t3_daily');
    });

    it('previews, confirms as the Reddit user, and makes repeat shares idempotent', async () => {
        const preview = await previewDailyGpShare({
            source: 'finish',
            challengeId: challenge.id,
            replay: { inputs: [{ frames: 1 }] },
        }, requestContext);

        expect(preview).toMatchObject({
            status: 200,
            body: {
                status: 'ready',
                username: 'RaceFan',
                commentText: expect.stringContaining('42.38'),
            },
        });
        expect(reddit.submitComment).not.toHaveBeenCalled();

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );
        expect(confirmed).toMatchObject({
            status: 200,
            body: { status: 'shared', commentUrl: userComment.url },
        });
        expect(reddit.submitComment).toHaveBeenNthCalledWith(1, {
            id: 't3_daily',
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
        expect(anchor.distinguish).toHaveBeenCalledWith(true);
        expect(reddit.submitComment).toHaveBeenNthCalledWith(2, {
            id: anchor.id,
            text: expect.stringContaining('42.380'),
            runAs: 'USER',
        });

        const repeat = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        expect(repeat.body).toMatchObject({
            status: 'already_shared',
            commentUrl: userComment.url,
        });
    });

    it('renews the share lease while a Reddit user comment is pending', async () => {
        vi.useFakeTimers();
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        let finishUserComment;
        reddit.submitComment.mockImplementation(async ({ runAs }) => {
            if (runAs === 'APP') return anchor;
            return new Promise((resolve) => { finishUserComment = () => resolve(userComment); });
        });

        const pending = confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );
        await vi.waitFor(() => expect(finishUserComment).toBeTypeOf('function'));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(redis.expire.mock.calls.some(([key, seconds]) => (
            String(key).endsWith(':lock') && seconds === 30
        ))).toBe(true);

        const overlapping = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );
        expect(overlapping).toMatchObject({ status: 409, body: { status: 'share_in_progress' } });

        finishUserComment();
        await expect(pending).resolves.toMatchObject({ status: 200, body: { status: 'shared' } });
        expect(reddit.submitComment.mock.calls.filter(([input]) => input.runAs === 'USER')).toHaveLength(1);
    });

    it('fails closed and removes its comment after losing share-lock ownership', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        let finishUserComment;
        reddit.submitComment.mockImplementation(async ({ runAs }) => {
            if (runAs === 'APP') return anchor;
            return new Promise((resolve) => { finishUserComment = () => resolve(userComment); });
        });

        const pending = confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );
        await vi.waitFor(() => expect(finishUserComment).toBeTypeOf('function'));
        const shareLockKey = [...strings.keys()].find((key) => String(key).endsWith(':lock'));
        strings.set(shareLockKey, 'successor-token');
        finishUserComment();

        await expect(pending).resolves.toMatchObject({
            status: 409,
            body: { status: 'share_in_progress' },
        });
        expect(userComment.delete).toHaveBeenCalledTimes(1);
        expect([...strings.keys()].some((key) => String(key).startsWith('dailygp:shared-result:') && !String(key).endsWith(':lock'))).toBe(false);
        expect(strings.get(shareLockKey)).toBe('successor-token');
    });

    it('fails closed and deletes a comment if Reddit does not attribute it to the player', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        submittedUserAuthor = 'mini-racer';

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(confirmed).toMatchObject({
            status: 409,
            body: { status: 'user_action_unavailable' },
        });
        expect(userComment.delete).toHaveBeenCalledTimes(1);
    });

    it('allows a result to be shared again after its prior comment is deleted', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );
        submittedUserRemoved = true;

        const replacement = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(replacement).toMatchObject({
            status: 200,
            body: { status: 'ready', username: 'RaceFan' },
        });
        expect(replacement.body.shareToken).toEqual(expect.any(String));
    });

    it('requires a signed-in Reddit context before preview or confirm', async () => {
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { username: null, subredditName: 'MiniRacer', appSlug: 'mini-racer' })).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { username: '  ', subredditName: 'MiniRacer', appSlug: 'mini-racer' })).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });
        expect(await confirmDailyGpShare(
            { shareToken: 'any' },
            { username: 'RaceFan', subredditName: 'MiniRacer', appSlug: '' },
        )).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });
    });

    it('rate-limits repeated share previews and reports retry timing', async () => {
        for (let i = 0; i < 12; i += 1) {
            const preview = await previewDailyGpShare({
                source: 'standings',
                challengeId: challenge.id,
            }, requestContext);
            expect(preview.status).toBe(200);
        }
        expect(redis.expire).toHaveBeenCalledWith(
            'dailygp:share-rate-limit:racefan',
            60,
        );

        const limited = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        expect(limited).toMatchObject({
            status: 429,
            body: {
                status: 'rate_limited',
                retryAfterSeconds: expect.any(Number),
            },
        });
        expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);

        redis.expireTime.mockResolvedValueOnce(Number.NaN);
        strings.set('dailygp:share-rate-limit:racefan', '13');
        const fallback = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        expect(fallback.body.retryAfterSeconds).toBe(60);
    });

    it('rejects unverified finishes, missing results, and unavailable posts', async () => {
        validateDailyGpReplayDetailed.mockReturnValueOnce({ ok: false, failure: { reason: 'no_finish' } });
        expect(await previewDailyGpShare({
            source: 'finish',
            challengeId: challenge.id,
            replay: { inputs: [{ frames: 1 }] },
        }, requestContext)).toMatchObject({
            status: 422,
            body: { status: 'invalid_replay' },
        });

        expect(await previewDailyGpShare({
            source: 'other',
            challengeId: challenge.id,
        }, requestContext)).toMatchObject({
            status: 404,
            body: { status: 'result_unavailable' },
        });

        getServerDailyGpPlayerBest.mockResolvedValueOnce(null);
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext)).toMatchObject({
            status: 404,
            body: { status: 'result_unavailable' },
        });

        strings.clear();
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext)).toMatchObject({
            status: 404,
            body: { status: 'post_unavailable' },
        });
    });

    it('rejects expired, forbidden, and malformed share confirmations', async () => {
        expect(await confirmDailyGpShare(
            { shareToken: 'missing' },
            requestContext,
        )).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        expect(await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            { username: 'OtherUser', subredditName: 'MiniRacer', appSlug: 'mini-racer' },
        )).toMatchObject({
            status: 403,
            body: { status: 'share_forbidden' },
        });

        const allowedCase = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            { username: 'racefan', subredditName: 'miniracer', appSlug: 'mini-racer' },
        );
        expect(allowedCase).toMatchObject({
            status: 200,
            body: { status: 'shared' },
        });

        strings.set('dailygp:share-preview:bad', JSON.stringify({
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            source: 'finish',
            bestTimeMs: 1000,
            commentText: 'hi',
        }));
        expect(await confirmDailyGpShare(
            { shareToken: 'bad' },
            requestContext,
        )).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });

        strings.set('dailygp:share-preview:badjson', '{not-json');
        expect(await confirmDailyGpShare(
            { shareToken: 'badjson' },
            requestContext,
        )).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });
    });

    it('recovers a historical post by matching subreddit and challenge, preferring the requested URL', async () => {
        strings.clear();
        const otherMatch = {
            id: 't3_othermatch',
            url: 'https://reddit.com/r/miniracer/comments/othermatch',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        };
        const preferredMatch = {
            id: 't3_preferred',
            url: 'https://reddit.com/r/miniracer/comments/preferred',
            subredditName: 'MINIRACER',
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        };
        const wrongSubreddit = {
            id: 't3_wrongsub',
            url: 'https://reddit.com/r/other/comments/wrongsub',
            subredditName: 'SomeOtherSub',
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        };
        const wrongChallenge = {
            id: 't3_wrongchallenge',
            url: 'https://reddit.com/r/miniracer/comments/wrongchallenge',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({ challengeId: 'a-different-challenge' })),
        };
        const unavailablePost = {
            id: 't3_unavailable',
            url: 'https://reddit.com/r/miniracer/comments/unavailable',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => { throw new Error('post data unavailable'); }),
        };
        reddit.getPostsByUser.mockResolvedValueOnce({
            all: async () => [wrongSubreddit, wrongChallenge, unavailablePost, otherMatch, preferredMatch],
        });

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { ...requestContext, preferredPostUrl: preferredMatch.url });

        expect(preview.status).toBe(200);
        expect(reddit.getPostsByUser).toHaveBeenCalledWith({
            username: 'mini-racer',
            sort: 'new',
            timeframe: 'month',
            limit: 100,
            pageSize: 100,
        });

        await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);
        expect(reddit.submitComment).toHaveBeenNthCalledWith(1, {
            id: preferredMatch.id,
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
    });

    it('falls back to the first matching historical post when no preferred URL matches', async () => {
        strings.clear();
        const firstMatch = {
            id: 't3_firstmatch',
            url: 'https://reddit.com/r/miniracer/comments/firstmatch',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        };
        const secondMatch = {
            id: 't3_secondmatch',
            url: 'https://reddit.com/r/miniracer/comments/secondmatch',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        };
        reddit.getPostsByUser.mockResolvedValueOnce({
            all: async () => [firstMatch, secondMatch],
        });

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);

        expect(reddit.submitComment).toHaveBeenNthCalledWith(1, {
            id: firstMatch.id,
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
    });

    it('reports the post as unavailable when no historical post matches and when listings cannot be enumerated', async () => {
        strings.clear();
        reddit.getPostsByUser.mockResolvedValueOnce({ all: async () => [] });
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext)).toMatchObject({
            status: 404,
            body: { status: 'post_unavailable' },
        });

        reddit.getPostsByUser.mockResolvedValueOnce({});
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext)).toMatchObject({
            status: 404,
            body: { status: 'post_unavailable' },
        });

        reddit.getPostsByUser.mockResolvedValueOnce({
            all: async () => [{
                id: 'not-a-t3-id',
                url: 'https://reddit.com/r/miniracer/comments/badid',
                subredditName: 'MiniRacer',
                getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
            }],
        });
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext)).toMatchObject({
            status: 404,
            body: { status: 'post_unavailable' },
        });
    });

    it('returns the concurrent winner record when its own create-claim write loses the race', async () => {
        await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        redis.get.mockResolvedValueOnce(null);

        const loser = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_loser',
            postUrl: 'https://reddit.com/r/miniracer/comments/loser',
        });

        expect(loser.postId).toBe('t3_daily');
    });

    it('throws when a post registration race leaves no canonical record behind', async () => {
        strings.clear();
        strings.set(`dailygp:post:miniracer:${challenge.id}`, 'not-json');

        await expect(registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_loser',
            postUrl: 'https://reddit.com/r/miniracer/comments/loser',
        })).rejects.toThrow('Daily Mini Racer post registry race left no canonical record.');
    });

    it('treats a corrupted shared-result record as unshared instead of failing', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        const sharedKey = [...strings.keys()].find((key) => key.startsWith('dailygp:shared-result:') && !key.endsWith(':lock'));
        strings.set(sharedKey, '{not-json');

        const confirmed = await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);

        expect(confirmed).toMatchObject({ status: 200, body: { status: 'shared' } });
    });

    it('falls back to the configured rate-limit window when Redis reports a non-positive expiry', async () => {
        for (let i = 0; i < 12; i += 1) {
            await previewDailyGpShare({
                source: 'standings',
                challengeId: challenge.id,
            }, requestContext);
        }
        redis.expireTime.mockResolvedValueOnce(0);

        const limited = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(limited.body.retryAfterSeconds).toBe(60);
    });

    it('requires a subreddit and app slug in addition to a username before sharing', async () => {
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { username: 'RaceFan', subredditName: '  ', appSlug: 'mini-racer' })).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { username: 'RaceFan', subredditName: 'MiniRacer', appSlug: 42 })).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });
    });

    it('ignores a whitespace-only preferred post URL when recovering a historical post', async () => {
        strings.clear();
        const onlyMatch = {
            id: 't3_onlymatch',
            url: 'https://reddit.com/r/miniracer/comments/onlymatch',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        };
        reddit.getPostsByUser.mockResolvedValueOnce({ all: async () => [onlyMatch] });

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { ...requestContext, preferredPostUrl: '   ' });
        await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);

        expect(reddit.submitComment).toHaveBeenNthCalledWith(1, {
            id: onlyMatch.id,
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
    });

    it('reuses an already-posted score-thread anchor instead of creating a duplicate', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        const existingAnchor = { ...anchor, body: DAILY_GP_SCORE_THREAD_TEXT };
        reddit.getComments.mockResolvedValueOnce({ all: async () => [existingAnchor] });

        const result = await ensureDailyGpScoreThread(post, 'mini-racer');

        expect(result.scoreThreadCommentId).toBe(anchor.id);
        expect(anchor.distinguish).toHaveBeenCalledWith(true);
        expect(reddit.submitComment).not.toHaveBeenCalled();
    });

    it('returns immediately when the stored score-thread comment is still valid', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        const withThread = await ensureDailyGpScoreThread(post, 'mini-racer');
        reddit.getComments.mockClear();

        const again = await ensureDailyGpScoreThread(withThread, 'mini-racer');

        expect(again).toEqual(withThread);
        expect(reddit.getCommentById).toHaveBeenCalledWith(anchor.id);
        expect(reddit.getComments).not.toHaveBeenCalled();
    });

    it('rebuilds the score thread when the stored comment id can no longer be resolved', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        const staleRecord = { ...post, scoreThreadCommentId: 't1_stale' };
        reddit.getCommentById.mockRejectedValueOnce(new Error('gone'));

        const rebuilt = await ensureDailyGpScoreThread(staleRecord, 'mini-racer');

        expect(reddit.getCommentById).toHaveBeenCalledWith('t1_stale');
        expect(rebuilt.scoreThreadCommentId).toBe(anchor.id);
        expect(reddit.submitComment).toHaveBeenCalledWith({
            id: post.postId,
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
    });

    it('rebuilds the score thread when the stored comment was removed', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        const staleRecord = { ...post, scoreThreadCommentId: 't1_stale' };
        reddit.getCommentById.mockResolvedValueOnce({ removed: true });

        const rebuilt = await ensureDailyGpScoreThread(staleRecord, 'mini-racer');

        expect(rebuilt.scoreThreadCommentId).toBe(anchor.id);
        expect(reddit.submitComment).toHaveBeenCalledWith({
            id: post.postId,
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
    });

    it('returns the latest record when the score-thread lock is busy but another worker already finished', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        const completed = { ...post, scoreThreadCommentId: anchor.id, updatedAt: new Date().toISOString() };
        strings.set(`dailygp:post:miniracer:${challenge.id}`, JSON.stringify(completed));
        strings.set(`dailygp:score-thread-lock:${post.postId}`, 'someone-elses-lock-value');

        const result = await ensureDailyGpScoreThread(post, 'mini-racer');

        expect(result).toMatchObject({ scoreThreadCommentId: anchor.id });
        expect(reddit.submitComment).not.toHaveBeenCalled();
    });

    it('fails closed when the score-thread lock is lost right before its transaction commits', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        let finishDistinguish;
        anchor.distinguish.mockImplementationOnce(() => new Promise((resolve) => { finishDistinguish = resolve; }));

        const pending = ensureDailyGpScoreThread(post, 'mini-racer');
        await vi.waitFor(() => expect(finishDistinguish).toBeTypeOf('function'));
        const lockKey = [...strings.keys()].find((key) => key.startsWith('dailygp:score-thread-lock:'));
        strings.set(lockKey, 'someone-elses-lock-value');
        finishDistinguish();

        await expect(pending).rejects.toThrow('Score thread lock ownership was lost.');
    });

    it('fails closed when the score-thread transaction commits with no results', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        redis.watch.mockImplementationOnce(async () => ({
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            set: vi.fn(async () => undefined),
            expire: vi.fn(async () => undefined),
            del: vi.fn(async () => undefined),
            exec: vi.fn(async () => []),
        }));

        await expect(ensureDailyGpScoreThread(post, 'mini-racer')).rejects.toThrow(
            'Score thread lock ownership was lost.',
        );
    });

    it('reports the post as unavailable when confirm recovery cannot find any matching post', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        strings.delete(`dailygp:post:miniracer:${challenge.id}`);
        reddit.getPostsByUser.mockResolvedValueOnce({ all: async () => [] });

        const confirmed = await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);

        expect(confirmed).toMatchObject({ status: 404, body: { status: 'post_unavailable' } });
    });

    it('falls back to the post URL when Reddit omits a URL for the shared comment', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        reddit.submitComment.mockImplementation(async ({ runAs }) => (
            runAs === 'APP' ? anchor : { ...userComment, url: undefined }
        ));

        const confirmed = await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);

        expect(confirmed).toMatchObject({
            status: 200,
            body: { status: 'shared', commentUrl: 'https://reddit.com/r/miniracer/comments/daily' },
        });
    });

    it('fails closed when the share-result transaction commits with no results', async () => {
        const setup = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        await confirmDailyGpShare({ shareToken: setup.body.shareToken }, requestContext);
        submittedUserRemoved = true;

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        redis.watch.mockImplementationOnce(async () => ({
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            set: vi.fn(async () => undefined),
            expire: vi.fn(async () => undefined),
            del: vi.fn(async () => undefined),
            exec: vi.fn(async () => []),
        }));

        const confirmed = await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);

        expect(confirmed).toMatchObject({ status: 409, body: { status: 'share_in_progress' } });
    });

    it('expires a ready preview exactly ten minutes after it is created', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview.body.expiresAt).toBe('2026-07-18T12:10:00.000Z');
    });

    it('reports no verified result when the finished challenge cannot be found', async () => {
        const { getServerDailyGpPlayableChallenge } = await import('../src/server/daily-gp-store.js');
        getServerDailyGpPlayableChallenge.mockResolvedValueOnce(null);

        expect(await previewDailyGpShare({
            source: 'finish',
            challengeId: challenge.id,
            replay: { inputs: [{ frames: 1 }] },
        }, requestContext)).toMatchObject({
            status: 404,
            body: { status: 'result_unavailable' },
        });
    });

    it('treats a missing or non-string share token as an expired preview during confirm', async () => {
        expect(await confirmDailyGpShare({}, requestContext)).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });
        expect(await confirmDailyGpShare({ shareToken: 42 }, requestContext)).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });
    });

    it('fails closed when Reddit returns a user comment without a t1_ id', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        reddit.submitComment.mockImplementation(async ({ runAs }) => (
            runAs === 'APP' ? anchor : { ...userComment, id: 'not-a-comment-id' }
        ));

        await expect(confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        )).rejects.toThrow('Reddit did not return a shared-comment ID.');
    });

    it('returns share_in_progress when confirm loses ownership before persisting the shared result', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        let finishUserComment;
        reddit.submitComment.mockImplementation(async ({ runAs }) => {
            if (runAs === 'APP') return anchor;
            return new Promise((resolve) => { finishUserComment = () => resolve(userComment); });
        });

        const pending = confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );
        await vi.waitFor(() => expect(finishUserComment).toBeTypeOf('function'));
        const shareLockKey = [...strings.keys()].find((key) => String(key).endsWith(':lock'));
        strings.set(shareLockKey, 'successor-token');
        finishUserComment();

        await expect(pending).resolves.toMatchObject({
            status: 409,
            body: { status: 'share_in_progress' },
        });
    });

    it('still fails closed when comment cleanup throws after Reddit misattributes the author', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        submittedUserAuthor = 'mini-racer';
        userComment.delete.mockRejectedValueOnce(new Error('delete unavailable'));

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(confirmed).toMatchObject({
            status: 409,
            body: { status: 'user_action_unavailable' },
        });
        expect(userComment.delete).toHaveBeenCalledTimes(1);
    });

    it('logs share-lock cleanup failures without replacing a completed share', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const originalDel = redis.del;
        redis.del = vi.fn(async (key) => {
            if (String(key).endsWith(':lock')) {
                throw new Error('cleanup unavailable');
            }
            return originalDel(key);
        });

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(confirmed).toMatchObject({ status: 200, body: { status: 'shared' } });
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Daily GP share lock cleanup failed:',
            expect.any(Error),
        );
        redis.del = originalDel;
        consoleErrorSpy.mockRestore();
    });

    it('treats comment listings without an all() iterator as empty when preparing score threads', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        reddit.getComments.mockResolvedValueOnce({});

        const result = await ensureDailyGpScoreThread(post, 'mini-racer');

        expect(result.scoreThreadCommentId).toBe(anchor.id);
        expect(reddit.submitComment).toHaveBeenCalledWith({
            id: post.postId,
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
    });

    it('rejects score-thread creation when Reddit returns an invalid anchor comment id', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        reddit.submitComment.mockImplementationOnce(async () => ({
            ...anchor,
            id: 'not-a-comment-id',
            distinguish: vi.fn(async () => undefined),
        }));

        await expect(ensureDailyGpScoreThread(post, 'mini-racer')).rejects.toThrow(
            'Reddit did not return a score-thread comment ID.',
        );
    });

    it('requires a signed-in Reddit context for preview and confirm requests', async () => {
        expect(await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { username: '', subredditName: 'MiniRacer', appSlug: 'mini-racer' })).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });

        expect(await confirmDailyGpShare(
            { shareToken: 'missing' },
            { username: 'RaceFan', subredditName: '', appSlug: 'mini-racer' },
        )).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });
    });

    it('returns the existing shared comment during confirm when a prior share is still active', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        strings.set('dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380', JSON.stringify({
            commentId: 't1_already_shared',
            commentUrl: 'https://reddit.com/r/miniracer/comments/daily/shared',
            commentText: 'already shared',
            username: 'RaceFan',
        }));

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(confirmed).toMatchObject({
            status: 200,
            body: {
                status: 'already_shared',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/shared',
            },
        });
        expect(reddit.submitComment).not.toHaveBeenCalledWith(expect.objectContaining({ runAs: 'USER' }));
    });

    it('treats corrupt stored shared-result records as absent during confirm', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        strings.set('dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380', '{not-json');

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(confirmed).toMatchObject({ status: 200, body: { status: 'shared' } });
    });

    it.each([
        ['missing challengeId', {
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            source: 'finish',
            bestTimeMs: 1000,
            commentText: 'hi',
        }],
        ['invalid source', {
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            source: 'other',
            bestTimeMs: 1000,
            commentText: 'hi',
        }],
        ['non-finite bestTimeMs', {
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            source: 'finish',
            bestTimeMs: 'fast',
            commentText: 'hi',
        }],
        ['missing commentText', {
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            source: 'finish',
            bestTimeMs: 1000,
        }],
        ['missing subredditName', {
            username: 'RaceFan',
            challengeId: challenge.id,
            source: 'finish',
            bestTimeMs: 1000,
            commentText: 'hi',
        }],
    ])('rejects confirm for a preview record with %s', async (_label, record) => {
        strings.set('dailygp:share-preview:invalid-record', JSON.stringify(record));

        expect(await confirmDailyGpShare({ shareToken: 'invalid-record' }, requestContext)).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });
    });

    it.each([
        ['a comment id without the t1_ prefix', {
            commentId: 'not-a-comment',
            commentUrl: 'https://reddit.com/r/miniracer/comments/daily/shared',
            commentText: 'already shared',
            username: 'RaceFan',
        }],
        ['a missing comment url', {
            commentId: 't1_already_shared',
            commentText: 'already shared',
            username: 'RaceFan',
        }],
        ['a missing username', {
            commentId: 't1_already_shared',
            commentUrl: 'https://reddit.com/r/miniracer/comments/daily/shared',
            commentText: 'already shared',
        }],
    ])('treats a stored shared result with %s as unshared during preview', async (_label, shared) => {
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify(shared),
        );

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toMatchObject({
            status: 200,
            body: { status: 'ready', shareToken: expect.any(String) },
        });
    });

    it('recovers the post record when no registry entry exists yet', async () => {
        strings.clear();
        const recoveredPost = {
            id: 't3_recovered',
            url: 'https://reddit.com/r/miniracer/comments/recovered',
            subredditName: 'MiniRacer',
            getPostData: vi.fn(async () => ({ challengeId: challenge.id })),
        };
        reddit.getPostsByUser.mockResolvedValueOnce({ all: async () => [recoveredPost] });

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview.status).toBe(200);
        await confirmDailyGpShare({ shareToken: preview.body.shareToken }, requestContext);
        expect(reddit.submitComment).toHaveBeenNthCalledWith(1, {
            id: recoveredPost.id,
            text: DAILY_GP_SCORE_THREAD_TEXT,
            runAs: 'APP',
        });
    });

    it('preserves exact millisecond boundaries in shared times', () => {
        expect(formatDailyGpShareComment(42384, null, 'Track')).toBe(
            'I set a 42.384 lap in Track. 🏁',
        );
        expect(formatDailyGpShareComment(42386, 'gold', 'Track')).toBe(
            'I earned the Gold medal 🥇 with a 42.386 lap in Track.',
        );
        expect(formatDailyGpShareComment(1000, null, 'Track')).toBe(
            'I set a 01.000 lap in Track. 🏁',
        );
        expect(formatDailyGpShareComment(99990, 'silver', 'Track')).toBe(
            'I earned the Silver medal 🥈 with a 99.990 lap in Track.',
        );
    });

    it('attempts historical post recovery when the stored post id cannot be resolved', async () => {
        strings.clear();
        strings.set(`dailygp:post:miniracer:${challenge.id}`, JSON.stringify({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_stale',
            postUrl: 'https://reddit.com/r/miniracer/comments/stale',
            scoreThreadCommentId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }));
        reddit.getPostById.mockRejectedValueOnce(new Error('post missing'));
        reddit.getPostsByUser.mockResolvedValueOnce({ all: async () => [] });

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(reddit.getPostsByUser).toHaveBeenCalled();
        expect(preview).toMatchObject({
            status: 404,
            body: { status: 'post_unavailable' },
        });
    });

    it('returns already_shared during preview when the stored Reddit comment is still active', async () => {
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify({
                commentId: 't1_live_share',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/live',
                commentText: 'still live',
                username: 'RaceFan',
            }),
        );
        reddit.getCommentById.mockImplementation(async (id) => (
            id === 't1_live_share'
                ? { id, removed: false, authorName: 'RaceFan' }
                : anchor
        ));

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toMatchObject({
            status: 200,
            body: {
                status: 'already_shared',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/live',
            },
        });
        expect(reddit.submitComment).not.toHaveBeenCalled();
    });

    it('clears a removed shared-result record before issuing a fresh preview', async () => {
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify({
                commentId: 't1_removed_share',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/removed',
                commentText: 'removed',
                username: 'RaceFan',
            }),
        );
        reddit.getCommentById.mockImplementation(async (id) => (
            id === 't1_removed_share'
                ? { id, removed: true }
                : anchor
        ));

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview.body.status).toBe('ready');
        expect(strings.has('dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380')).toBe(false);
    });

    it('deletes the preview token when confirm finds an already-shared result', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify({
                commentId: 't1_confirm_existing',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/existing',
                commentText: 'existing',
                username: 'RaceFan',
            }),
        );
        reddit.getCommentById.mockImplementation(async (id) => (
            id === 't1_confirm_existing'
                ? { id, removed: false, authorName: 'RaceFan' }
                : anchor
        ));

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(confirmed).toMatchObject({
            status: 200,
            body: {
                status: 'already_shared',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/existing',
            },
        });
        expect(strings.has(`dailygp:share-preview:${preview.body.shareToken}`)).toBe(false);
        expect(reddit.submitComment).not.toHaveBeenCalledWith(expect.objectContaining({ runAs: 'USER' }));
    });

    it('matches score-thread anchors case-insensitively on author name', async () => {
        const post = await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        const existingAnchor = {
            id: 't1_case_anchor',
            authorName: 'MINI-RACER',
            body: DAILY_GP_SCORE_THREAD_TEXT,
            removed: false,
            distinguish: vi.fn(async () => undefined),
        };
        reddit.getComments.mockResolvedValueOnce({ all: async () => [existingAnchor] });

        const result = await ensureDailyGpScoreThread(post, 'mini-racer');

        expect(result.scoreThreadCommentId).toBe('t1_case_anchor');
        expect(reddit.submitComment).not.toHaveBeenCalled();
        expect(existingAnchor.distinguish).toHaveBeenCalledWith(true);
    });

    it('rejects finish previews when the replay cannot be verified', async () => {
        validateDailyGpReplayDetailed.mockReturnValueOnce({
            ok: false,
            failure: { reason: 'frame_cap' },
        });

        const preview = await previewDailyGpShare({
            source: 'finish',
            challengeId: challenge.id,
            replay: { inputs: [{ frames: 1 }] },
        }, requestContext);

        expect(preview).toMatchObject({
            status: 422,
            body: { status: 'invalid_replay' },
        });
    });

    it('rejects previews for unknown share sources', async () => {
        const preview = await previewDailyGpShare({
            source: 'leaderboard',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toMatchObject({
            status: 404,
            body: { status: 'result_unavailable' },
        });
    });

    it('normalizes usernames when building share rate-limit keys', async () => {
        for (let i = 0; i < 12; i += 1) {
            await previewDailyGpShare({
                source: 'standings',
                challengeId: challenge.id,
            }, { ...requestContext, username: '  RaceFan  ' });
        }

        expect(strings.has('dailygp:share-rate-limit:racefan')).toBe(true);
        const limited = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { ...requestContext, username: 'racefan' });
        expect(limited.status).toBe(429);
    });

    it('uses the post URL when Reddit omits a comment url during confirm', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        reddit.submitComment.mockImplementation(async ({ runAs }) => (
            runAs === 'APP'
                ? anchor
                : { ...userComment, id: 't1_no_url', url: undefined }
        ));

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(confirmed.body.commentUrl).toBe('https://reddit.com/r/miniracer/comments/daily');
    });
});
