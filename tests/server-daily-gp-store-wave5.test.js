import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const mockMintGuestPlayerToken = vi.fn();
const mockVerifyGuestPlayerToken = vi.fn();

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateDailyGpReplayDetailed,
}));
vi.mock('../src/server/player-token.js', () => ({
    mintGuestPlayerToken: mockMintGuestPlayerToken,
    verifyGuestPlayerToken: mockVerifyGuestPlayerToken,
}));

describe('server daily gp store wave5', () => {
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
        mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 45);
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
        mockMintGuestPlayerToken.mockResolvedValue('guest-token-wave5');
        mockVerifyGuestPlayerToken.mockResolvedValue(null);
    });

    it('rejects stored challenges with unknown track keys (L148-L150)', async () => {
        const { parseStoredChallenge } = await import('../src/server/daily-gp-store.ts');

        expect(parseStoredChallenge(JSON.stringify({
            id: 'daily-gp-2026-07-11',
            challengeDate: '2026-07-11',
            trackKey: 'not-a-real-track',
            startsAt: '2026-07-11T00:00:00.000Z',
            endsAt: '2026-07-12T00:00:00.000Z',
            availableUntil: '2026-07-18T00:00:00.000Z',
        }))).toBeNull();
    });

    it('returns null for non-finite community totals (L387-L391)', async () => {
        const { normalizeCommunityMemberTotal } = await import('../src/server/daily-gp-store.ts');

        expect(normalizeCommunityMemberTotal(-1)).toBeNull();
        expect(normalizeCommunityMemberTotal('not-a-number')).toBeNull();
        expect(normalizeCommunityMemberTotal(Number.NaN)).toBeNull();
        expect(normalizeCommunityMemberTotal(42)).toBe(42);
    });

    it('preserves strict-replay metadata on stored leaderboard entries (L450-L455)', async () => {
        const { parseStoredEntry } = await import('../src/server/daily-gp-store.ts');
        const base = {
            playerId: 'reddit:Strict',
            trackKey: 'circuit',
            bestTimeMs: 54321,
            updatedAt: '2026-07-18T12:00:00.000Z',
            checkpointTimesSec: [],
        };

        expect(parseStoredEntry(JSON.stringify({
            ...base,
            validationMethod: 'strict-replay',
            strictReplayFailureReason: 'frame_mismatch',
        }), 'circuit')).toMatchObject({
            validationMethod: 'strict-replay',
            strictReplayFailureReason: 'frame_mismatch',
        });
        expect(parseStoredEntry(JSON.stringify({
            ...base,
            validationMethod: 'loose',
        }), 'circuit')).toMatchObject({
            validationMethod: undefined,
            strictReplayFailureReason: null,
        });
    });

    it('formats podium times with minute padding for long laps (L783-L788)', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify({
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
        }));
        mockRedis.zRange.mockResolvedValueOnce([
            { member: 'reddit:fast', score: 125990 },
        ]);
        mockRedis.hMGet.mockResolvedValueOnce([
            JSON.stringify({
                playerId: 'reddit:fast',
                trackKey: 'circuit',
                bestTimeMs: 125990,
                updatedAt: '2026-07-10T12:00:00.000Z',
            }),
        ]);
        mockRedis.mGet.mockResolvedValue([]);

        const podium = await getServerFinalDailyGpPodium(new Date('2026-07-17T00:01:00.000Z'));

        expect(podium.positions[0].formattedTime).toBe('2:05.99');
        expect(podium.positions[1].formattedTime).toBeNull();
    });

    it('drops invalid preference payloads while keeping the player profile shell (L472-L487)', async () => {
        const { parseStoredPlayerProfile } = await import('../src/server/daily-gp-store.ts');

        expect(parseStoredPlayerProfile(JSON.stringify({
            playerId: 'guest:wave5',
            preferences: {
                carSkin: 'default',
                trailId: 'basic',
                musicEnabled: true,
                carAudioEnabled: true,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 1.1,
            },
        }))?.preferences).toBeNull();

        const profile = parseStoredPlayerProfile(JSON.stringify({
            playerId: 'guest:wave5',
            preferences: {
                carSkin: 'default',
                trailId: 'basic',
                musicEnabled: true,
                carAudioEnabled: true,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 0.5,
                pbGhostEnabled: false,
            },
        }));

        expect(profile?.preferences?.pbGhostEnabled).toBe(false);
    });

    it('returns null for expired playable challenges (L950-L955)', async () => {
        const { getServerDailyGpPlayableChallenge } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify({
            id: 'daily-gp-2020-01-01',
            challengeDate: '2020-01-01',
            trackKey: 'circuit',
            startsAt: '2020-01-01T00:00:00.000Z',
            endsAt: '2020-01-02T00:00:00.000Z',
            availableUntil: '2020-01-03T00:00:00.000Z',
        }));

        await expect(getServerDailyGpPlayableChallenge('daily-gp-2020-01-01')).resolves.toBeNull();
    });
});
