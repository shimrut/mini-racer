import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { strings, redis, reddit, challenge } = vi.hoisted(() => {
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
        expireTime: vi.fn(async () => Math.floor(Date.now() / 1000) + 42),
        incrBy: vi.fn(async (key, amount) => {
            const next = Number(strings.get(key) || 0) + amount;
            strings.set(key, String(next));
            return next;
        }),
        watch: vi.fn(async () => ({
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            set: vi.fn(),
            expire: vi.fn(),
            del: vi.fn(),
            exec: vi.fn(async () => ['OK']),
        })),
    };
    const reddit = {
        getPostById: vi.fn(async () => ({ id: 't3_daily', url: 'https://reddit.com/r/miniracer/comments/daily' })),
        getCommentById: vi.fn(async (id) => ({
            id,
            authorName: 'mini-racer',
            body: 'anchor',
            removed: false,
            distinguish: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        })),
        getComments: vi.fn(async () => ({ all: async () => [] })),
        getPostsByUser: vi.fn(async () => ({ all: async () => [] })),
        submitComment: vi.fn(async ({ runAs, id }) => (
            runAs === 'APP'
                ? {
                    id: 't1_scorethread',
                    authorName: 'mini-racer',
                    distinguish: vi.fn(async () => undefined),
                }
                : {
                    id: 't1_sharedresult',
                    authorName: 'RaceFan',
                    url: 'https://reddit.com/r/miniracer/comments/daily/result',
                }
        )),
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
    return { strings, redis, reddit, challenge };
});

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

const { validateDailyGpReplayDetailed } = await import('../src/server/replay-validator.js');
const {
    confirmDailyGpShare,
    DAILY_GP_SCORE_THREAD_TEXT,
    ensureDailyGpScoreThread,
    formatDailyGpShareComment,
    previewDailyGpShare,
    registerDailyGpPost,
    resolveDailyGpPostRecord,
} = await import('../src/server/daily-gp-share.ts');

const requestContext = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    appSlug: 'mini-racer',
};

describe('daily GP share wave5', () => {
    beforeEach(async () => {
        strings.clear();
        vi.clearAllMocks();
        redis.incrBy.mockImplementation(async (key, amount) => {
            const next = Number(strings.get(key) || 0) + amount;
            strings.set(key, String(next));
            return next;
        });
        await registerDailyGpPost({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
        });
        strings.set(
            'dailygp:post:miniracer:daily-gp-2026-07-14',
            JSON.stringify({
                subredditName: 'MiniRacer',
                challengeId: challenge.id,
                postId: 't3_daily',
                postUrl: 'https://reddit.com/r/miniracer/comments/daily',
                scoreThreadCommentId: null,
                createdAt: '2026-07-14T00:00:00.000Z',
                updatedAt: '2026-07-14T00:00:00.000Z',
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('formats silver and bronze medal share comments (L115-L125)', () => {
        expect(formatDailyGpShareComment(59990, 'silver', 'Desert Bridge')).toContain('Silver');
        expect(formatDailyGpShareComment(59990, 'silver', 'Desert Bridge')).toContain('🥈');
        expect(formatDailyGpShareComment(59990, 'bronze', 'Desert Bridge')).toContain('Bronze');
        expect(formatDailyGpShareComment(59990, 'bronze', 'Desert Bridge')).toContain('🥉');
        expect(formatDailyGpShareComment(15000, null, 'Circuit')).toContain('15.00');
        expect(formatDailyGpShareComment(15000, null, 'Circuit')).toContain('🏁');
    });

    it('returns rate_limited with retryAfterSeconds once the preview cap is exceeded (L212-L220)', async () => {
        redis.incrBy.mockResolvedValue(13);
        redis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 42);

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toEqual({
            status: 429,
            body: {
                status: 'rate_limited',
                retryAfterSeconds: 42,
            },
        });
    });

    it('reuses an existing score-thread anchor comment instead of submitting a new one (L358-L363)', async () => {
        const anchor = {
            id: 't1_existing_anchor',
            authorName: 'mini-racer',
            body: DAILY_GP_SCORE_THREAD_TEXT,
            distinguish: vi.fn(async () => undefined),
        };
        reddit.getComments.mockResolvedValueOnce({ all: async () => [anchor] });

        const post = {
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            postId: 't3_daily',
            postUrl: 'https://reddit.com/r/miniracer/comments/daily',
            scoreThreadCommentId: null,
            createdAt: '2026-07-14T00:00:00.000Z',
            updatedAt: '2026-07-14T00:00:00.000Z',
        };

        const withThread = await ensureDailyGpScoreThread(post, 'mini-racer');

        expect(withThread.scoreThreadCommentId).toBe('t1_existing_anchor');
        expect(reddit.submitComment).not.toHaveBeenCalled();
        expect(anchor.distinguish).toHaveBeenCalledWith(true);
    });

    it('recovers a daily post from historical listings when no registry record exists (L277-L298)', async () => {
        strings.delete('dailygp:post:miniracer:daily-gp-2026-07-14');
        reddit.getPostsByUser.mockResolvedValueOnce({
            all: async () => [{
                id: 't3_recovered',
                subredditName: 'MiniRacer',
                url: 'https://reddit.com/r/miniracer/comments/recovered',
                getPostData: async () => ({ challengeId: challenge.id }),
            }],
        });

        const recovered = await resolveDailyGpPostRecord({
            subredditName: 'MiniRacer',
            challengeId: challenge.id,
            appSlug: 'mini-racer',
            preferredPostUrl: 'https://reddit.com/r/miniracer/comments/recovered',
        });

        expect(recovered?.postId).toBe('t3_recovered');
        expect(recovered?.postUrl).toBe('https://reddit.com/r/miniracer/comments/recovered');
    });

    it('rejects confirm when the preview subreddit does not match the signed-in context (L538-L541)', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        const forbidden = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            { ...requestContext, subredditName: 'OtherSub' },
        );

        expect(forbidden).toEqual({
            status: 403,
            body: {
                status: 'share_forbidden',
                error: 'This share preview belongs to another Reddit account.',
            },
        });
    });

    it('returns user_action_unavailable when Reddit attributes the comment to another author (L584-L596)', async () => {
        strings.set(
            'dailygp:post:miniracer:daily-gp-2026-07-14',
            JSON.stringify({
                subredditName: 'MiniRacer',
                challengeId: challenge.id,
                postId: 't3_daily',
                postUrl: 'https://reddit.com/r/miniracer/comments/daily',
                scoreThreadCommentId: 't1_scorethread',
                createdAt: '2026-07-14T00:00:00.000Z',
                updatedAt: '2026-07-14T00:00:00.000Z',
            }),
        );
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        reddit.submitComment.mockImplementation(async ({ runAs }) => {
            if (runAs === 'USER') {
                return {
                    id: 't1_wrong_author',
                    authorName: 'BotAccount',
                    delete: vi.fn(async () => undefined),
                };
            }
            return {
                id: 't1_scorethread',
                authorName: 'mini-racer',
                distinguish: vi.fn(async () => undefined),
            };
        });

        const result = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(result).toEqual({
            status: 409,
            body: {
                status: 'user_action_unavailable',
                error: 'Reddit user-attributed sharing is not available for this app version.',
            },
        });
    });

    it('rejects finish previews when replay validation fails (L451-L454)', async () => {
        validateDailyGpReplayDetailed.mockReturnValueOnce({ ok: false });

        const preview = await previewDailyGpShare({
            source: 'finish',
            challengeId: challenge.id,
            replay: { inputs: [] },
        }, requestContext);

        expect(preview).toEqual({
            status: 422,
            body: {
                status: 'invalid_replay',
                error: 'This finished lap could not be verified.',
            },
        });
    });
});
