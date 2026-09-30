import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAILY_GP_NEARBY_RADIUS } from '../src/server/daily/daily-gp-model.ts';

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
const ownedLocks = new Map();
const mockValidateDailyGpReplayDetailed = vi.fn();
const mockMintGuestPlayerToken = vi.fn();
const mockVerifyGuestPlayerToken = vi.fn();

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));
vi.mock('../src/server/competition/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateDailyGpReplayDetailed,
}));
vi.mock('../src/server/player/player-token.js', () => ({
    mintGuestPlayerToken: mockMintGuestPlayerToken,
    verifyGuestPlayerToken: mockVerifyGuestPlayerToken,
}));

function mockRankedLeaderboard(challenge, members) {
    const entryPayloads = members.map((member) => JSON.stringify({
        playerId: member.member,
        trackKey: challenge.trackKey,
        bestTimeMs: member.score,
        updatedAt: '2026-06-02T12:00:00.000Z',
    }));

    mockRedis.zCard.mockResolvedValue(members.length);
    mockRedis.zRange.mockImplementation(async (_key, start, stop) => members.slice(start, stop + 1));
    mockRedis.hMGet.mockImplementation(async (_key, fields) => (
        fields.map((field) => entryPayloads[members.findIndex((member) => member.member === field)] ?? null)
    ));
    mockRedis.hGet.mockImplementation(async (key, field) => {
        const index = members.findIndex((member) => member.member === field);
        if (index >= 0 && key.endsWith(':entries')) {
            return entryPayloads[index];
        }
        return null;
    });
}

describe('server daily gp store wave4', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ownedLocks.clear();
        mockRedis.get.mockImplementation(async (key) => ownedLocks.get(key) ?? null);
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (options.nx && ownedLocks.has(key)) return '';
            if (String(key).includes('lock:')) {
                ownedLocks.set(key, value);
            }
            return 'OK';
        });
        mockRedis.del.mockImplementation(async (key) => {
            ownedLocks.delete(key);
        });
        mockRedis.incrBy.mockResolvedValue(1);
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
        mockRedis.watch.mockImplementation(() => ({
            multi: vi.fn().mockResolvedValue(undefined),
            unwatch: vi.fn().mockResolvedValue(undefined),
            discard: vi.fn().mockResolvedValue(undefined),
            del: vi.fn(async (key) => {
                ownedLocks.delete(key);
            }),
            set: vi.fn(),
            hSet: vi.fn(),
            hSetNX: vi.fn(),
            incrBy: vi.fn(),
            zAdd: vi.fn(),
            expire: vi.fn(),
            exec: vi.fn().mockResolvedValue([1]),
        }));
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
        mockMintGuestPlayerToken.mockResolvedValue('guest-token-wave4');
        mockVerifyGuestPlayerToken.mockResolvedValue(null);
    });

    it('rejects stored challenges when any schedule timestamp is non-finite (L157-L159)', async () => {
        const { parseStoredChallenge } = await import('../src/server/daily/daily-gp-store.ts');
        const base = {
            id: 'daily-gp-2026-07-11',
            challengeDate: '2026-07-11',
            trackKey: 'circuit',
            startsAt: '2026-07-11T00:00:00.000Z',
            endsAt: '2026-07-12T00:00:00.000Z',
            availableUntil: '2026-07-18T00:00:00.000Z',
        };

        expect(parseStoredChallenge(JSON.stringify({
            ...base,
            endsAt: 'invalid',
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...base,
            availableUntil: 'also-invalid',
        }))).toBeNull();
    });

    it('returns retryAfterSeconds from expireTime once the submission cap is exceeded (L885-L895)', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.incrBy.mockResolvedValue(13);
        mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 22);

        const result = await submitServerDailyGpRun({
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'RateLimited',
            bestTime: 12.34,
            replay: { inputs: [] },
        });

        expect(result).toEqual({
            status: 429,
            body: {
                accepted: false,
                error: 'Too many submission attempts. Try again soon.',
                retryAfterSeconds: 22,
            },
        });
    });

    it('repairs a rate-limit counter left without an expiry instead of blocking forever', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.incrBy.mockResolvedValue(13);
        mockRedis.expireTime.mockResolvedValue(-1);

        const result = await submitServerDailyGpRun({
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'RateLimited',
            bestTime: 12.34,
            replay: { inputs: [] },
        });

        expect(result.status).toBe(429);
        expect(result.body.retryAfterSeconds).toBe(60);
        expect(mockRedis.expire).toHaveBeenCalledWith(
            expect.stringContaining('submit-rate-limit'),
            60,
        );
    });

    it('loads nearby rows when the player rank equals the page boundary (L1460-L1463)', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const members = Array.from({ length: 12 }, (_, index) => ({
            member: `reddit:rank-${index + 1}`,
            score: 10000 + index,
        }));
        mockRankedLeaderboard(challenge, members);
        mockRedis.zRank.mockResolvedValue(5);
        mockRedis.mGet.mockResolvedValue([]);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            redditUsername: 'Rank-6',
            offset: 0,
            limit: 5,
        });

        expect(snapshot.playerRank).toBe(6);
        expect(snapshot.nearbyRows.length).toBeGreaterThan(0);
        expect(snapshot.nearbyRows[0].rank).toBe(
            Math.max(1, 6 - DAILY_GP_NEARBY_RADIUS),
        );
        expect(snapshot.currentPlayerRow?.isCurrentPlayer).toBe(true);
    });

    it('rejects player preference updates with out-of-range crash delay values (L483-L485)', async () => {
        const { updateServerPlayerPreferences } = await import('../src/server/player/player-account-store.ts');
        mockVerifyGuestPlayerToken.mockResolvedValue('guest-wave4');

        const invalid = await updateServerPlayerPreferences({
            playerId: 'guest-wave4',
            guestToken: 'guest-token-wave4',
            playerPreferences: {
                carSkin: 'default',
                trailId: 'basic',
                musicEnabled: true,
                carAudioEnabled: true,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 1.1,
            },
        });

        expect(invalid).toEqual({
            playerId: 'guest:guest-wave4',
            guestToken: 'guest-token-wave4',
            playerPreferences: null,
        });
    });

    it('claims a new guest profile when no identity is supplied (L1210-L1222)', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/player/player-account-store.ts');
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (options.nx) {
                return 'OK';
            }
            return 'OK';
        });

        const bootstrap = await getServerPlayerBootstrap({
            playerId: 'guest-wave4-new',
            leaderboardIdentity: 'constructed',
        });

        expect(bootstrap.playerId).toBe('guest:guest-wave4-new');
        expect(bootstrap.guestToken).toBe('guest-token-wave4');
        expect(bootstrap.hasAnyData).toBe(false);
        expect(bootstrap.isReturningPlayer).toBe(false);
    });

    it('rejects submissions whose trackKey does not match the challenge (L1532-L1539)', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();

        const result = await submitServerDailyGpRun({
            challengeId: challenge.id,
            trackKey: 'desertBridge',
            redditUsername: 'Mismatch',
            bestTime: 12.34,
            replay: { inputs: [] },
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission track does not match challenge.',
                reason: 'track_mismatch',
            },
        });
    });
});
