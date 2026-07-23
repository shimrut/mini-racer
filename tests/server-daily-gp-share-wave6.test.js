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
        submitComment: vi.fn(async ({ runAs }) => (
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

const { getServerDailyGpPlayableChallenge, getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.js');
const { validateDailyGpReplayDetailed } = await import('../src/server/replay-validator.js');
const {
    confirmDailyGpShare,
    DAILY_GP_SCORE_THREAD_TEXT,
    formatDailyGpShareComment,
    previewDailyGpShare,
    registerDailyGpPost,
} = await import('../src/server/daily-gp-share.ts');

const requestContext = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    appSlug: 'mini-racer',
};

describe('daily GP share wave6', () => {
    beforeEach(async () => {
        strings.clear();
        vi.clearAllMocks();
        getServerDailyGpPlayableChallenge.mockResolvedValue(challenge);
        getServerDailyGpPlayerBest.mockResolvedValue({ challenge, bestTimeMs: 42380 });
        validateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: { bestTimeMs: 42380, bestTimeSec: 42.38 },
        });
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
                scoreThreadCommentId: 't1_scorethread',
                createdAt: '2026-07-14T00:00:00.000Z',
                updatedAt: '2026-07-14T00:00:00.000Z',
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('formats author and gold medal share comments with padded lap times (L115-L125)', () => {
        expect(formatDailyGpShareComment(9050, 'author', 'Circuit')).toBe(
            'I earned the Author medal 🏆 with a 09.05 lap in Circuit.',
        );
        expect(formatDailyGpShareComment(5990, 'gold', 'Desert Bridge')).toBe(
            'I earned the Gold medal 🥇 with a 05.99 lap in Desert Bridge.',
        );
    });

    it('uses the default track label when trackName is omitted (L114)', () => {
        expect(formatDailyGpShareComment(15000, null)).toBe(
            'I set a 15.00 lap in Mini Racer. 🏁',
        );
    });

    it('keeps the exact score-thread anchor copy (L29-L33)', () => {
        expect(DAILY_GP_SCORE_THREAD_TEXT).toContain('🏁 Mini Racer score thread');
        expect(DAILY_GP_SCORE_THREAD_TEXT).toContain('Share your race time from the game');
    });

    it('requires a signed-in username for preview (L462-L463)', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, {
            username: '   ',
            subredditName: 'MiniRacer',
            appSlug: 'mini-racer',
        });

        expect(preview).toEqual({
            status: 401,
            body: {
                status: 'signed_in_required',
                error: 'Sign in to Reddit to share your time.',
            },
        });
    });

    it('requires subredditName and appSlug for preview (L170-L172)', async () => {
        const missingSubreddit = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, {
            username: 'RaceFan',
            subredditName: '',
            appSlug: 'mini-racer',
        });
        const missingApp = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, {
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            appSlug: '  ',
        });

        expect(missingSubreddit.status).toBe(401);
        expect(missingApp.status).toBe(401);
    });

    it('returns result_unavailable when standings have no verified result (L484-L485)', async () => {
        getServerDailyGpPlayerBest.mockResolvedValueOnce(null);

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toEqual({
            status: 404,
            body: {
                status: 'result_unavailable',
                error: 'No verified result is available to share.',
            },
        });
    });

    it('returns post_unavailable when no registry post exists (L487-L488)', async () => {
        strings.delete('dailygp:post:miniracer:daily-gp-2026-07-14');

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toEqual({
            status: 404,
            body: {
                status: 'post_unavailable',
                error: 'The post for this race day is unavailable.',
            },
        });
    });

    it('returns null for unknown share sources (L448)', async () => {
        const preview = await previewDailyGpShare({
            source: 'leaderboard',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview.status).toBe(404);
        expect(preview.body.status).toBe('result_unavailable');
    });

    it('returns invalid_replay for finish previews with failed validation (L451-L454)', async () => {
        getServerDailyGpPlayableChallenge.mockResolvedValueOnce(challenge);
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
                error: 'This finished race could not be verified.',
            },
        });
    });

    it('returns already_shared when an active shared result exists (L505-L506)', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify({
                commentId: 't1_existing',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/existing',
                commentText: 'Already shared',
                username: 'RaceFan',
                createdAt: '2026-07-14T00:00:00.000Z',
            }),
        );

        const duplicate = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(duplicate.status).toBe(200);
        expect(duplicate.body.status).toBe('already_shared');
        expect(duplicate.body.commentText).toBe('Already shared');
        expect(preview.body.shareToken).toBeTruthy();
    });

    it('returns preview_expired for empty share tokens (L532-L536)', async () => {
        const result = await confirmDailyGpShare({ shareToken: '' }, requestContext);

        expect(result).toEqual({
            status: 409,
            body: {
                status: 'preview_expired',
                error: 'This share preview expired. Try again.',
            },
        });
    });

    it('returns signed_in_required for confirm without valid context (L528-L530)', async () => {
        const result = await confirmDailyGpShare(
            { shareToken: 'missing' },
            { username: '', subredditName: 'MiniRacer', appSlug: 'mini-racer' },
        );

        expect(result.status).toBe(401);
        expect(result.body.status).toBe('signed_in_required');
    });

    it('rejects confirm when the subreddit does not match the preview (L538-L541)', async () => {
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

    it('returns ready previews with share tokens and expiry timestamps (L512-L520)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview.status).toBe(200);
        expect(preview.body.status).toBe('ready');
        expect(typeof preview.body.shareToken).toBe('string');
        expect(preview.body.commentText).toContain('42.38');
        expect(preview.body.expiresAt).toBe('2026-07-14T12:10:00.000Z');

        vi.useRealTimers();
    });

    it('returns result_unavailable when finish source has no playable challenge (L449-L450)', async () => {
        getServerDailyGpPlayableChallenge.mockResolvedValueOnce(null);

        const preview = await previewDailyGpShare({
            source: 'finish',
            challengeId: challenge.id,
            replay: { inputs: [] },
        }, requestContext);

        expect(preview.status).toBe(404);
        expect(preview.body.status).toBe('result_unavailable');
    });

    it('treats removed shared comments as shareable again (L421-L427)', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify({
                commentId: 't1_removed',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/removed',
                commentText: 'Removed share',
                username: 'RaceFan',
                createdAt: '2026-07-14T00:00:00.000Z',
            }),
        );
        reddit.getCommentById.mockResolvedValueOnce({
            id: 't1_removed',
            authorName: 'RaceFan',
            removed: true,
            delete: vi.fn(async () => undefined),
        });

        const retry = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(retry.body.status).toBe('ready');
        expect(strings.has('dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380')).toBe(false);
        expect(preview.body.shareToken).toBeTruthy();
    });
});
