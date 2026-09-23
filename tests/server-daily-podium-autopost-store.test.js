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
    deleteDailyPodiumAutopostSubscription,
    parseDailyPodiumAutopostSubscription,
    readAllDailyPodiumAutopostSubscriptions,
    readDailyPodiumAutopostSubscription,
    upsertDailyPodiumAutopostSubscription,
} = await import('../src/server/podium/daily-podium-autopost-store.ts');

describe('daily podium autopost store', () => {
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

    it('keeps a concurrent disable final when a podium update acquired the lock first', async () => {
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

        const podiumUpdate = upsertDailyPodiumAutopostSubscription('MiniRacer', (previous) => ({
            subredditName: 'MiniRacer',
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: '2026-07-16T00:00:00.000Z',
            lastPostedChallengeId: 'daily-gp-2026-07-16',
            lastPostedAt: '2026-07-16T00:01:00.000Z',
            lastPostUrl: 'https://reddit.com/podium',
        }));
        await readStarted;
        const disable = deleteDailyPodiumAutopostSubscription('MiniRacer');
        await vi.waitFor(() => {
            expect(mockLocking.acquireRedisLock).toHaveBeenCalledTimes(2);
        });
        continueRead();

        await Promise.all([podiumUpdate, disable]);
        expect(mockState.raw).toBeNull();
    });

    it('keeps a podium update disabled when a concurrent disable acquired the lock first', async () => {
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

        const disable = deleteDailyPodiumAutopostSubscription('MiniRacer');
        await deleteStarted;
        const podiumUpdate = upsertDailyPodiumAutopostSubscription('MiniRacer', (previous) => ({
            subredditName: 'MiniRacer',
            enabled: previous?.enabled ?? false,
            enabledAt: previous?.enabledAt ?? null,
            updatedAt: '2026-07-16T00:00:00.000Z',
            lastPostedChallengeId: 'daily-gp-2026-07-16',
            lastPostedAt: '2026-07-16T00:01:00.000Z',
            lastPostUrl: 'https://reddit.com/podium',
        }));
        await vi.waitFor(() => {
            expect(mockLocking.acquireRedisLock).toHaveBeenCalledTimes(2);
        });
        continueDelete();

        await Promise.all([disable, podiumUpdate]);
        expect(JSON.parse(mockState.raw)).toMatchObject({ enabled: false });
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
