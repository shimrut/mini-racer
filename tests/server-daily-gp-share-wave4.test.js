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
        expireTime: vi.fn(async () => Math.floor(Date.now() / 1000) + 60),
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
            exec: vi.fn(async () => []),
        })),
    };
    const reddit = {
        getPostById: vi.fn(async () => ({ id: 't3_daily', url: 'https://reddit.com/r/miniracer/comments/daily' })),
        getCommentById: vi.fn(async (id) => (
            id === 't1_scorethread'
                ? {
                    id: 't1_scorethread',
                    authorName: 'mini-racer',
                    body: 'anchor',
                    removed: false,
                    distinguish: vi.fn(async () => undefined),
                }
                : {
                    id: 't1_sharedresult',
                    authorName: 'RaceFan',
                    url: 'https://reddit.com/r/miniracer/comments/daily/result',
                    removed: false,
                    delete: vi.fn(async () => undefined),
                }
        )),
        getComments: vi.fn(async () => ({ all: async () => [] })),
        getPostsByUser: vi.fn(async () => ({ all: async () => [] })),
        submitComment: vi.fn(async ({ runAs }) => (
            runAs === 'APP'
                ? {
                    id: 't1_scorethread',
                    authorName: 'mini-racer',
                    distinguish: vi.fn(async () => undefined),
                }
                : { id: 't1_sharedresult', authorName: 'RaceFan', url: 'https://reddit.com/r/miniracer/comments/daily/result' }
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
vi.mock('../src/server/daily/daily-gp-store.js', () => ({
    getServerDailyGpPlayableChallenge: vi.fn(async () => challenge),
    getServerDailyGpPlayerBest: vi.fn(async () => ({ challenge, bestTimeMs: 42380 })),
}));
vi.mock('../src/server/competition/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: vi.fn(() => ({
        ok: true,
        run: { bestTimeMs: 42380, bestTimeSec: 42.38 },
    })),
}));

const {
    confirmDailyGpShare,
    formatDailyGpShareComment,
    previewDailyGpShare,
    registerDailyGpPost,
} = await import('../src/server/daily/daily-gp-share.ts');
const { acquireRedisLock } = await import('../src/server/redis/redis-lock.js');

const requestContext = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    appSlug: 'mini-racer',
};

describe('daily GP share wave4', () => {
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
                scoreThreadCommentId: 't1_scorethread',
                createdAt: '2026-07-14T00:00:00.000Z',
                updatedAt: '2026-07-14T00:00:00.000Z',
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects confirm when the preview belongs to a different username (L538-L541)', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        const forbidden = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            { ...requestContext, username: 'OtherUser' },
        );

        expect(forbidden).toEqual({
            status: 403,
            body: {
                status: 'share_forbidden',
                error: 'This share preview belongs to another Reddit account.',
            },
        });
    });

    it('normalizes usernames for share rate-limit keys (L76, L93-L94)', async () => {
        await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { ...requestContext, username: '  RaceFan  ' });

        expect(redis.incrBy).toHaveBeenCalledWith('dailygp:share-rate-limit:racefan', 1);
    });

    it('returns preview_expired with the exact copy when the token is unknown (L535-L536)', async () => {
        const result = await confirmDailyGpShare(
            { shareToken: 'missing-token' },
            requestContext,
        );

        expect(result).toEqual({
            status: 409,
            body: {
                status: 'preview_expired',
                error: 'This share preview expired. Try again.',
            },
        });
    });

    it('returns share_in_progress when the confirm lock cannot be acquired (L544-L546)', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        await acquireRedisLock(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380:lock',
            30_000,
            redis,
        );

        const blocked = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );

        expect(blocked).toEqual({
            status: 409,
            body: {
                status: 'share_in_progress',
                error: 'This result is already being shared.',
            },
        });
    });

    it('returns already_shared during preview when an active shared-result record exists (L505-L506)', async () => {
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify({
                commentId: 't1_sharedresult',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/result',
                commentText: 'existing share',
                username: 'RaceFan',
                createdAt: '2026-07-14T00:00:00.000Z',
            }),
        );

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toEqual({
            status: 200,
            body: {
                status: 'already_shared',
                username: 'RaceFan',
                commentText: 'existing share',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/result',
            },
        });
    });

    it('clears removed shared-result comments and issues a fresh preview (L422-L427)', async () => {
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            JSON.stringify({
                commentId: 't1_removed',
                commentUrl: 'https://reddit.com/r/miniracer/comments/daily/removed',
                commentText: 'old share',
                username: 'RaceFan',
                createdAt: '2026-07-14T00:00:00.000Z',
            }),
        );
        reddit.getCommentById.mockImplementationOnce(async () => ({
            id: 't1_removed',
            removed: true,
        }));

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview.body.status).toBe('ready');
        expect(strings.has('dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380')).toBe(false);
    });

    it('formats author-medal share comments with the track name fallback (L115-L125, L501)', () => {
        const text = formatDailyGpShareComment(59990, 'author', '');

        expect(text).toContain('Author');
        expect(text).toContain('🏆');
        expect(text).toContain('59.99');
        expect(text).toContain('Mini Racer');
    });
});
