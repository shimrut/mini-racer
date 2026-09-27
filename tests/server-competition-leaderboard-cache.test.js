import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSharedStandingsCacheKey } from '../src/server/competition/competition.ts';

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
vi.mock('../src/server/redis/shared-cache.js', () => ({
    cacheSharedJson: mocks.cacheSharedJson,
}));
vi.mock('../src/server/competition/competition-identity.js', () => ({
    readPlayerProfileMap: mocks.readPlayerProfileMap,
}));
vi.mock('../src/server/competition/pb-ghost-store.js', () => ({
    getPlayerTrackPbRecords: mocks.getPlayerTrackPbRecords,
}));

const { readSnapshot } = await import('../src/server/competition/competition-leaderboard.ts');

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

function stubTwentyPlayerBoard() {
    const members = Array.from({ length: 20 }, (_, index) => ({
        member: `reddit:rank-${index + 1}`,
    }));
    const nearbyEntries = Object.fromEntries(members.map(({ member }, index) => [member, {
        playerId: member,
        trackKey: 'numberZero',
        bestTimeMs: 1000 + index,
        updatedAt: '2026-08-08T00:00:00.000Z',
        completedLaps: 1,
        checkpointTimesSec: [0.5],
        opponentRaceReady: true,
    }]));
    mocks.redis.zCard.mockResolvedValue(20);
    mocks.redis.zRange.mockImplementation(async (_key, start, stop) => (
        members.slice(start, stop + 1)
    ));
    mocks.redis.zRank.mockImplementation(async (_key, playerId) => (
        members.findIndex((member) => member.member === playerId)
    ));
    mocks.redis.hGet.mockImplementation(async (_key, playerId) => (
        JSON.stringify(nearbyEntries[playerId])
    ));
    mocks.redis.hMGet.mockImplementation(async (_key, playerIds) => (
        playerIds.map((playerId) => JSON.stringify(nearbyEntries[playerId]))
    ));
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

    it('skips ghost reads when every row already carries opponentRaceReady', async () => {
        mocks.redis.hMGet.mockImplementation(async (key, playerIds) => playerIds.map((playerId) => (
            JSON.stringify({ ...entries[playerId], opponentRaceReady: true })
        )));

        const snapshot = await readSnapshot({
            competition,
            playerId: 'reddit:alpha',
            limit: 2,
            offset: 0,
        });

        expect(mocks.getPlayerTrackPbRecords).not.toHaveBeenCalled();
        expect(snapshot.topRows.map((row) => row.opponentRaceAvailable)).toEqual([false, true]);
    });

    it('reads ghosts only for unmarked rows', async () => {
        mocks.redis.hMGet.mockImplementation(async (key, playerIds) => playerIds.map((playerId) => (
            JSON.stringify({
                ...entries[playerId],
                opponentRaceReady: playerId === 'reddit:alpha' ? true : undefined,
            })
        )));
        mocks.getPlayerTrackPbRecords.mockResolvedValue(new Map([
            ['reddit:bravo', {
                bestTimeMs: 2000,
                checkpointTimesSec: [1],
                ghost: { finishTimeMs: 2000 },
            }],
        ]));

        const snapshot = await readSnapshot({
            competition,
            playerId: null,
            limit: 2,
            offset: 0,
        });

        expect(mocks.getPlayerTrackPbRecords.mock.calls[0][0].playerIds).toEqual(['reddit:bravo']);
        expect(snapshot.topRows.map((row) => row.opponentRaceAvailable)).toEqual([true, false]);
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

    it('shares the nearby window for viewers at the same rank', async () => {
        stubTwentyPlayerBoard();

        const first = await readSnapshot({
            competition,
            playerId: 'reddit:rank-15',
            limit: 10,
            offset: 0,
        });
        const second = await readSnapshot({
            competition,
            playerId: 'reddit:rank-15',
            limit: 10,
            offset: 0,
        });

        expect(first.nearbyRows.map((row) => row.rank)).toEqual([13, 14, 15, 16, 17]);
        expect(second.nearbyRows.map((row) => row.rank)).toEqual([13, 14, 15, 16, 17]);
        expect(first.nearbyRows.map((row) => row.isCurrentPlayer)).toEqual([
            false, false, true, false, false,
        ]);
        expect(first.nearbyRows[2].opponentRaceAvailable).toBe(false);
        expect(mocks.redis.zRange).toHaveBeenCalledTimes(2);
        expect(mocks.redis.zRange).toHaveBeenNthCalledWith(
            2,
            competition.leaderboardKey,
            12,
            16,
        );
        const nearbyKey = createSharedStandingsCacheKey(competition, 12, 5, 0);
        const topKey = createSharedStandingsCacheKey(competition, 0, 10, 0);
        expect(nearbyKey).not.toBe(topKey);
        const cacheKeys = mocks.cacheSharedJson.mock.calls.map((call) => call[1].key);
        expect(cacheKeys).toEqual([topKey, nearbyKey, topKey, nearbyKey]);
        expect(mocks.cacheSharedJson.mock.calls[1][1]).toMatchObject({ ttl: 10 });
        expect(mocks.getPlayerTrackPbRecords).not.toHaveBeenCalled();
    });

    it('does not share nearby windows for neighbouring ranks', async () => {
        stubTwentyPlayerBoard();

        await readSnapshot({
            competition,
            playerId: 'reddit:rank-15',
            limit: 10,
            offset: 0,
        });
        await readSnapshot({
            competition,
            playerId: 'reddit:rank-16',
            limit: 10,
            offset: 0,
        });

        expect(mocks.redis.zRange).toHaveBeenCalledTimes(3);
        expect(mocks.cacheSharedJson.mock.calls.map((call) => call[1].key)).toEqual([
            createSharedStandingsCacheKey(competition, 0, 10, 0),
            createSharedStandingsCacheKey(competition, 12, 5, 0),
            createSharedStandingsCacheKey(competition, 0, 10, 0),
            createSharedStandingsCacheKey(competition, 13, 5, 0),
        ]);
    });
});
