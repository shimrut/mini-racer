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
const { getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.js');

const {
    confirmDailyGpShare,
    formatDailyGpShareComment,
    previewDailyGpShare,
    registerDailyGpPost,
} = await import('../src/server/daily-gp-share.ts');

const requestContext = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    appSlug: 'mini-racer',
};

describe('daily GP share wave 2', () => {
    beforeEach(async () => {
        strings.clear();
        vi.clearAllMocks();
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

    it('rejects preview requests without username, subreddit, or app slug', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, { username: ' ', subredditName: 'MiniRacer', appSlug: 'mini-racer' });

        expect(preview).toMatchObject({
            status: 401,
            body: { status: 'signed_in_required' },
        });
    });

    it('rejects confirm when the preview token is missing or unknown', async () => {
        const missing = await confirmDailyGpShare({ shareToken: '' }, requestContext);
        expect(missing).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });

        const unknown = await confirmDailyGpShare({ shareToken: 'missing-token' }, requestContext);
        expect(unknown).toMatchObject({
            status: 409,
            body: { status: 'preview_expired' },
        });
    });

    it('ignores corrupted shared-result records and still issues a fresh preview', async () => {
        strings.set(
            'dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380',
            '{not-json',
        );

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview.body.status).toBe('ready');
        expect(preview.body.shareToken).toBeTruthy();
        expect(strings.has('dailygp:shared-result:miniracer:daily-gp-2026-07-14:racefan:42380')).toBe(true);
    });

    it('formats share comments with and without medal tiers', () => {
        expect(formatDailyGpShareComment(42380, 'gold', 'Classic Circuit')).toContain('Gold');
        expect(formatDailyGpShareComment(42380, null, 'Classic Circuit')).toContain('42.38');
        expect(formatDailyGpShareComment(42380, null, 'Classic Circuit')).not.toContain('medal');
    });

    it('rejects finish previews with invalid replays but accepts standings previews', async () => {
        validateDailyGpReplayDetailed.mockReturnValueOnce({ ok: false });
        const invalid = await previewDailyGpShare({
            source: 'finish',
            challengeId: challenge.id,
            replay: { inputs: [] },
        }, requestContext);
        expect(invalid).toMatchObject({
            status: 422,
            body: { status: 'invalid_replay' },
        });

        const standings = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);
        expect(standings.body.status).toBe('ready');
    });

    it('returns result_unavailable when standings cannot resolve a player best', async () => {
        getServerDailyGpPlayerBest.mockResolvedValueOnce(null);

        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(preview).toMatchObject({
            status: 404,
            body: { status: 'result_unavailable' },
        });
    });

    it('sets the share rate-limit TTL only on the first increment', async () => {
        const rateLimitCalls = () => redis.expire.mock.calls.filter(
            ([key]) => String(key).startsWith('dailygp:share-rate-limit:'),
        );

        await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(rateLimitCalls()).toHaveLength(1);

        await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        expect(rateLimitCalls()).toHaveLength(1);
    });

    it('confirms a preview token and rejects previews owned by another account', async () => {
        const preview = await previewDailyGpShare({
            source: 'standings',
            challengeId: challenge.id,
        }, requestContext);

        const forbidden = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            { ...requestContext, username: 'OtherUser' },
        );
        expect(forbidden).toMatchObject({
            status: 403,
            body: { status: 'share_forbidden' },
        });

        const confirmed = await confirmDailyGpShare(
            { shareToken: preview.body.shareToken },
            requestContext,
        );
        expect(confirmed).toMatchObject({
            status: 200,
            body: { status: 'shared' },
        });
    });
});
