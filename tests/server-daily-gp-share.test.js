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

    it('formats the agreed medal and no-medal comment copy', () => {
        expect(formatDailyGpShareComment(42380, 'gold', 'Classic Circuit')).toBe(
            'I earned the Gold medal 🥇 with a 42.38 lap in Classic Circuit.',
        );
        expect(formatDailyGpShareComment(42380, 'silver', 'Classic Circuit')).toBe(
            'I earned the Silver medal 🥈 with a 42.38 lap in Classic Circuit.',
        );
        expect(formatDailyGpShareComment(42380, 'bronze', 'Classic Circuit')).toBe(
            'I earned the Bronze medal 🥉 with a 42.38 lap in Classic Circuit.',
        );
        expect(formatDailyGpShareComment(52410, null, 'Classic Circuit')).toBe(
            'I set a 52.41 lap in Classic Circuit. 🏁',
        );
        expect(formatDailyGpShareComment(42380, 'author')).toBe(
            'I earned the Author medal 🏆 with a 42.38 lap in Mini Racer.',
        );
        expect(formatDailyGpShareComment(990, null)).toBe(
            'I set a 00.99 lap in Mini Racer. 🏁',
        );
        expect(formatDailyGpShareComment(42385, 'gold', 'X')).toBe(
            'I earned the Gold medal 🥇 with a 42.39 lap in X.',
        );
        expect(formatDailyGpShareComment(42380, 'gold', '')).toBe(
            'I earned the Gold medal 🥇 with a 42.38 lap in Mini Racer.',
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
        // Preview no longer creates the score thread (deferred to confirm); no
        // Reddit comment submission should happen during the preview step.
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
            text: expect.stringContaining('42.38'),
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
});
