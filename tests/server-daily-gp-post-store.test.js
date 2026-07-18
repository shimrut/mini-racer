import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis } = vi.hoisted(() => ({
    mockRedis: {
        get: vi.fn(),
        set: vi.fn(),
        expire: vi.fn(),
        del: vi.fn(),
    },
}));

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));

const {
    acquireDailyGpPostCreationLock,
    DAILY_GP_POST_CREATE_CLAIM_TTL_MS,
    releaseDailyGpPostCreationLock,
    writeDailyGpPostRecordIfAbsent,
} = await import('../src/server/daily-gp-post-store.ts');

describe('daily GP post store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.set.mockResolvedValue('OK');
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.del.mockResolvedValue(1);
    });

    it('uses an owner-checked 15-minute create claim', async () => {
        const now = Date.parse('2026-07-17T00:05:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const lock = await acquireDailyGpPostCreationLock(
            'MiniRacer',
            'daily-gp-2026-07-17',
        );
        expect(lock).toMatchObject({
            key: 'dailygp:post-create-lock:miniracer:daily-gp-2026-07-17',
        });
        expect(mockRedis.set).toHaveBeenCalledWith(
            lock.key,
            lock.value,
            {
                nx: true,
                expiration: new Date(now + DAILY_GP_POST_CREATE_CLAIM_TTL_MS),
            },
        );
        expect(DAILY_GP_POST_CREATE_CLAIM_TTL_MS).toBe(15 * 60 * 1000);

        mockRedis.get.mockResolvedValue(lock.value);
        await releaseDailyGpPostCreationLock(lock);
        expect(mockRedis.del).toHaveBeenCalledWith(lock.key);

        mockRedis.get.mockResolvedValue('another-owner');
        await releaseDailyGpPostCreationLock(lock);
        expect(mockRedis.del).toHaveBeenCalledTimes(1);
    });

    it('returns no lock when Redis rejects NX acquisition', async () => {
        mockRedis.set.mockResolvedValue(null);
        await expect(
            acquireDailyGpPostCreationLock('MiniRacer', 'daily-gp-2026-07-17'),
        ).resolves.toBeNull();
    });

    it('writes a first-writer-wins post record', async () => {
        const now = Date.parse('2026-07-17T00:05:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const record = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-17',
            postId: 't3_daily',
            postUrl: 'https://reddit.com/daily',
            scoreThreadCommentId: null,
            createdAt: '2026-07-17T00:05:00.000Z',
            updatedAt: '2026-07-17T00:05:00.000Z',
        };

        await expect(writeDailyGpPostRecordIfAbsent(record)).resolves.toBe(true);
        expect(mockRedis.set).toHaveBeenCalledWith(
            `dailygp:post:miniracer:${record.challengeId}`,
            JSON.stringify(record),
            {
                nx: true,
                expiration: new Date(now + (45 * 24 * 60 * 60 * 1000)),
            },
        );

        mockRedis.set.mockResolvedValue(null);
        await expect(writeDailyGpPostRecordIfAbsent(record)).resolves.toBe(false);
    });
});
