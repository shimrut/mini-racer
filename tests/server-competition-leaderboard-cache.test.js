import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    redis: {
        get: vi.fn(),
        zCard: vi.fn(),
        zRange: vi.fn(),
        zRank: vi.fn(),
        hGet: vi.fn(),
        hMGet: vi.fn(),
    },
    cacheSharedJson: vi.fn(),
    readPlayerProfileMap: vi.fn(),
    getPlayerTrackPbRecords: vi.fn(),
}));

vi.mock('@devvit/redis', () => ({ redis: mocks.redis }));
vi.mock('../src/server/shared-cache.js', () => ({
    cacheSharedJson: mocks.cacheSharedJson,
}));
vi.mock('../src/server/competition-identity.js', () => ({
    readPlayerProfileMap: mocks.readPlayerProfileMap,
}));
vi.mock('../src/server/pb-ghost-store.js', () => ({
    getPlayerTrackPbRecords: mocks.getPlayerTrackPbRecords,
}));

const { readSnapshot } = await import('../src/server/competition-leaderboard.ts');

const competition = {
    id: 'daily-gp-2026-08-08',
    mode: 'daily',
    trackKey: 'numberZero',
    lapCount: 1,
    rulesRevision: 1,
    objectiveType: 'single_lap_fastest',
    leaderboardKey: 'dailygp:leaderboard:daily-gp-2026-08-08',
    entryHashKey: 'dailygp:entries:daily-gp-2026-08-08',
    standingsRevisionKey: 'dailygp:leaderboard:daily-gp-2026-08-08:standings-revision',
    pbHashKey: 'dailygp:challenge-pbs:daily-gp-2026-08-08',
    ttlSeconds: 3600,
    allowGuests: true,
};

const entries = {
    'reddit:alpha': {
        playerId: 'reddit:alpha',
        trackKey: 'numberZero',
        bestTimeMs: 1000,
        updatedAt: '2026-08-08T00:00:00.000Z',
        completedLaps: 1,
        checkpointTimesSec: [0.5],
    },
    'reddit:bravo': {
        playerId: 'reddit:bravo',
        trackKey: 'numberZero',
        bestTimeMs: 2000,
        updatedAt: '2026-08-08T00:01:00.000Z',
        completedLaps: 1,
        checkpointTimesSec: [1],
    },
};

function rawEntry(playerId) {
    return JSON.stringify(entries[playerId]);
}

function profileMap(playerIds) {
    return new Map(playerIds.map((playerId) => [playerId, {
        playerId,
        leaderboardIdentity: 'reddit',
        redditUsername: playerId.split(':')[1],
    }]));
}

describe('shared standings page reads', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.redis.get.mockResolvedValue('0');
        mocks.redis.zCard.mockResolvedValue(2);
        mocks.redis.zRange.mockResolvedValue([
            { member: 'reddit:alpha' },
            { member: 'reddit:bravo' },
        ]);
        mocks.redis.zRank.mockImplementation(async (key, playerId) => (
            playerId === 'reddit:alpha' ? 0 : 1
        ));
        mocks.redis.hGet.mockImplementation(async (key, playerId) => rawEntry(playerId));
        mocks.redis.hMGet.mockImplementation(async (key, playerIds) => playerIds.map(rawEntry));
        mocks.readPlayerProfileMap.mockImplementation(async (playerIds) => profileMap(playerIds));
        mocks.getPlayerTrackPbRecords.mockResolvedValue(new Map());
        const values = new Map();
        mocks.cacheSharedJson.mockImplementation(async (source, options) => {
            if (values.has(options.key)) return values.get(options.key);
            const value = await source();
            values.set(options.key, value);
            return value;
        });
    });

    it('shares the public page while overlaying each viewer live', async () => {
        const first = await readSnapshot({
            competition,
            playerId: 'reddit:alpha',
            limit: 2,
            offset: 0,
        });
        const second = await readSnapshot({
            competition,
            playerId: 'reddit:bravo',
            limit: 2,
            offset: 0,
        });

        expect(first.topRows.map((row) => row.isCurrentPlayer)).toEqual([true, false]);
        expect(second.topRows.map((row) => row.isCurrentPlayer)).toEqual([false, true]);
        expect(first.currentPlayerRow.displayName).toBe('alpha');
        expect(second.currentPlayerRow.displayName).toBe('bravo');
        expect(mocks.redis.zRange).toHaveBeenCalledOnce();
        expect(mocks.redis.zCard).toHaveBeenCalledOnce();
        expect(mocks.getPlayerTrackPbRecords).toHaveBeenCalledOnce();
        expect(mocks.getPlayerTrackPbRecords.mock.calls[0][0].playerIds)
            .toEqual(['reddit:alpha', 'reddit:bravo']);
        expect(mocks.cacheSharedJson).toHaveBeenCalledTimes(2);
        expect(mocks.cacheSharedJson.mock.calls[0][1]).toMatchObject({ ttl: 10 });
        expect(mocks.cacheSharedJson.mock.calls[0][1].key)
            .toBe(mocks.cacheSharedJson.mock.calls[1][1].key);
    });

    it('uses a new page source after the atomically advanced revision changes', async () => {
        await readSnapshot({ competition, playerId: null, limit: 2, offset: 0 });
        mocks.redis.get.mockResolvedValue('1');
        await readSnapshot({ competition, playerId: null, limit: 2, offset: 0 });

        expect(mocks.cacheSharedJson).toHaveBeenCalledTimes(2);
        expect(mocks.cacheSharedJson.mock.calls[0][1].key)
            .not.toBe(mocks.cacheSharedJson.mock.calls[1][1].key);
        expect(mocks.redis.zRange).toHaveBeenCalledTimes(2);
    });

    it('falls back to Redis when a cached page is malformed', async () => {
        mocks.cacheSharedJson.mockResolvedValue({ rows: 'invalid' });

        const snapshot = await readSnapshot({
            competition,
            playerId: null,
            limit: 2,
            offset: 0,
        });

        expect(snapshot.topRows).toHaveLength(2);
        expect(mocks.cacheSharedJson).toHaveBeenCalledOnce();
        expect(mocks.redis.zRange).toHaveBeenCalledOnce();
    });
});
