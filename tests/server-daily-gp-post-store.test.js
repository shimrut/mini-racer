import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis } = vi.hoisted(() => ({
    mockRedis: {
        get: vi.fn(),
        set: vi.fn(),
        expire: vi.fn(),
        del: vi.fn(),
        watch: vi.fn(),
    },
}));

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));

const {
    acquireDailyGpPostCreationLock,
    DAILY_GP_POST_CREATE_CLAIM_TTL_MS,
    readDailyGpPostRecord,
    releaseDailyGpPostCreationLock,
    writeDailyGpPostRecord,
    writeDailyGpPostRecordIfAbsent,
} = await import('../src/server/daily-gp-post-store.ts');

describe('daily GP post store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.set.mockResolvedValue('OK');
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.del.mockResolvedValue(1);
        mockRedis.watch.mockImplementation(async () => {
            const commands = [];
            return {
                multi: vi.fn(async () => undefined),
                unwatch: vi.fn(async () => undefined),
                del: vi.fn(async (...args) => commands.push(() => mockRedis.del(...args))),
                exec: vi.fn(async () => {
                    const results = [];
                    for (const command of commands) results.push(await command());
                    return results;
                }),
            };
        });
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

    it('reads canonical records and rejects malformed or incomplete payloads', async () => {
        const record = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-17',
            postId: 't3_daily',
            postUrl: 'https://reddit.com/daily',
            scoreThreadCommentId: 't1_score',
            createdAt: '2026-07-17T00:05:00.000Z',
            updatedAt: '2026-07-17T00:05:00.000Z',
        };
        mockRedis.get.mockResolvedValue(JSON.stringify(record));
        await expect(
            readDailyGpPostRecord(' MiniRacer ', record.challengeId),
        ).resolves.toEqual({
            ...record,
            scoreThreadCommentId: 't1_score',
        });
        expect(mockRedis.get).toHaveBeenCalledWith(
            `dailygp:post:miniracer:${record.challengeId}`,
        );

        mockRedis.get.mockResolvedValue('{');
        await expect(
            readDailyGpPostRecord('MiniRacer', record.challengeId),
        ).resolves.toBeNull();

        mockRedis.get.mockResolvedValue(JSON.stringify({
            ...record,
            postId: 'not-a-post',
            postUrl: '',
        }));
        await expect(
            readDailyGpPostRecord('MiniRacer', record.challengeId),
        ).resolves.toBeNull();

        mockRedis.get.mockResolvedValue(JSON.stringify({
            ...record,
            scoreThreadCommentId: 'not-a-comment',
        }));
        await expect(
            readDailyGpPostRecord('MiniRacer', record.challengeId),
        ).resolves.toEqual(expect.objectContaining({
            scoreThreadCommentId: null,
            createdAt: record.createdAt,
        }));
    });

    it('normalizes subreddit names with trim and lowercase', async () => {
        const record = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-17',
            postId: 't3_daily',
            postUrl: 'https://reddit.com/daily',
            scoreThreadCommentId: null,
            createdAt: '2026-07-17T00:05:00.000Z',
            updatedAt: '2026-07-17T00:05:00.000Z',
        };
        mockRedis.get.mockResolvedValue(JSON.stringify(record));

        await readDailyGpPostRecord('  MiniRacer  ', record.challengeId);
        expect(mockRedis.get).toHaveBeenCalledWith(
            `dailygp:post:miniracer:${record.challengeId}`,
        );
    });

    it('rejects records missing required string fields or t3_ post ids', async () => {
        const base = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-17',
            postId: 't3_daily',
            postUrl: 'https://reddit.com/daily',
            scoreThreadCommentId: null,
            createdAt: '2026-07-17T00:05:00.000Z',
            updatedAt: '2026-07-17T00:05:00.000Z',
        };
        const rejectCases = [
            { subredditName: 1 },
            { challengeId: null },
            { postId: 't1_comment' },
            { postUrl: null },
        ];
        for (const patch of rejectCases) {
            mockRedis.get.mockResolvedValue(JSON.stringify({ ...base, ...patch }));
            await expect(
                readDailyGpPostRecord('MiniRacer', base.challengeId),
            ).resolves.toBeNull();
        }
    });

    it('falls back createdAt and updatedAt to epoch when missing or non-string', async () => {
        const base = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-17',
            postId: 't3_daily',
            postUrl: 'https://reddit.com/daily',
            scoreThreadCommentId: null,
        };
        mockRedis.get.mockResolvedValue(JSON.stringify({
            ...base,
            createdAt: 123,
            updatedAt: undefined,
        }));
        await expect(
            readDailyGpPostRecord('MiniRacer', base.challengeId),
        ).resolves.toEqual({
            ...base,
            scoreThreadCommentId: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
        });
    });

    it('writes records through the normalized Redis key', async () => {
        const record = {
            subredditName: 'MiniRacer',
            challengeId: 'daily-gp-2026-07-17',
            postId: 't3_daily',
            postUrl: 'https://reddit.com/daily',
            scoreThreadCommentId: null,
            createdAt: '2026-07-17T00:05:00.000Z',
            updatedAt: '2026-07-17T00:05:00.000Z',
        };
        await writeDailyGpPostRecord(record);
        expect(mockRedis.set).toHaveBeenCalledWith(
            `dailygp:post:miniracer:${record.challengeId}`,
            JSON.stringify(record),
        );
        expect(mockRedis.expire).toHaveBeenCalledWith(
            `dailygp:post:miniracer:${record.challengeId}`,
            45 * 24 * 60 * 60,
        );
    });
});
