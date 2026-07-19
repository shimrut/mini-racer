import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis } = vi.hoisted(() => ({
    mockRedis: {
        hGet: vi.fn(),
        hGetAll: vi.fn(),
        hSet: vi.fn(),
        hDel: vi.fn(),
    },
}));

vi.mock('@devvit/web/server', () => ({ redis: mockRedis }));

const {
    deleteDailyPodiumAutopostSubscription,
    parseDailyPodiumAutopostSubscription,
    readAllDailyPodiumAutopostSubscriptions,
    readDailyPodiumAutopostSubscription,
    upsertDailyPodiumAutopostSubscription,
} = await import('../src/server/daily-podium-autopost-store.ts');

describe('daily podium autopost store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hDel.mockResolvedValue(1);
    });

    it('parses valid subscriptions and rejects malformed records', () => {
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', null)).toBeNull();
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', undefined)).toBeNull();
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify('enabled'))).toBeNull();
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', '{')).toBeNull();
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify({
            enabled: false,
            lastPostUrl: 'https://reddit.com/podium',
        }))).toEqual({
            subredditName: 'MiniRacer',
            enabled: false,
            enabledAt: null,
            updatedAt: new Date(0).toISOString(),
            lastPostedChallengeId: null,
            lastPostedAt: null,
            lastPostUrl: 'https://reddit.com/podium',
        });
    });

    it('reads and filters the independent podium subscription hash', async () => {
        mockRedis.hGet.mockResolvedValue(JSON.stringify({ enabled: true }));
        await expect(readDailyPodiumAutopostSubscription('MiniRacer')).resolves.toMatchObject({
            subredditName: 'MiniRacer',
            enabled: true,
        });

        mockRedis.hGetAll.mockResolvedValue({
            MiniRacer: JSON.stringify({ enabled: true }),
            Broken: '{',
        });
        await expect(readAllDailyPodiumAutopostSubscriptions()).resolves.toEqual([
            expect.objectContaining({ subredditName: 'MiniRacer', enabled: true }),
        ]);
        expect(mockRedis.hGetAll).toHaveBeenCalledWith('dailygp:podium-autopost:subreddits');
    });

    it('upserts and deletes without touching daily race subscriptions', async () => {
        mockRedis.hGet.mockResolvedValue(JSON.stringify({ enabled: false }));
        await upsertDailyPodiumAutopostSubscription('MiniRacer', (previous) => ({
            ...previous,
            subredditName: 'MiniRacer',
            enabled: true,
            updatedAt: '2026-07-17T00:00:00.000Z',
        }));
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            'dailygp:podium-autopost:subreddits',
            { MiniRacer: expect.stringContaining('"enabled":true') },
        );

        await deleteDailyPodiumAutopostSubscription('MiniRacer');
        expect(mockRedis.hDel).toHaveBeenCalledWith(
            'dailygp:podium-autopost:subreddits',
            ['MiniRacer'],
        );
    });

    it('keeps string fields only when they are non-empty strings', () => {
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify({
            enabled: true,
            enabledAt: '',
            updatedAt: '',
            lastPostedChallengeId: '',
            lastPostedAt: 12,
            lastPostUrl: null,
        }))).toEqual({
            subredditName: 'MiniRacer',
            enabled: true,
            enabledAt: null,
            updatedAt: new Date(0).toISOString(),
            lastPostedChallengeId: null,
            lastPostedAt: null,
            lastPostUrl: null,
        });
    });

    it('preserves populated string schedule fields verbatim', () => {
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify({
            enabled: true,
            enabledAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-02T00:00:00.000Z',
            lastPostedChallengeId: 'daily-gp-2026-07-01',
            lastPostedAt: '2026-07-01T12:00:00.000Z',
            lastPostUrl: 'https://reddit.com/r/x/comments/abc',
        }))).toEqual({
            subredditName: 'MiniRacer',
            enabled: true,
            enabledAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-02T00:00:00.000Z',
            lastPostedChallengeId: 'daily-gp-2026-07-01',
            lastPostedAt: '2026-07-01T12:00:00.000Z',
            lastPostUrl: 'https://reddit.com/r/x/comments/abc',
        });
    });

    it('defaults enabled to true unless explicitly false', () => {
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify({})).enabled).toBe(true);
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify({ enabled: false })).enabled).toBe(false);
    });

    it('rejects empty raw strings and non-object JSON payloads', () => {
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', '')).toBeNull();
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify(null))).toBeNull();
        expect(parseDailyPodiumAutopostSubscription('MiniRacer', JSON.stringify(5))).toBeNull();
    });
});
