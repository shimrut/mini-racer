import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
    createDailyChallengeId,
    DAY_MS,
    formatUtcChallengeDate,
    getUtcDayIndex,
} from '../src/server/daily-gp-model.ts';
import { TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';

function getTodayChallengeIdForTest() {
    const dayIndex = getUtcDayIndex(new Date());
    const startsAt = new Date(dayIndex * DAY_MS);
    return createDailyChallengeId(formatUtcChallengeDate(startsAt));
}

const mockRedis = {
    get: vi.fn(),
    mGet: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incrBy: vi.fn(),
    hGet: vi.fn(),
    hMGet: vi.fn(),
    hSet: vi.fn(),
    hSetNX: vi.fn(),
    hGetAll: vi.fn(),
    hScan: vi.fn(),
    hDel: vi.fn(),
    expire: vi.fn(),
    expireTime: vi.fn(),
    zAdd: vi.fn(),
    zCard: vi.fn(),
    zRange: vi.fn(),
    zRank: vi.fn(),
    zRem: vi.fn(),
    zScore: vi.fn(),
    watch: vi.fn(),
};

const ownedLocks = new Map();
const storedStrings = new Map();

function createMockTransaction(options = {}) {
    const commands = [];
    const hasExecResult = Object.prototype.hasOwnProperty.call(options, 'execResult');
    let hasLeaderboardWrite = false;
    return {
        multi: vi.fn().mockResolvedValue(undefined),
        unwatch: vi.fn().mockResolvedValue(undefined),
        del: vi.fn(async (...args) => {
            commands.push(() => mockRedis.del(...args));
        }),
        set: vi.fn(async (...args) => {
            commands.push(() => mockRedis.set(...args));
        }),
        hSet: vi.fn(async (...args) => {
            commands.push(() => mockRedis.hSet(...args));
        }),
        zAdd: vi.fn(async (...args) => {
            hasLeaderboardWrite = true;
            commands.push(() => mockRedis.zAdd(...args));
        }),
        incrBy: vi.fn(async (...args) => {
            commands.push(() => mockRedis.incrBy(...args));
        }),
        expire: vi.fn(async (...args) => {
            commands.push(() => mockRedis.expire(...args));
        }),
        hDel: vi.fn(async (...args) => {
            commands.push(() => mockRedis.hDel(...args));
        }),
        zRem: vi.fn(async (...args) => {
            commands.push(() => mockRedis.zRem(...args));
        }),
        exec: vi.fn(async () => {
            if (hasExecResult && hasLeaderboardWrite) {
                return options.execResult;
            }
            const results = [];
            for (const command of commands) {
                results.push(await command());
            }
            return results;
        }),
    };
}

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));

describe('mergeGuestDailyProgress', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ownedLocks.clear();
        storedStrings.clear();
        mockRedis.get.mockImplementation(async (key) => ownedLocks.get(key) ?? storedStrings.get(key) ?? null);
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (options.nx && (ownedLocks.has(key) || storedStrings.has(key))) return '';
            if (String(key).includes('lock:') || String(key).includes('-lock:')) {
                ownedLocks.set(key, value);
            } else {
                storedStrings.set(key, value);
            }
            return 'OK';
        });
        mockRedis.del.mockImplementation(async (key) => {
            ownedLocks.delete(key);
            storedStrings.delete(key);
        });
        mockRedis.incrBy.mockResolvedValue(1);
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hMGet.mockResolvedValue([]);
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.hScan.mockResolvedValue({ cursor: 0, fieldValues: [] });
        mockRedis.hDel.mockResolvedValue(1);
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 60);
        mockRedis.zAdd.mockResolvedValue(1);
        mockRedis.zCard.mockResolvedValue(0);
        mockRedis.zRange.mockResolvedValue([]);
        mockRedis.zRank.mockResolvedValue(undefined);
        mockRedis.zScore.mockResolvedValue(null);
        mockRedis.zRem.mockResolvedValue(1);
        mockRedis.watch.mockImplementation(() => createMockTransaction());
    });

    it('moves a faster guest Daily time while retaining the source for transfer retry', async () => {
        const challengeId = getTodayChallengeIdForTest();
        const trackKey = TRACK_SCHEDULE_KEYS[0];
        const guestPlayerId = 'guest:daily-guest-merge';
        const redditPlayerId = 'reddit:daily-claimed';
        const entryHashKey = `dailygp:leaderboard:${challengeId}:entries`;
        const leaderboardKey = `dailygp:leaderboard:${challengeId}`;
        const updatedAt = '2026-07-27T10:00:00.000Z';
        const guestEntry = {
            playerId: guestPlayerId,
            trackKey,
            bestTimeMs: 9000,
            updatedAt,
            completedLaps: 1,
            checkpointTimesSec: [4.5],
            validationMethod: 'strict-replay',
        };

        mockRedis.hGet.mockImplementation(async (key, field) => {
            if (key === entryHashKey && field === guestPlayerId) {
                return JSON.stringify(guestEntry);
            }
            if (key === entryHashKey && field === redditPlayerId) {
                return null;
            }
            return null;
        });
        mockRedis.hMGet.mockImplementation(async (key, fields) => {
            if (key !== entryHashKey) return [];
            return fields.map((field) => (
                field === guestPlayerId ? JSON.stringify(guestEntry) : null
            ));
        });

        const {
            cleanupGuestDailyProgress,
            mergeGuestDailyProgress,
        } = await import('../src/server/daily-gp-store.ts');
        const result = await mergeGuestDailyProgress({
            guestPlayerId,
            redditPlayerId,
        });

        expect(result).toEqual({
            merged: true,
            mergedChallengeIds: [challengeId],
        });
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            entryHashKey,
            expect.objectContaining({
                [redditPlayerId]: expect.stringContaining('"bestTimeMs":9000'),
            }),
        );
        expect(mockRedis.zRem).not.toHaveBeenCalledWith(leaderboardKey, [guestPlayerId]);
        expect(mockRedis.hDel).not.toHaveBeenCalledWith(entryHashKey, [guestPlayerId]);

        await cleanupGuestDailyProgress({ guestPlayerId });
        expect(mockRedis.zRem).toHaveBeenCalledWith(leaderboardKey, [guestPlayerId]);
        expect(mockRedis.hDel).toHaveBeenCalledWith(entryHashKey, [guestPlayerId]);
    });

    it('retains a slower guest row without overwriting a faster Reddit time', async () => {
        const challengeId = getTodayChallengeIdForTest();
        const trackKey = TRACK_SCHEDULE_KEYS[0];
        const guestPlayerId = 'guest:daily-guest-slow';
        const redditPlayerId = 'reddit:daily-fast';
        const entryHashKey = `dailygp:leaderboard:${challengeId}:entries`;
        const leaderboardKey = `dailygp:leaderboard:${challengeId}`;
        const updatedAt = '2026-07-27T10:00:00.000Z';
        const guestEntry = {
            playerId: guestPlayerId,
            trackKey,
            bestTimeMs: 12000,
            updatedAt,
            completedLaps: 1,
            checkpointTimesSec: [6],
            validationMethod: 'strict-replay',
        };
        const redditEntry = {
            playerId: redditPlayerId,
            trackKey,
            bestTimeMs: 8000,
            updatedAt,
            completedLaps: 1,
            checkpointTimesSec: [4],
            validationMethod: 'strict-replay',
        };

        mockRedis.hGet.mockImplementation(async (key, field) => {
            if (key === entryHashKey && field === guestPlayerId) {
                return JSON.stringify(guestEntry);
            }
            if (key === entryHashKey && field === redditPlayerId) {
                return JSON.stringify(redditEntry);
            }
            return null;
        });
        mockRedis.zScore.mockResolvedValue(8000);

        const { mergeGuestDailyProgress } = await import('../src/server/daily-gp-store.ts');
        const result = await mergeGuestDailyProgress({
            guestPlayerId,
            redditPlayerId,
        });

        expect(result).toEqual({ merged: false, mergedChallengeIds: [] });
        expect(mockRedis.zRem).not.toHaveBeenCalledWith(leaderboardKey, [guestPlayerId]);
        expect(mockRedis.hDel).not.toHaveBeenCalledWith(entryHashKey, [guestPlayerId]);
        const redditWrites = mockRedis.hSet.mock.calls.filter((call) => (
            call[0] === entryHashKey
            && typeof call[1]?.[redditPlayerId] === 'string'
            && JSON.parse(call[1][redditPlayerId]).bestTimeMs === 8000
        ));
        expect(redditWrites.length).toBe(0);
    });
});
