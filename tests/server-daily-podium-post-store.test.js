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
    acquireDailyGpPodiumPostCreationLock,
    DAILY_GP_PODIUM_POST_CREATE_CLAIM_TTL_MS,
    deleteDailyGpPodiumPendingSnapshot,
    readDailyGpPodiumPendingSnapshot,
    readDailyGpPodiumPostRecord,
    releaseDailyGpPodiumPostCreationLock,
    writeDailyGpPodiumPostRecord,
    writeDailyGpPodiumPostRecordIfAbsent,
    writeDailyGpPodiumPendingSnapshot,
} = await import('../src/server/daily-podium-post-store.ts');

describe('daily podium post store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.set.mockResolvedValue('OK');
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.del.mockResolvedValue(1);
    });

    it('reads and writes the canonical subreddit/challenge record', async () => {
        const record = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-10',
            postId: 't3_podium',
            postUrl: 'https://reddit.com/podium',
            createdAt: '2026-07-17T00:01:00.000Z',
        };
        mockRedis.get.mockResolvedValue(JSON.stringify(record));

        await expect(
            readDailyGpPodiumPostRecord(' MiniRacer ', record.challengeId),
        ).resolves.toEqual(record);
        expect(mockRedis.get).toHaveBeenCalledWith(
            `dailygp:podium-post:miniracer:${record.challengeId}`,
        );

        await writeDailyGpPodiumPostRecord(record);
        expect(mockRedis.set).toHaveBeenCalledWith(
            `dailygp:podium-post:miniracer:${record.challengeId}`,
            JSON.stringify(record),
        );
        expect(mockRedis.expire).toHaveBeenCalledWith(
            `dailygp:podium-post:miniracer:${record.challengeId}`,
            45 * 24 * 60 * 60,
        );
    });

    it('rejects malformed records', async () => {
        mockRedis.get.mockResolvedValue(JSON.stringify({
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-10',
            postId: 'invalid',
            postUrl: 'https://reddit.com/podium',
        }));
        await expect(
            readDailyGpPodiumPostRecord('MiniRacer', 'daily-gp-2026-07-10'),
        ).resolves.toBeNull();
    });

    it('stores a pending sanitized snapshot only until the publication deadline', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-17T00:01:00.000Z'));
        const snapshot = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-10',
            expiresAt: '2026-07-17T06:00:00.000Z',
            podium: {
                challengeId: 'daily-gp-2026-07-10',
                challengeDate: '2026-07-10',
                trackName: 'Circuit',
                positions: [1, 2, 3].map((rank) => ({
                    rank,
                    displayName: 'No verified finish',
                    identityType: 'empty',
                    formattedTime: null,
                    avatarUrl: null,
                })),
            },
        };
        mockRedis.get.mockResolvedValue(JSON.stringify(snapshot));

        await expect(
            readDailyGpPodiumPendingSnapshot('MiniRacer', snapshot.challengeId),
        ).resolves.toEqual(snapshot);
        await writeDailyGpPodiumPendingSnapshot(snapshot);
        expect(mockRedis.set).toHaveBeenCalledWith(
            `dailygp:podium-pending:miniracer:${snapshot.challengeId}`,
            JSON.stringify(snapshot),
            { nx: true, expiration: new Date(snapshot.expiresAt) },
        );
        await deleteDailyGpPodiumPendingSnapshot('MiniRacer', snapshot.challengeId);
        expect(mockRedis.del).toHaveBeenCalledWith(
            `dailygp:podium-pending:miniracer:${snapshot.challengeId}`,
        );
    });

    it('uses an owner-checked 15-minute create claim', async () => {
        const now = Date.parse('2026-07-17T00:01:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const lock = await acquireDailyGpPodiumPostCreationLock(
            'MiniRacer',
            'daily-gp-2026-07-10',
        );
        expect(lock).toMatchObject({
            key: 'dailygp:podium-post-create-lock:miniracer:daily-gp-2026-07-10',
        });
        expect(mockRedis.set).toHaveBeenCalledWith(
            lock.key,
            lock.value,
            {
                nx: true,
                expiration: new Date(now + DAILY_GP_PODIUM_POST_CREATE_CLAIM_TTL_MS),
            },
        );
        expect(DAILY_GP_PODIUM_POST_CREATE_CLAIM_TTL_MS).toBe(15 * 60 * 1000);

        mockRedis.get.mockResolvedValue(lock.value);
        await releaseDailyGpPodiumPostCreationLock(lock);
        expect(mockRedis.del).toHaveBeenCalledWith(lock.key);

        mockRedis.get.mockResolvedValue('another-owner');
        await releaseDailyGpPodiumPostCreationLock(lock);
        expect(mockRedis.del).toHaveBeenCalledTimes(1);
    });

    it('returns no lock when Redis rejects NX acquisition', async () => {
        mockRedis.set.mockResolvedValue(null);
        await expect(
            acquireDailyGpPodiumPostCreationLock('MiniRacer', 'daily-gp-2026-07-10'),
        ).resolves.toBeNull();
    });

    it('writes a first-writer-wins post record', async () => {
        const now = Date.parse('2026-07-17T00:01:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const record = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-10',
            postId: 't3_podium',
            postUrl: 'https://reddit.com/podium',
            createdAt: '2026-07-17T00:01:00.000Z',
        };

        await expect(writeDailyGpPodiumPostRecordIfAbsent(record)).resolves.toBe(true);
        expect(mockRedis.set).toHaveBeenCalledWith(
            `dailygp:podium-post:miniracer:${record.challengeId}`,
            JSON.stringify(record),
            {
                nx: true,
                expiration: new Date(now + (45 * 24 * 60 * 60 * 1000)),
            },
        );

        mockRedis.set.mockResolvedValue(null);
        await expect(writeDailyGpPodiumPostRecordIfAbsent(record)).resolves.toBe(false);
    });
});
