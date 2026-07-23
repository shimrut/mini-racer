import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import { DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS, getDailyGpCompetitionTtlSeconds } from '../src/server/daily-gp-model.ts';

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
    watch: vi.fn(),
};
const mockValidateDailyGpReplayDetailed = vi.fn();

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateDailyGpReplayDetailed,
}));

describe('server daily gp store wave 2', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.set.mockResolvedValue('OK');
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hMGet.mockResolvedValue([]);
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.hScan.mockResolvedValue({ cursor: 0, fieldValues: [] });
        mockRedis.hDel.mockResolvedValue(0);
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.zCard.mockResolvedValue(0);
        mockRedis.zRange.mockResolvedValue([]);
        mockRedis.zRank.mockResolvedValue(undefined);
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 12.345,
                bestTimeMs: 12345,
                completedLaps: 1,
                checkpointTimesSec: [],
                ghost: null,
            },
        });
    });

    it('rejects stored challenges whose id regex or challengeDate do not match', async () => {
        const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify({
            id: 'not-a-daily-id',
            challengeDate: '2026-07-11',
            trackKey: 'circuit',
            startsAt: '2026-07-11T00:00:00.000Z',
            endsAt: '2026-07-12T00:00:00.000Z',
            availableUntil: '2026-07-18T00:00:00.000Z',
        }));
        await expect(getServerDailyGpChallengeById('not-a-daily-id')).resolves.toBeNull();

        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify({
            id: 'daily-gp-2026-07-11',
            challengeDate: '',
            trackKey: 'circuit',
            startsAt: '2026-07-11T00:00:00.000Z',
            endsAt: '2026-07-12T00:00:00.000Z',
            availableUntil: '2026-07-18T00:00:00.000Z',
        }));
        await expect(getServerDailyGpChallengeById('daily-gp-2026-07-11')).resolves.toBeNull();
    });

    it('rejects stored challenges with non-parseable schedule timestamps', async () => {
        const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify({
            id: 'daily-gp-2026-07-11',
            challengeDate: '2026-07-11',
            trackKey: 'circuit',
            startsAt: 'not-a-date',
            endsAt: '2026-07-12T00:00:00.000Z',
            availableUntil: '2026-07-18T00:00:00.000Z',
        }));

        await expect(getServerDailyGpChallengeById('daily-gp-2026-07-11')).resolves.toBeNull();
    });

    it('rotates to the next catalog track after the most recent ledger entry', async () => {
        const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        const priorTrack = TRACK_SCHEDULE_KEYS[0];
        const expectedNext = TRACK_SCHEDULE_KEYS[1] || TRACK_SCHEDULE_KEYS[0];
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hGetAll.mockResolvedValue({
            'daily-gp-2026-07-10': JSON.stringify({
                id: 'daily-gp-2026-07-10',
                challengeDate: '2026-07-10',
                trackKey: priorTrack,
                startsAt: '2026-07-10T00:00:00.000Z',
                endsAt: '2026-07-11T00:00:00.000Z',
                availableUntil: '2026-07-17T00:00:00.000Z',
            }),
        });
        mockRedis.hSetNX.mockResolvedValue(1);

        const challenge = await getServerDailyGpChallenge();

        expect(challenge.trackKey).toBe(expectedNext);
    });

    it('deletes expired challenge-history fields during maintenance', async () => {
        const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2030-07-02',
            challengeDate: '2030-07-02',
            trackKey: 'circuit',
            startsAt: '2030-07-02T00:00:00.000Z',
            endsAt: '2030-07-03T00:00:00.000Z',
            availableUntil: '2030-07-09T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hScan.mockResolvedValue({
            cursor: 4,
            fieldValues: [{
                field: 'daily-gp-2010-01-01',
                value: JSON.stringify({
                    id: 'daily-gp-2010-01-01',
                    challengeDate: '2010-01-01',
                    trackKey: 'circuit',
                    startsAt: '2010-01-01T00:00:00.000Z',
                    endsAt: '2010-01-02T00:00:00.000Z',
                    availableUntil: '2010-01-08T00:00:00.000Z',
                }),
            }],
        });

        await persistServerDailyGpChallenge(challenge);

        expect(mockRedis.hDel).toHaveBeenCalledWith(
            'dailygp:challenges',
            ['daily-gp-2010-01-01'],
        );
        expect(mockRedis.set).toHaveBeenCalledWith(
            'dailygp:maintenance:challenge-history:v1:cursor',
            '4',
        );
    });

    it('deletes history entries at or before the cutoff but keeps entries just after it', async () => {
        vi.useFakeTimers();
        const now = new Date('2030-03-15T12:00:00.000Z');
        vi.setSystemTime(now);
        const cutoffMs = now.getTime() - (DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS * 1000);
        const atCutoff = {
            id: 'daily-gp-2030-01-14',
            challengeDate: '2030-01-14',
            trackKey: 'circuit',
            startsAt: new Date(cutoffMs).toISOString(),
            endsAt: '2030-01-15T00:00:00.000Z',
            availableUntil: '2030-01-21T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const beforeCutoff = {
            ...atCutoff,
            id: 'daily-gp-2030-01-13',
            challengeDate: '2030-01-13',
            startsAt: new Date(cutoffMs - 1).toISOString(),
        };
        const afterCutoff = {
            ...atCutoff,
            id: 'daily-gp-2030-01-15',
            challengeDate: '2030-01-15',
            startsAt: new Date(cutoffMs + 1).toISOString(),
        };
        const current = {
            id: 'daily-gp-2030-03-15',
            challengeDate: '2030-03-15',
            trackKey: 'circuit',
            startsAt: '2030-03-15T00:00:00.000Z',
            endsAt: '2030-03-16T00:00:00.000Z',
            availableUntil: '2030-03-22T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hScan.mockResolvedValue({
            cursor: 2,
            fieldValues: [
                { field: beforeCutoff.id, value: JSON.stringify(beforeCutoff) },
                { field: atCutoff.id, value: JSON.stringify(atCutoff) },
                { field: afterCutoff.id, value: JSON.stringify(afterCutoff) },
            ],
        });

        await persistServerDailyGpChallenge(current);

        expect(mockRedis.hDel).toHaveBeenCalledWith(
            'dailygp:challenges',
            [beforeCutoff.id, atCutoff.id],
        );
        expect(mockRedis.expire).toHaveBeenCalledWith(
            `dailygp:leaderboard:${afterCutoff.id}`,
            getDailyGpCompetitionTtlSeconds(afterCutoff),
        );

        vi.useRealTimers();
    });

    it('falls back to the first catalog track when the playhead track left the schedule', async () => {
        const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hGetAll.mockResolvedValue({
            'daily-gp-2026-07-10': JSON.stringify({
                id: 'daily-gp-2026-07-10',
                challengeDate: '2026-07-10',
                trackKey: 'removed-from-schedule-track',
                startsAt: '2026-07-10T00:00:00.000Z',
                endsAt: '2026-07-11T00:00:00.000Z',
                availableUntil: '2026-07-17T00:00:00.000Z',
            }),
        });
        mockRedis.hSetNX.mockResolvedValue(1);

        const challenge = await getServerDailyGpChallenge();

        expect(challenge.trackKey).toBe(TRACK_SCHEDULE_KEYS[0]);
    });

    it('uses community totals only when they are at least one', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.zCard.mockResolvedValue(0);
        mockRedis.zRange.mockResolvedValue([]);

        const rejected = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            communityMemberTotal: 0,
        });
        const accepted = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            communityMemberTotal: 1,
        });

        expect(rejected.totalCount).toBe(0);
        expect(accepted.totalCount).toBe(1);
    });

    it('treats communityMemberTotal string values as numbers when positive', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.zCard.mockResolvedValue(3);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            communityMemberTotal: '12',
        });

        expect(snapshot.totalCount).toBe(12);
        expect(snapshot.leaderboardEntryCount).toBe(3);
    });

    it('returns hasMore false when the page exactly fills the leaderboard', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.zCard.mockResolvedValue(10);
        mockRedis.zRange.mockResolvedValue(
            Array.from({ length: 10 }, (_, index) => ({
                member: `reddit:page-${index}`,
                score: 10000 + index,
            })),
        );
        mockRedis.hMGet.mockResolvedValue(
            Array.from({ length: 10 }, (_, index) => JSON.stringify({
                playerId: `reddit:page-${index}`,
                trackKey: challenge.trackKey,
                bestTimeMs: 10000 + index,
                updatedAt: '2026-01-01T00:00:00.000Z',
            })),
        );
        mockRedis.mGet.mockResolvedValue([]);

        const exact = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            offset: 0,
            limit: 10,
        });
        const leftover = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            offset: 0,
            limit: 9,
        });

        expect(exact.hasMore).toBe(false);
        expect(exact.nextOffset).toBeNull();
        expect(leftover.hasMore).toBe(true);
        expect(leftover.nextOffset).toBe(9);
    });

    it('returns the existing ledger entry when another writer wins the publish race', async () => {
        const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        const winner = {
            id: 'daily-gp-2030-07-03',
            challengeDate: '2030-07-03',
            trackKey: 'circuit',
            startsAt: '2030-07-03T00:00:00.000Z',
            endsAt: '2030-07-04T00:00:00.000Z',
            availableUntil: '2030-07-10T00:00:00.000Z',
            status: 'active',
            rulesRevision: 0,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 1 },
            skin: 'default',
        };
        const challenger = { ...winner, trackKey: 'desertBridge' };
        mockRedis.hGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(JSON.stringify(winner));
        mockRedis.hSetNX.mockResolvedValue(0);

        const result = await persistServerDailyGpChallenge(challenger);

        expect(result).toEqual(winner);
        expect(mockRedis.hSetNX).toHaveBeenCalledTimes(1);
    });
});
