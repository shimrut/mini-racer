import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    DAILY_GP_SCORE_THREAD_TEXT,
    confirmDailyGpShare,
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
        await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
    });

    it('formats the agreed medal and no-medal comment copy', () => {
        expect(formatDailyGpShareComment(42380, 'gold', 'Classic Circuit')).toBe(
            'I earned the Gold medal 🥇 with a 42.38 lap in Classic Circuit.',
        );
        expect(formatDailyGpShareComment(52410, null, 'Classic Circuit')).toBe(
            'I set a 52.41 lap in Classic Circuit. 🏁',
        );
        expect(formatDailyGpShareComment(42380, 'author')).toBe(
            'I earned the Author medal 🏆 with a 42.38 lap in Mini Racer.',
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
});
