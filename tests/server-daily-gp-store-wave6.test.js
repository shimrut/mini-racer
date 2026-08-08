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

function buildStoredChallenge(overrides = {}) {
    return {
        id: 'daily-gp-2026-07-11',
        challengeDate: '2026-07-11',
        trackKey: 'circuit',
        startsAt: '2026-07-11T00:00:00.000Z',
        endsAt: '2026-07-12T00:00:00.000Z',
        availableUntil: '2026-07-18T00:00:00.000Z',
        ...overrides,
    };
}

function buildStoredEntry(overrides = {}) {
    return {
        playerId: 'reddit:Wave6',
        trackKey: 'circuit',
        bestTimeMs: 54321,
        updatedAt: '2026-07-18T12:00:00.000Z',
        checkpointTimesSec: [],
        ...overrides,
    };
}

describe('server daily gp store wave6', () => {
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
        mockMintGuestPlayerToken.mockResolvedValue('guest-token-wave6');
        mockVerifyGuestPlayerToken.mockResolvedValue(null);
    });

    it('rejects stored challenges with malformed daily-gp ids (L144)', async () => {
        const { parseStoredChallenge } = await import('../src/server/daily-gp-store.ts');

        expect(parseStoredChallenge(JSON.stringify(buildStoredChallenge({
            id: 'not-daily-gp-format',
        })))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify(buildStoredChallenge({
            challengeDate: '',
        })))).toBeNull();
    });

    it('rejects stored challenges with non-string track keys (L148-L150)', async () => {
        const { parseStoredChallenge } = await import('../src/server/daily-gp-store.ts');

        expect(parseStoredChallenge(JSON.stringify({
            ...buildStoredChallenge(),
            trackKey: 42,
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...buildStoredChallenge(),
            trackKey: '',
        }))).toBeNull();
    });

    it('rejects stored challenges with invalid startsAt timestamps (L157-L159)', async () => {
        const { parseStoredChallenge } = await import('../src/server/daily-gp-store.ts');

        expect(parseStoredChallenge(JSON.stringify({
            ...buildStoredChallenge(),
            startsAt: 'not-a-date',
        }))).toBeNull();
    });

    it('rejects stored entries missing required player fields (L418-L425)', async () => {
        const { parseStoredEntry } = await import('../src/server/daily-gp-store.ts');

        expect(parseStoredEntry(JSON.stringify({
            ...buildStoredEntry(),
            playerId: '',
        }), 'circuit')).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...buildStoredEntry(),
            bestTimeMs: 'fast',
        }), 'circuit')).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...buildStoredEntry(),
            updatedAt: '',
        }), 'circuit')).toBeNull();
    });

    it('rejects stored entries whose track disagrees with the expected track (L430-L434)', async () => {
        const { parseStoredEntry } = await import('../src/server/daily-gp-store.ts');

        expect(parseStoredEntry(JSON.stringify({
            ...buildStoredEntry(),
            trackKey: 'desertBridge',
        }), 'circuit')).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...buildStoredEntry(),
            trackKey: 'circuit',
        }), 'circuit')).toMatchObject({
            trackKey: 'circuit',
            bestTimeMs: 54321,
        });
    });

    it('preserves hasSeenGame=false on stored player profiles (L515)', async () => {
        const { parseStoredPlayerProfile } = await import('../src/server/daily-gp-store.ts');

        const profile = parseStoredPlayerProfile(JSON.stringify({
            playerId: 'guest:wave6',
            hasSeenGame: false,
            preferences: null,
        }));

        expect(profile?.hasSeenGame).toBe(false);
        expect(profile?.preferences).toBeNull();
    });

    it('returns null for empty challenge ids (L922-L923)', async () => {
        const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

        await expect(getServerDailyGpChallengeById('')).resolves.toBeNull();
        await expect(getServerDailyGpChallengeById(null)).resolves.toBeNull();
    });

    it('returns null for final podiums before availability expires (L950-L951)', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify(buildStoredChallenge({
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2099-01-01T00:00:00.000Z',
        })));

        const podium = await getServerFinalDailyGpPodium(new Date('2026-07-12T00:00:00.000Z'));

        expect(podium).toBeNull();
    });

    it('formats sub-minute podium times without minute padding (L783-L788)', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify(buildStoredChallenge({
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
        })));
        mockRedis.zRange.mockResolvedValueOnce([
            { member: 'reddit:fast', score: 45990 },
        ]);
        mockRedis.hMGet.mockResolvedValueOnce([
            JSON.stringify(buildStoredEntry({
                playerId: 'reddit:fast',
                bestTimeMs: 45990,
            })),
        ]);
        mockRedis.mGet.mockResolvedValue([]);

        const podium = await getServerFinalDailyGpPodium(new Date('2026-07-18T00:01:00.000Z'));

        expect(podium?.positions[0].formattedTime).toBe('0:45.990');
        expect(podium?.positions[1].formattedTime).toBeNull();
    });

    it('returns empty nearby rows when the player is already in the top page (L1427-L1430)', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const members = Array.from({ length: 5 }, (_, index) => ({
            member: `reddit:rank-${index + 1}`,
            score: 10000 + index,
        }));
        mockRedis.zCard.mockResolvedValueOnce(5);
        mockRedis.zRange.mockResolvedValueOnce(members);
        mockRedis.hMGet.mockResolvedValueOnce(members.map((member, index) => JSON.stringify(buildStoredEntry({
            playerId: member.member,
            bestTimeMs: 10000 + index,
        }))));
        // The shared page supplies public rows, while the current player's
        // authoritative row is re-read live before it is overlaid.
        mockRedis.hGet.mockResolvedValue(JSON.stringify(buildStoredEntry({
            playerId: 'reddit:rank-2',
            bestTimeMs: 10001,
        })));
        mockRedis.zRank.mockResolvedValueOnce(1);
        mockRedis.mGet.mockResolvedValue([]);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            redditUsername: 'Rank-2',
            limit: 5,
            offset: 0,
        });

        expect(snapshot.playerRank).toBe(2);
        expect(snapshot.nearbyRows).toEqual([]);
        expect(snapshot.currentPlayerRow?.isCurrentPlayer).toBe(true);
    });

    it('sets hasMore and nextOffset when another page exists (L1442-L1444)', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const members = Array.from({ length: 8 }, (_, index) => ({
            member: `reddit:rank-${index + 1}`,
            score: 10000 + index,
        }));
        mockRedis.zCard.mockResolvedValueOnce(8);
        mockRedis.zRange.mockResolvedValueOnce(members.slice(0, 3));
        mockRedis.hMGet.mockResolvedValueOnce(members.slice(0, 3).map((member, index) => JSON.stringify(buildStoredEntry({
            playerId: member.member,
            bestTimeMs: 10000 + index,
        }))));
        mockRedis.mGet.mockResolvedValue([]);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            limit: 3,
            offset: 0,
        });

        expect(snapshot.hasMore).toBe(true);
        expect(snapshot.nextOffset).toBe(3);
        expect(snapshot.pageLimit).toBe(3);
    });

    it('returns an empty snapshot for unknown playable challenges (L1376-L1377)', async () => {
        const { getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(null);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: 'daily-gp-2020-01-01',
        });

        expect(snapshot.topRows).toEqual([]);
        expect(snapshot.nearbyRows).toEqual([]);
        expect(snapshot.currentPlayerRow).toBeNull();
    });

    it('returns null for player best lookups without a username (L988-L989)', async () => {
        const { getServerDailyGpPlayerBest } = await import('../src/server/daily-gp-store.ts');

        await expect(getServerDailyGpPlayerBest({
            challengeId: 'daily-gp-2026-07-11',
            redditUsername: '   ',
        })).resolves.toBeNull();
    });

    it('returns the existing stored challenge from persist when one already exists (L365-L367)', async () => {
        const { persistServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
        const stored = {
            id: 'daily-gp-2026-07-11',
            challengeDate: '2026-07-11',
            trackKey: 'circuit',
            startsAt: '2026-07-11T00:00:00.000Z',
            endsAt: '2026-07-12T00:00:00.000Z',
            availableUntil: '2026-07-18T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify(stored));

        const result = await persistServerDailyGpChallenge({
            ...stored,
            trackKey: 'desertBridge',
        });

        expect(result.trackKey).toBe('circuit');
        expect(mockRedis.hSetNX).not.toHaveBeenCalled();
    });
});
