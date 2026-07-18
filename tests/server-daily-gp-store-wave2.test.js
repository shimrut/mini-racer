import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';

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
});
