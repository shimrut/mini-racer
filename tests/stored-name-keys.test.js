import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis, lockKeys } = vi.hoisted(() => ({
    lockKeys: [],
    mockRedis: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => 'OK'),
        del: vi.fn(async () => undefined),
        expire: vi.fn(async () => undefined),
        hGet: vi.fn(async () => undefined),
        hSet: vi.fn(async () => 1),
    },
}));

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('../src/server/redis/redis-lock.js', () => ({
    acquireRedisLock: vi.fn(async (key) => {
        lockKeys.push(key);
        return { key, value: 'lock', ttlMs: 1 };
    }),
    releaseRedisLock: vi.fn(async () => true),
}));

const {
    acquireDailyGpPostCreationLock,
    createPostRecordKey,
} = await import('../src/server/daily/daily-gp-post-store.ts');
const {
    acquireDailyGpPodiumPostCreationLock,
    createPodiumPostRecordKey,
    readDailyGpPodiumPendingSnapshot,
} = await import('../src/server/podium/daily-podium-post-store.ts');
const {
    acquireLauncherPostCreationLock,
    LAUNCHER_POSTS_KEY,
    readLauncherPostRecord,
} = await import('../src/server/posts/launcher-post-store.ts');
const { headToHeadShareResultKey } = await import('../src/server/head-to-head/head-to-head-share.ts');
const { headToHeadCatalogCardsKey } = await import('../src/server/head-to-head/head-to-head-catalog.ts');
const { readHeadToHeadPostIdentity } = await import('../src/server/head-to-head/head-to-head-store.ts');

const SUBREDDIT = '  MiniRacerGame ';

describe('stored names from Reddit names', () => {
    beforeEach(() => {
        lockKeys.length = 0;
        vi.clearAllMocks();
    });

    it('keeps the Daily post keys', async () => {
        expect(createPostRecordKey(SUBREDDIT, 'daily-2026-09-23'))
            .toBe('dailygp:post:miniracergame:daily-2026-09-23');
        await acquireDailyGpPostCreationLock(SUBREDDIT, 'daily-2026-09-23');
        expect(lockKeys).toEqual(['dailygp:post-create-lock:miniracergame:daily-2026-09-23']);
    });

    it('keeps the podium post keys', async () => {
        expect(createPodiumPostRecordKey(SUBREDDIT, 'daily-2026-09-23'))
            .toBe('dailygp:podium-post:miniracergame:daily-2026-09-23');
        await acquireDailyGpPodiumPostCreationLock(SUBREDDIT, 'daily-2026-09-23');
        expect(lockKeys).toEqual(['dailygp:podium-post-create-lock:miniracergame:daily-2026-09-23']);
        await readDailyGpPodiumPendingSnapshot(SUBREDDIT, 'daily-2026-09-23');
        expect(mockRedis.get).toHaveBeenCalledWith('dailygp:podium-pending:miniracergame:daily-2026-09-23');
    });

    it('keeps the launcher post field and lock key', async () => {
        await readLauncherPostRecord(SUBREDDIT, 'daily');
        expect(mockRedis.hGet).toHaveBeenCalledWith(LAUNCHER_POSTS_KEY, 'miniracergame:daily');
        await acquireLauncherPostCreationLock(SUBREDDIT, 'campaign');
        expect(lockKeys).toEqual(['miniracer:launcher-post-create-lock:miniracergame:campaign']);
    });

    it('keeps the Head to Head shared result key', () => {
        expect(headToHeadShareResultKey({
            action: 'brag',
            challengeId: 'h2h-1',
            username: ' SpeedyRacer ',
            timeMs: 7100,
        })).toBe('miniracer:head-to-head:shared:brag:h2h-1:speedyracer:7100');
    });

    it('keeps the Head to Head catalog and post identity keys', async () => {
        expect(headToHeadCatalogCardsKey(' Mini Racer '))
            .toBe('miniracer:head-to-head:catalog:mini%20racer:cards');
        await readHeadToHeadPostIdentity(' Mini Racer ', ' Speedy Racer', 'race-1', 7100);
        expect(mockRedis.get).toHaveBeenCalledWith(
            'miniracer:head-to-head:post:mini%20racer:speedy%20racer:race-1:7100',
        );
    });
});
