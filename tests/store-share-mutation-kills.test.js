import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';

const VALID_CHALLENGE = {
    id: 'daily-gp-2026-07-11',
    challengeDate: '2026-07-11',
    trackKey: 'circuit',
    startsAt: '2026-07-11T00:00:00.000Z',
    endsAt: '2026-07-12T00:00:00.000Z',
    availableUntil: '2026-07-18T00:00:00.000Z',
};

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

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateDailyGpReplayDetailed,
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

describe('daily-gp-store mutation kills', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ownedLocks.clear();
        mockRedis.get.mockImplementation(async (key) => ownedLocks.get(key) ?? null);
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (options.nx && ownedLocks.has(key)) return '';
            if (String(key).includes('lock:') || String(key).includes('-lock:')) {
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
        mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 60);
        mockRedis.zAdd.mockResolvedValue(1);
        mockRedis.zCard.mockResolvedValue(0);
        mockRedis.zRange.mockResolvedValue([]);
        mockRedis.zRank.mockResolvedValue(undefined);
        mockRedis.watch.mockImplementation(() => ({
            multi: vi.fn().mockResolvedValue(undefined),
            unwatch: vi.fn().mockResolvedValue(undefined),
            del: vi.fn(),
            hSet: vi.fn(),
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
                checkpointTimesSec: [4.2, 9.8],
                ghost: null,
            },
        });
    });

    describe('parseStoredChallenge regex and field guards', () => {
        it('rejects ids that only match the daily-gp pattern as a substring', async () => {
            const { parseStoredChallenge } = await import('../src/server/daily-gp-store.ts');

            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                id: 'prefix-daily-gp-2026-07-11',
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                id: 'daily-gp-2026-07-11-suffix',
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                id: 'daily-gp-2026-07-1',
            }))).toBeNull();
        });

        it('rejects a valid-looking id when challengeDate is empty or the track is unknown', async () => {
            const { parseStoredChallenge } = await import('../src/server/daily-gp-store.ts');

            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                challengeDate: '',
            }))).toBeNull();
            expect(parseStoredChallenge(JSON.stringify({
                ...VALID_CHALLENGE,
                trackKey: 'not-in-catalog',
            }))).toBeNull();
        });

        it('returns null for thrown JSON instead of undefined', async () => {
            const { parseStoredChallenge } = await import('../src/server/daily-gp-store.ts');
            expect(parseStoredChallenge('{bad json')).toBeNull();
        });
    });

    describe('parseStoredEntry and parseStoredPlayerProfile guards', () => {
        it('clears non-strict validation methods and keeps strict-replay literals', async () => {
            const { parseStoredEntry } = await import('../src/server/daily-gp-store.ts');
            const base = {
                playerId: 'reddit:strict',
                bestTimeMs: 12000,
                updatedAt: '2026-07-11T00:00:00.000Z',
            };

            expect(parseStoredEntry(JSON.stringify({
                ...base,
                validationMethod: 'legacy',
            }))).toMatchObject({
                validationMethod: undefined,
                bestTimeMs: 12000,
            });
            expect(parseStoredEntry(JSON.stringify({
                ...base,
                trackKey: 'circuit',
                validationMethod: 'strict-replay',
            }))).toMatchObject({
                validationMethod: 'strict-replay',
                trackKey: 'circuit',
            });
        });

        it('uses the expected track when the stored entry omits or blanks trackKey', async () => {
            const { parseStoredEntry } = await import('../src/server/daily-gp-store.ts');
            const base = {
                playerId: 'reddit:track',
                bestTimeMs: 9000,
                updatedAt: '2026-07-11T00:00:00.000Z',
            };

            expect(parseStoredEntry(JSON.stringify(base), 'circuit')).toMatchObject({
                trackKey: 'circuit',
            });
            expect(parseStoredEntry(JSON.stringify({ ...base, trackKey: '' }), 'circuit')).toMatchObject({
                trackKey: 'circuit',
            });
            expect(parseStoredEntry(JSON.stringify({ ...base, trackKey: 'desertBridge' }), 'circuit')).toBeNull();
        });

        it('preserves explicit hasAnyData and epoch fallbacks for blank timestamp strings', async () => {
            const { parseStoredPlayerProfile } = await import('../src/server/daily-gp-store.ts');
            const epoch = new Date(0).toISOString();

            expect(parseStoredPlayerProfile(JSON.stringify({
                playerId: 'reddit:flags',
                hasAnyData: true,
                hasSeenGame: true,
            }))).toMatchObject({
                hasAnyData: true,
                hasSeenGame: true,
            });
            expect(parseStoredPlayerProfile(JSON.stringify({
                playerId: 'reddit:blank-ts',
                firstSeenAt: '',
                lastSeenAt: '',
                updatedAt: '',
            }))).toMatchObject({
                firstSeenAt: epoch,
                lastSeenAt: epoch,
                updatedAt: epoch,
            });
        });
    });

    describe('normalizeCommunityMemberTotal boundaries', () => {
        it('accepts exactly one member and rejects fractional values below one', async () => {
            const { normalizeCommunityMemberTotal } = await import('../src/server/daily-gp-store.ts');

            expect(normalizeCommunityMemberTotal(1)).toBe(1);
            expect(normalizeCommunityMemberTotal('1')).toBe(1);
            expect(normalizeCommunityMemberTotal(0.99)).toBeNull();
            expect(normalizeCommunityMemberTotal('0.9')).toBeNull();
        });
    });

    describe('getServerDailyGpChallengeById input guards', () => {
        it('returns null for non-string and empty challenge ids without touching Redis', async () => {
            const { getServerDailyGpChallengeById } = await import('../src/server/daily-gp-store.ts');

            await expect(getServerDailyGpChallengeById(undefined)).resolves.toBeNull();
            await expect(getServerDailyGpChallengeById(null)).resolves.toBeNull();
            await expect(getServerDailyGpChallengeById(42)).resolves.toBeNull();
            await expect(getServerDailyGpChallengeById(false)).resolves.toBeNull();
            expect(mockRedis.hGet).not.toHaveBeenCalled();
        });
    });

    describe('getServerDailyGpSnapshot pagination and in-page player rows', () => {
        it('reuses the visible top-row entry when the current player is on the requested page', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const members = Array.from({ length: 8 }, (_, index) => ({
                member: `reddit:page-${index + 1}`,
                score: 10000 + index,
            }));
            mockRankedLeaderboard(challenge, members);
            mockRedis.zRank.mockResolvedValue(2);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                redditUsername: 'Page-3',
                offset: 0,
                limit: 5,
            });

            expect(snapshot.topRows[2]).toMatchObject({
                rank: 3,
                isCurrentPlayer: true,
                bestTimeMs: 10002,
            });
            expect(snapshot.currentPlayerRow).toEqual({
                ...snapshot.topRows[2],
                isCurrentPlayer: true,
            });
            expect(snapshot.nearbyRows).toEqual([]);
            expect(snapshot.hasMore).toBe(true);
            expect(snapshot.nextOffset).toBe(5);
        });

        it('sets hasMore false only when offset plus limit reaches the leaderboard size', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            const members = Array.from({ length: 10 }, (_, index) => ({
                member: `reddit:edge-${index + 1}`,
                score: 20000 + index,
            }));
            mockRankedLeaderboard(challenge, members);

            const exact = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                offset: 0,
                limit: 10,
            });
            const partial = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                offset: 0,
                limit: 9,
            });

            expect(exact.hasMore).toBe(false);
            expect(exact.nextOffset).toBeNull();
            expect(partial.hasMore).toBe(true);
            expect(partial.nextOffset).toBe(9);
        });

        it('keeps community totals when the timed leaderboard is empty but the floor is positive', async () => {
            const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.zCard.mockResolvedValue(0);

            const snapshot = await getServerDailyGpSnapshot({
                challengeId: challenge.id,
                communityMemberTotal: 42,
            });

            expect(snapshot).toMatchObject({
                totalCount: 42,
                leaderboardEntryCount: 0,
                topRows: [],
                nearbyRows: [],
                objectiveType: challenge.objectiveType,
                hasMore: false,
                nextOffset: null,
            });
        });
    });

    describe('submitServerDailyGpRun improvement guard', () => {
        it('returns completedLaps null when the stored time is already faster', async () => {
            const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();
            mockRedis.hGet.mockImplementation(async (key, field) => {
                if (key === 'dailygp:challenges') return JSON.stringify(challenge);
                if (key === `dailygp:leaderboard:${challenge.id}:entries` && field === 'reddit:slower-run') {
                    return JSON.stringify({
                        playerId: 'reddit:slower-run',
                        trackKey: challenge.trackKey,
                        bestTimeMs: 9000,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        validationMethod: 'strict-replay',
                    });
                }
                return null;
            });

            const result = await submitServerDailyGpRun({
                redditUsername: 'Slower-Run',
                challengeId: challenge.id,
                trackKey: challenge.trackKey,
                replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            });

            expect(result).toMatchObject({
                status: 200,
                body: {
                    accepted: true,
                    improved: false,
                    bestTimeMs: 9000,
                    completedLaps: null,
                },
            });
            expect(mockRedis.zAdd).not.toHaveBeenCalled();
        });
    });

    describe('track rotation fallbacks', () => {
        it('uses the first scheduled track when the ledger playhead is missing or unknown', async () => {
            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            mockRedis.hGet.mockResolvedValue(null);
            mockRedis.hGetAll.mockResolvedValue({
                'daily-gp-2026-07-10': JSON.stringify({
                    ...VALID_CHALLENGE,
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
    });

    describe('getServerPlayerTrackPbSummaries request filtering', () => {
        it('ignores non-array challengeIds and returns an empty track map', async () => {
            const { getServerPlayerTrackPbSummaries } = await import('../src/server/daily-gp-store.ts');

            const result = await getServerPlayerTrackPbSummaries({
                redditUsername: 'Pb-Reader',
                challengeIds: 'not-an-array',
            });

            expect(result.playerId).toBe('reddit:pb-reader');
            expect(result.trackPbs).toEqual({});
        });
    });
});
