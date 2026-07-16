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
    deleteDailyAutopostSubscription,
    parseDailyAutopostSubscription,
    readAllDailyAutopostSubscriptions,
    readDailyAutopostSubscription,
    upsertDailyAutopostSubscription,
} = await import('../src/server/daily-autopost-store.ts');

describe('daily autopost store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hDel.mockResolvedValue(1);
    });

    it('preserves the existing record defaults and rejects malformed JSON', () => {
        expect(parseDailyAutopostSubscription('MiniRacer', '{')).toBeNull();
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify({
            enabled: false,
            lastPostUrl: 'https://reddit.com/post',
        }))).toEqual({
            subredditName: 'MiniRacer',
            enabled: false,
            enabledAt: null,
            updatedAt: new Date(0).toISOString(),
            lastPostedChallengeId: null,
            lastPostedAt: null,
            lastPostUrl: 'https://reddit.com/post',
        });
    });

    it('reads and filters subscriptions from the existing Redis hash', async () => {
        mockRedis.hGet.mockResolvedValue(JSON.stringify({ enabled: true }));
        await expect(readDailyAutopostSubscription('MiniRacer')).resolves.toMatchObject({
            subredditName: 'MiniRacer',
            enabled: true,
        });

        mockRedis.hGetAll.mockResolvedValue({
            MiniRacer: JSON.stringify({ enabled: true }),
            Broken: '{',
        });
        await expect(readAllDailyAutopostSubscriptions()).resolves.toEqual([
            expect.objectContaining({ subredditName: 'MiniRacer', enabled: true }),
        ]);
    });

    it('upserts and deletes using the unchanged Redis key and field names', async () => {
        mockRedis.hGet.mockResolvedValue(JSON.stringify({
            enabled: false,
            enabledAt: '2026-07-15T00:00:00.000Z',
        }));

        await upsertDailyAutopostSubscription('MiniRacer', (previous) => ({
            ...previous,
            enabled: true,
            updatedAt: '2026-07-16T00:00:00.000Z',
        }));
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            'dailygp:autopost:subreddits',
            {
                MiniRacer: expect.stringContaining('"enabled":true'),
            },
        );

        await deleteDailyAutopostSubscription('MiniRacer');
        expect(mockRedis.hDel).toHaveBeenCalledWith(
            'dailygp:autopost:subreddits',
            ['MiniRacer'],
        );
    });
});
