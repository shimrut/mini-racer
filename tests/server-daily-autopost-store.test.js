import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis, mockLocking, mockState } = vi.hoisted(() => ({
    mockState: { raw: null },
    mockRedis: {
        hGet: vi.fn(),
        hGetAll: vi.fn(),
        hSet: vi.fn(),
        hDel: vi.fn(),
    },
    mockLocking: {
        held: new Map(),
        acquireRedisLock: vi.fn(),
        beginOwnedRedisLockTransaction: vi.fn(),
        releaseRedisLock: vi.fn(),
    },
}));

vi.mock('@devvit/web/server', () => ({ redis: mockRedis }));
vi.mock('../src/server/redis/redis-lock.js', () => mockLocking);

const {
    deleteDailyAutopostSubscription,
    parseDailyAutopostSubscription,
    readAllDailyAutopostSubscriptions,
    readDailyAutopostSubscription,
    upsertDailyAutopostSubscription,
} = await import('../src/server/daily/daily-autopost-store.ts');

describe('daily autopost store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLocking.held.clear();
        mockState.raw = null;
        mockRedis.hGet.mockImplementation(async () => mockState.raw);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.hSet.mockImplementation(async (_key, values) => {
            mockState.raw = Object.values(values)[0];
            return 1;
        });
        mockRedis.hDel.mockImplementation(async () => {
            mockState.raw = null;
            return 1;
        });
        mockLocking.acquireRedisLock.mockImplementation(async (key, ttlMs) => {
            if (mockLocking.held.has(key)) return null;
            const lock = { key, value: `owner-${mockLocking.acquireRedisLock.mock.calls.length}`, ttlMs };
            mockLocking.held.set(key, lock.value);
            return lock;
        });
        mockLocking.beginOwnedRedisLockTransaction.mockImplementation(async (lock) => {
            if (mockLocking.held.get(lock.key) !== lock.value) return null;
            const commands = [];
            return {
                async hSet(...args) { commands.push(() => mockRedis.hSet(...args)); },
                async hDel(...args) { commands.push(() => mockRedis.hDel(...args)); },
                async exec() {
                    const results = [];
                    for (const command of commands) results.push(await command());
                    return results;
                },
            };
        });
        mockLocking.releaseRedisLock.mockImplementation(async (lock) => {
            if (!lock || mockLocking.held.get(lock.key) !== lock.value) return false;
            mockLocking.held.delete(lock.key);
            return true;
        });
    });

    it('preserves the existing record defaults and rejects malformed JSON', () => {
        expect(parseDailyAutopostSubscription('MiniRacer', null)).toBeNull();
        expect(parseDailyAutopostSubscription('MiniRacer', undefined)).toBeNull();
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify('enabled'))).toBeNull();
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

    it('keeps a concurrent disable final when a scheduler update acquired the lock first', async () => {
        const existing = JSON.stringify({
            subredditName: 'MiniRacer',
            enabled: true,
            enabledAt: '2026-07-15T00:00:00.000Z',
        });
        mockState.raw = existing;
        let continueRead;
        let announceRead;
        const readStarted = new Promise((resolve) => { announceRead = resolve; });
        mockRedis.hGet.mockImplementationOnce(async () => {
            announceRead();
            await new Promise((resolve) => { continueRead = resolve; });
            return existing;
        });

        const schedulerUpdate = upsertDailyAutopostSubscription('MiniRacer', (previous) => ({
            subredditName: 'MiniRacer',
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: '2026-07-16T00:00:00.000Z',
            lastPostedChallengeId: 'daily-gp-2026-07-16',
            lastPostedAt: '2026-07-16T00:01:00.000Z',
            lastPostUrl: 'https://reddit.com/post',
        }));
        await readStarted;
        const disable = deleteDailyAutopostSubscription('MiniRacer');
        await vi.waitFor(() => {
            expect(mockLocking.acquireRedisLock).toHaveBeenCalledTimes(2);
        });
        continueRead();

        await Promise.all([schedulerUpdate, disable]);
        expect(mockState.raw).toBeNull();
    });

    it('keeps a scheduler update disabled when a concurrent disable acquired the lock first', async () => {
        mockState.raw = JSON.stringify({ subredditName: 'MiniRacer', enabled: true });
        let continueDelete;
        let announceDelete;
        const deleteStarted = new Promise((resolve) => { announceDelete = resolve; });
        mockRedis.hDel.mockImplementationOnce(async () => {
            announceDelete();
            await new Promise((resolve) => { continueDelete = resolve; });
            mockState.raw = null;
            return 1;
        });

        const disable = deleteDailyAutopostSubscription('MiniRacer');
        await deleteStarted;
        const schedulerUpdate = upsertDailyAutopostSubscription('MiniRacer', (previous) => ({
            subredditName: 'MiniRacer',
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: '2026-07-16T00:00:00.000Z',
            lastPostedChallengeId: 'daily-gp-2026-07-16',
            lastPostedAt: '2026-07-16T00:01:00.000Z',
            lastPostUrl: 'https://reddit.com/post',
        }));
        await vi.waitFor(() => {
            expect(mockLocking.acquireRedisLock).toHaveBeenCalledTimes(2);
        });
        continueDelete();

        await Promise.all([disable, schedulerUpdate]);
        expect(JSON.parse(mockState.raw)).toMatchObject({ enabled: false });
    });

    it('keeps string fields only when they are non-empty strings', () => {
        const parsed = parseDailyAutopostSubscription('MiniRacer', JSON.stringify({
            enabled: true,
            enabledAt: '',
            updatedAt: '',
            lastPostedChallengeId: '',
            lastPostedAt: 12,
            lastPostUrl: null,
        }));

        expect(parsed).toEqual({
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
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify({
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
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify({})).enabled).toBe(true);
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify({ enabled: 0 })).enabled).toBe(true);
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify({ enabled: false })).enabled).toBe(false);
    });

    it('rejects empty raw strings and non-object JSON payloads', () => {
        expect(parseDailyAutopostSubscription('MiniRacer', '')).toBeNull();
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify(null))).toBeNull();
        expect(parseDailyAutopostSubscription('MiniRacer', JSON.stringify(5))).toBeNull();
    });
});
