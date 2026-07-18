import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACK_CATALOG, TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import { TRACKS } from '../game/track/tracks.js';
import { getBackfilledDailyGpChallenge } from '../src/server/daily-gp-history-backfill.ts';

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
    expire: vi.fn(),
    expireTime: vi.fn(),
    zAdd: vi.fn(),
    zCard: vi.fn(),
    zRange: vi.fn(),
    zRank: vi.fn(),
    watch: vi.fn(),
};
const mockValidateDailyGpReplayDetailed = vi.fn();

function checkpointSplitsForChallenge(challenge, bestTimeSec) {
    const count = TRACKS[challenge.trackKey]?.checkpoints?.length || 0;
    return Array.from({ length: count }, (_, index) => {
        return ((index + 1) * bestTimeSec) / (count + 1);
    });
}

function findWrittenPlayerProfile(playerId) {
    for (const [key, rawProfile, options] of [...mockRedis.set.mock.calls].reverse()) {
        if (!String(key).startsWith('dailygp:player-profile:')) continue;
        try {
            const profile = JSON.parse(rawProfile);
            if (profile.playerId === playerId) {
                return { key, profile, options };
            }
        } catch (_error) {
            // Ignore non-profile Redis values.
        }
    }
    return null;
}

function createMockTransaction(options = {}) {
    const commands = [];
    const hasExecResult = Object.prototype.hasOwnProperty.call(options, 'execResult');
    return {
        multi: vi.fn().mockResolvedValue(undefined),
        hSet: vi.fn(async (...args) => {
            commands.push(() => mockRedis.hSet(...args));
        }),
        zAdd: vi.fn(async (...args) => {
            commands.push(() => mockRedis.zAdd(...args));
        }),
        expire: vi.fn(async (...args) => {
            commands.push(() => mockRedis.expire(...args));
        }),
        exec: vi.fn(async () => {
            if (hasExecResult) {
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
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateDailyGpReplayDetailed,
}));

describe('server daily gp store submissions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.mGet.mockResolvedValue([]);
        mockRedis.set.mockResolvedValue('OK');
        mockRedis.del.mockResolvedValue(undefined);
        mockRedis.incrBy.mockResolvedValue(1);
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hMGet.mockResolvedValue([]);
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 60);
        mockRedis.zAdd.mockResolvedValue(1);
        mockRedis.zCard.mockResolvedValue(0);
        mockRedis.zRange.mockResolvedValue([]);
        mockRedis.zRank.mockResolvedValue(undefined);
        mockRedis.watch.mockImplementation(() => createMockTransaction());
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 12.345,
                bestTimeMs: 12345,
                completedLaps: 1,
                checkpointTimesSec: [4.2, 9.8],
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 50,
                    origin: [0, 0, 0],
                    deltas: [100, 100, 100],
                },
                method: 'finish',
            },
        });
    });

    it('writes the replay-verified time to Redis instead of the submitted bestTime', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            bestTime: 2,
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                bestTimeMs: 12345,
                trackBestTimeMs: 12345,
                trackPbImproved: true,
                trackGhostAvailable: true,
                trackPbPersistenceStatus: 'stored',
                trackPersonalBest: {
                    trackKey: challenge.trackKey,
                    bestTimeMs: 12345,
                    checkpointTimesSec: [4.2, 9.8],
                    updatedAt: expect.any(String),
                    ghost: {
                        schemaVersion: 2,
                        sampleIntervalMs: 50,
                        finishTimeMs: 50,
                        origin: [0, 0, 0],
                        deltas: [100, 100, 100],
                    },
                },
                completedLaps: 1,
                checkpointTimesSec: [4.2, 9.8],
                validationMethod: 'strict-replay',
            },
        });
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalledWith({
            challenge: expect.objectContaining({ id: challenge.id }),
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-user', score: 12345 }),
        );
        const leaderboardEntryCall = mockRedis.hSet.mock.calls.find((call) => {
            const rawEntry = call[1]?.['reddit:pm-user'];
            if (!rawEntry) return false;
            return Number.isFinite(JSON.parse(rawEntry).bestTimeMs);
        });
        const leaderboardEntry = JSON.parse(leaderboardEntryCall[1]['reddit:pm-user']);
        expect(leaderboardEntry.trackKey).toBe(challenge.trackKey);
        expect(leaderboardEntry.bestTimeMs).toBe(12345);
        expect(leaderboardEntry.checkpointTimesSec).toEqual([4.2, 9.8]);
        expect(leaderboardEntry.validationMethod).toBe('strict-replay');
    });

    it('accepts a committed daily result when lifetime PB persistence is unavailable', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.hSet.mockImplementation(async (key) => {
            if (String(key).startsWith('dailygp:track-pbs:')) {
                throw new Error('PB storage unavailable');
            }
            return 1;
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                improved: true,
                trackPbPersistenceStatus: 'unavailable',
                trackPersonalBest: null,
                trackBestTimeMs: null,
                trackPbImproved: false,
                trackGhostAvailable: false,
            },
        });
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-user', score: 12345 }),
        );
    });

    it('does not let submission lock cleanup errors replace a committed daily outcome', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockRedis.get.mockImplementation(async (key) => {
            if (String(key).startsWith('dailygp:submit-lock:')) {
                throw new Error('cleanup unavailable');
            }
            return null;
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result).toMatchObject({
            status: 200,
            body: { accepted: true, trackPbPersistenceStatus: 'stored' },
        });
    });

    it('starts PB persistence while the daily transaction is still pending', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        let finishDailyWrite;
        mockRedis.zAdd.mockImplementation(() => new Promise((resolve) => {
            finishDailyWrite = resolve;
        }));

        const pending = submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        await vi.waitFor(() => {
            expect(mockRedis.hSet).toHaveBeenCalledWith(
                expect.stringMatching(/^dailygp:track-pbs:/),
                expect.objectContaining({ [challenge.trackKey]: expect.any(String) }),
            );
            expect(finishDailyWrite).toBeTypeOf('function');
        });
        finishDailyWrite(1);

        await expect(pending).resolves.toMatchObject({
            status: 200,
            body: { accepted: true, trackPbPersistenceStatus: 'stored' },
        });
    });

    it('commits concurrent submissions from different players under separate submission locks', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        vi.clearAllMocks();

        const submit = (redditUsername) => submitServerDailyGpRun({
            playerId: `browser-${redditUsername}`,
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername,
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });
        const results = await Promise.all([submit('Pm-A'), submit('Pm-B')]);

        expect(results).toEqual([
            expect.objectContaining({ status: 200, body: expect.objectContaining({ accepted: true }) }),
            expect.objectContaining({ status: 200, body: expect.objectContaining({ accepted: true }) }),
        ]);
        expect(new Set(mockRedis.watch.mock.calls.map(([key]) => key))).toEqual(new Set([
            `dailygp:submit-lock:${challenge.id}:reddit:pm-a`,
            `dailygp:submit-lock:${challenge.id}:reddit:pm-b`,
        ]));
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-a', score: 12345 }),
        );
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            expect.objectContaining({ member: 'reddit:pm-b', score: 12345 }),
        );
        const writtenLeaderboardPlayerIds = mockRedis.hSet.mock.calls.flatMap(([, entries]) => {
            return entries && typeof entries === 'object' ? Object.keys(entries) : [];
        });
        expect(writtenLeaderboardPlayerIds).toEqual(expect.arrayContaining([
            'reddit:pm-a',
            'reddit:pm-b',
        ]));
    });

    it('rejects a concurrent submission from the same player while its lock is held', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        vi.clearAllMocks();
        let lockAttempts = 0;
        mockRedis.set.mockImplementation(async (key) => {
            if (!String(key).startsWith('dailygp:submit-lock:')) {
                return 'OK';
            }
            lockAttempts += 1;
            return lockAttempts === 1 ? 'OK' : null;
        });

        const submit = () => submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });
        const results = await Promise.all([submit(), submit()]);

        expect(results.map((result) => result.status).sort()).toEqual([200, 429]);
        expect(results).toContainEqual({
            status: 429,
            body: {
                accepted: false,
                error: 'Submission already in progress. Try again in a moment.',
                retryAfterSeconds: 1,
            },
        });
        expect(mockRedis.zAdd).toHaveBeenCalledTimes(1);
    });

    it.each([
        { label: 'an empty result', execResult: [] },
        { label: 'a null result', execResult: null },
        { label: 'a missing result', execResult: undefined },
    ])('returns a retryable failure and releases the lock when EXEC returns $label', async ({ execResult }) => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        vi.clearAllMocks();
        let ownedLock = null;
        mockRedis.set.mockImplementation(async (key, value) => {
            if (String(key).startsWith('dailygp:submit-lock:')) {
                ownedLock = { key, value };
            }
            return 'OK';
        });
        mockRedis.get.mockImplementation(async (key) => {
            return key === ownedLock?.key ? ownedLock.value : null;
        });
        mockRedis.watch.mockImplementation(() => createMockTransaction({ execResult }));

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        });

        expect(result).toEqual({
            status: 503,
            body: {
                accepted: false,
                error: 'Submission save was interrupted. Retrying automatically.',
            },
        });
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
        expect(mockRedis.hSet.mock.calls.some(([, entries]) => entries?.['reddit:pm-user'])).toBe(false);
        expect(ownedLock).not.toBe(null);
        expect(mockRedis.del).toHaveBeenCalledWith(ownedLock.key);
    });

    it('backfills published Daily GP history before building the playlist', async () => {
        const { getServerDailyGpPlaylist } = await import('../src/server/daily-gp-store.ts');

        const playlist = await getServerDailyGpPlaylist(new Date('2026-06-11T12:00:00.000Z'));

        expect(playlist.map((challenge) => challenge.trackKey)).toEqual([
            'lanternPier',
            'caspianBoulevard',
            'circuitPromax',
            'desertBridge',
            'turboShell',
            'harborPrincipality',
            'sunlitTemple',
        ]);
        expect(mockRedis.hSet).toHaveBeenCalledWith(
            'dailygp:challenges',
            expect.objectContaining({
                'daily-gp-2026-06-10': expect.stringContaining('"trackKey":"caspianBoulevard"'),
            }),
        );
    });

    it('publishes the challenge whose seven-day window just expired at the UTC boundary', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const expiredChallenge = {
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === expiredChallenge.id ? JSON.stringify(expiredChallenge) : null
        ));

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-07-17T00:01:00.000Z'),
        )).resolves.toMatchObject({
            challengeId: expiredChallenge.id,
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
        });
        expect(mockRedis.hGet).toHaveBeenCalledWith('dailygp:challenges', expiredChallenge.id);
    });

    it('selects the prior expired day immediately before the next UTC boundary', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2026-07-09',
            challengeDate: '2026-07-09',
            trackKey: 'circuit',
            startsAt: '2026-07-09T00:00:00.000Z',
            endsAt: '2026-07-10T00:00:00.000Z',
            availableUntil: '2026-07-16T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-07-16T23:59:59.999Z'),
        )).resolves.toMatchObject({ challengeId: challenge.id });
    });

    it('returns no final podium when the historical challenge ledger has no eligible day', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValue(null);

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-07-17T00:01:00.000Z'),
        )).resolves.toBeNull();
    });

    it.each([0, 1, 2, 3])('returns exactly three safe podium positions for %s verified finishers', async (count) => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const members = Array.from({ length: count }, (_, index) => ({
            member: `guest:podium-${index + 1}`,
            score: 12000 + (index * 100),
        }));
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));
        mockRedis.zRange.mockResolvedValue(members);
        mockRedis.hMGet.mockResolvedValue(members.map((member, index) => JSON.stringify({
            playerId: member.member,
            trackKey: challenge.trackKey,
            bestTimeMs: 12000 + (index * 100),
            updatedAt: '2026-07-10T12:00:00.000Z',
        })));
        mockRedis.mGet.mockResolvedValue(members.map((member) => JSON.stringify({
            playerId: member.member,
            leaderboardIdentity: 'reddit',
            redditUsername: null,
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-07-10T12:00:00.000Z',
            lastSeenAt: '2026-07-10T12:00:00.000Z',
            updatedAt: '2026-07-10T12:00:00.000Z',
        })));

        const result = await getServerFinalDailyGpPodium(new Date('2026-07-17T00:01:00.000Z'));

        expect(result.positions).toHaveLength(3);
        expect(result.positions.filter((position) => position.identityType !== 'empty')).toHaveLength(count);
        expect(result.positions.filter((position) => position.identityType === 'empty')).toHaveLength(3 - count);
        if (count > 0) expect(result.positions[0].identityType).toBe('private');
    });

    it('advances the expired podium challenge across month and year boundaries', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2025-12-25',
            challengeDate: '2025-12-25',
            trackKey: 'circuit',
            startsAt: '2025-12-25T00:00:00.000Z',
            endsAt: '2025-12-26T00:00:00.000Z',
            availableUntil: '2026-01-01T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));

        await expect(getServerFinalDailyGpPodium(
            new Date('2026-01-01T00:01:00.000Z'),
        )).resolves.toMatchObject({ challengeId: challenge.id });
        expect(mockRedis.hGet).toHaveBeenCalledWith('dailygp:challenges', challenge.id);
    });

    it('freezes sanitized podium identities and fills missing positions', async () => {
        const { getServerFinalDailyGpPodium } = await import('../src/server/daily-gp-store.ts');
        const challenge = {
            id: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const members = [
            { member: 'reddit:racefan', score: 12340 },
            { member: 'guest:private-player', score: 13560 },
        ];
        mockRedis.hGet.mockImplementation(async (_key, field) => (
            field === challenge.id ? JSON.stringify(challenge) : null
        ));
        mockRedis.zRange.mockResolvedValue(members);
        mockRedis.hMGet.mockResolvedValue([
            JSON.stringify({
                playerId: members[0].member,
                trackKey: challenge.trackKey,
                bestTimeMs: 12340,
                updatedAt: '2026-07-10T12:00:00.000Z',
            }),
            JSON.stringify({
                playerId: members[1].member,
                trackKey: challenge.trackKey,
                bestTimeMs: 13560,
                updatedAt: '2026-07-10T13:00:00.000Z',
            }),
        ]);
        mockRedis.mGet.mockResolvedValue([
            JSON.stringify({
                playerId: members[0].member,
                leaderboardIdentity: 'reddit',
                redditUsername: 'RaceFan',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-07-10T12:00:00.000Z',
                lastSeenAt: '2026-07-10T12:00:00.000Z',
                updatedAt: '2026-07-10T12:00:00.000Z',
            }),
            JSON.stringify({
                playerId: members[1].member,
                leaderboardIdentity: 'constructed',
                redditUsername: 'HiddenUser',
                hasSeenGame: true,
                hasAnyData: true,
                firstSeenAt: '2026-07-10T13:00:00.000Z',
                lastSeenAt: '2026-07-10T13:00:00.000Z',
                updatedAt: '2026-07-10T13:00:00.000Z',
            }),
        ]);

        const podium = await getServerFinalDailyGpPodium(new Date('2026-07-17T00:01:00.000Z'));

        expect(podium.positions).toEqual([
            {
                rank: 1,
                displayName: 'RaceFan',
                identityType: 'reddit',
                formattedTime: '0:12.34',
            },
            expect.objectContaining({
                rank: 2,
                identityType: 'private',
                formattedTime: '0:13.56',
            }),
            {
                rank: 3,
                displayName: 'No verified finish',
                identityType: 'empty',
                formattedTime: null,
            },
        ]);
        expect(podium.positions[1].displayName).not.toContain('HiddenUser');
        expect(JSON.stringify(podium)).not.toContain('private-player');
    });

    it('does not schedule a geometry definition until its key is added to the catalog schedule', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-10T12:00:00.000Z'));
        TRACKS.geometryOnlyTestTrack = TRACKS.circuit;

        try {
            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge.trackKey).toBe(TRACK_SCHEDULE_KEYS[0]);
            expect(challenge.trackKey).not.toBe('geometryOnlyTestTrack');
        } finally {
            delete TRACKS.geometryOnlyTestTrack;
            vi.useRealTimers();
        }
    });

    it('makes a catalog addition the next eligible scheduled track', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-11T12:00:00.000Z'));
        const testTrackKey = 'catalogScheduleTestTrack';
        const priorTrackKey = TRACK_SCHEDULE_KEYS.at(-1);
        TRACK_CATALOG[testTrackKey] = { name: 'Catalog Schedule Test Track' };
        TRACK_SCHEDULE_KEYS.push(testTrackKey);
        mockRedis.hGetAll.mockResolvedValue({
            'daily-gp-2030-01-10': JSON.stringify({
                id: 'daily-gp-2030-01-10',
                challengeDate: '2030-01-10',
                trackKey: priorTrackKey,
                startsAt: '2030-01-10T00:00:00.000Z',
                endsAt: '2030-01-11T00:00:00.000Z',
                availableUntil: '2030-01-17T00:00:00.000Z',
            }),
        });

        try {
            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge.trackKey).toBe(testTrackKey);
        } finally {
            TRACK_SCHEDULE_KEYS.pop();
            delete TRACK_CATALOG[testTrackKey];
            vi.useRealTimers();
        }
    });

    it('keeps an already-published day frozen when the future schedule changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-12T12:00:00.000Z'));
        const storedChallenge = {
            id: 'daily-gp-2030-01-12',
            challengeDate: '2030-01-12',
            trackKey: 'sunlitTemple',
            startsAt: '2030-01-12T00:00:00.000Z',
            endsAt: '2030-01-13T00:00:00.000Z',
            availableUntil: '2030-01-19T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        mockRedis.hGet.mockResolvedValue(JSON.stringify(storedChallenge));
        TRACK_SCHEDULE_KEYS.reverse();

        try {
            const { getServerDailyGpChallenge } = await import('../src/server/daily-gp-store.ts');
            const challenge = await getServerDailyGpChallenge();

            expect(challenge).toEqual(storedChallenge);
        } finally {
            TRACK_SCHEDULE_KEYS.reverse();
            vi.useRealTimers();
        }
    });

    it('filters snapshot rows whose stored track does not match the challenge track', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const mismatchedTrackKey = challenge.trackKey === 'circuit' ? 'sunlitTemple' : 'circuit';

        mockRedis.zCard.mockResolvedValue(1);
        mockRedis.zRange.mockResolvedValue([
            { member: 'guest:browser-player-id', score: 12345 },
        ]);
        mockRedis.hMGet.mockResolvedValue([
            JSON.stringify({
                playerId: 'guest:browser-player-id',
                trackKey: mismatchedTrackKey,
                bestTimeMs: 12345,
                updatedAt: '2026-06-02T12:00:00.000Z',
                checkpointTimesSec: checkpointSplitsForChallenge(challenge, 12.345),
            }),
        ]);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            playerId: 'browser-player-id',
            communityMemberTotal: 1,
        });

        expect(snapshot.topRows).toEqual([]);
        expect(snapshot.currentPlayerRow).toBe(null);
    });

    it('returns the requested leaderboard rank page with continuation metadata', async () => {
        const { getServerDailyGpChallenge, getServerDailyGpSnapshot } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        const members = [
            { member: 'guest:player-101', score: 20101 },
            { member: 'guest:player-102', score: 20102 },
        ];
        const entries = members.map((member, index) => JSON.stringify({
            playerId: member.member,
            trackKey: challenge.trackKey,
            bestTimeMs: 20101 + index,
            updatedAt: '2026-06-02T12:00:00.000Z',
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 20.101 + (index / 1000)),
        }));

        mockRedis.zCard.mockResolvedValue(180);
        mockRedis.zRange.mockResolvedValue(members);
        mockRedis.hMGet.mockImplementation(async (key) => key.endsWith(':entries') ? entries : []);

        const snapshot = await getServerDailyGpSnapshot({
            challengeId: challenge.id,
            limit: 50,
            offset: 100,
        });

        expect(mockRedis.zRange).toHaveBeenCalledWith(
            expect.stringContaining(challenge.id),
            100,
            149,
        );
        expect(snapshot.topRows.map((row) => row.rank)).toEqual([101, 102]);
        expect(snapshot).toMatchObject({
            pageOffset: 100,
            pageLimit: 50,
            hasMore: true,
            nextOffset: 150,
            leaderboardEntryCount: 180,
        });
    });

    it('rejects submissions when strict replay validation fails', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: false,
            failure: {
                reason: 'no_finish',
                simulatedTimeSec: 1.2,
                position: { x: 5, y: -10 },
            },
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            bestTime: 2,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: 'no_finish',
                strictReplayFailureReason: 'no_finish',
            },
        });
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    it('rejects relaunch-delay replays that do not finish under strict validation', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: false,
            failure: { reason: 'crashed' },
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: {
                inputs: [
                    { frames: 30, left: false, right: false, relaunchDelay: true },
                    { frames: 120, left: false, right: false, relaunchDelay: false },
                ],
            },
            bestTime: 2,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: 'crashed',
                strictReplayFailureReason: 'crashed',
            },
        });
    });

    it('rejects submitted times when strict replay does not validate the run', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: false,
            failure: { reason: 'no_finish' },
        });

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            bestTime: 8,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 8),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission replay validation failed.',
                reason: 'no_finish',
                strictReplayFailureReason: 'no_finish',
            },
        });
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalled();
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    it('rejects submissions when the submitted track does not match the challenge', async () => {
        const { getServerDailyGpChallenge, submitServerDailyGpRun } = await import('../src/server/daily-gp-store.ts');
        const challenge = await getServerDailyGpChallenge();

        const result = await submitServerDailyGpRun({
            playerId: 'browser-player-id',
            challengeId: challenge.id,
            trackKey: 'not-the-challenge-track',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
            bestTime: 2,
            checkpointTimesSec: checkpointSplitsForChallenge(challenge, 2),
        });

        expect(result).toEqual({
            status: 422,
            body: {
                accepted: false,
                error: 'Submission track does not match challenge.',
                reason: 'track_mismatch',
            },
        });
        expect(mockValidateDailyGpReplayDetailed).not.toHaveBeenCalled();
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    it('keeps the last stored identity on bootstrap reads until the player changes it', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
        mockRedis.get.mockResolvedValueOnce(JSON.stringify({
            playerId: 'reddit:pm-user',
            leaderboardIdentity: 'reddit',
            redditUsername: 'Pm-User',
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        }));

        const payload = await getServerPlayerBootstrap({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
        });

        expect(payload.leaderboardIdentity).toBe('reddit');
        const storedProfile = findWrittenPlayerProfile('reddit:pm-user');
        expect(storedProfile.profile.leaderboardIdentity).toBe('reddit');
    });

    it('updates stored identity only when the player explicitly changes it', async () => {
        const { updateServerPlayerIdentity } = await import('../src/server/daily-gp-store.ts');
        mockRedis.get.mockResolvedValueOnce(JSON.stringify({
            playerId: 'reddit:pm-user',
            leaderboardIdentity: 'constructed',
            redditUsername: 'Pm-User',
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        }));

        const payload = await updateServerPlayerIdentity({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
            leaderboardIdentity: 'reddit',
        });

        expect(payload).toEqual({
            playerId: 'reddit:pm-user',
            guestToken: null,
            leaderboardIdentity: 'reddit',
        });
        const storedProfile = findWrittenPlayerProfile('reddit:pm-user');
        expect(storedProfile.profile.leaderboardIdentity).toBe('reddit');
    });

    it('ignores profiles left in the retired shared hash', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify({
            playerId: 'reddit:pm-user',
            leaderboardIdentity: 'reddit',
            redditUsername: 'Pm-User',
            preferences: {
                carSkin: 'assets/cars/retired.webp',
                trailId: 'gold',
                musicEnabled: false,
                carAudioEnabled: false,
                crashAutoRestartEnabled: false,
                crashRestartDelaySec: 1,
            },
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        }));

        const payload = await getServerPlayerBootstrap({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
        });

        expect(payload).toMatchObject({
            leaderboardIdentity: 'constructed',
            playerPreferences: null,
            hasAnyData: false,
        });
        expect(mockRedis.hGet).not.toHaveBeenCalledWith('dailygp:player-profiles', 'reddit:pm-user');
    });

    it('stores player preferences in Redis and restores them in the next bootstrap', async () => {
        const {
            getServerPlayerBootstrap,
            updateServerPlayerPreferences,
        } = await import('../src/server/daily-gp-store.ts');
        const playerPreferences = {
            carSkin: 'assets/cars/mr_mr_red.webp',
            trailId: 'gold',
            musicEnabled: false,
            carAudioEnabled: true,
            crashAutoRestartEnabled: false,
            crashRestartDelaySec: 0.8,
            pbGhostEnabled: true,
        };

        const saved = await updateServerPlayerPreferences({
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
            playerPreferences,
        });
        expect(saved).toEqual({
            playerId: 'reddit:pm-user',
            guestToken: null,
            playerPreferences,
        });

        const profileWrite = findWrittenPlayerProfile('reddit:pm-user');
        const storedProfile = profileWrite.profile;
        expect(storedProfile.preferences).toEqual(playerPreferences);

        mockRedis.get.mockResolvedValueOnce(JSON.stringify(storedProfile));
        const bootstrap = await getServerPlayerBootstrap({
            playerId: 'new-browser-player-id-after-update',
            redditUsername: 'Pm-User',
        });
        expect(bootstrap.playerPreferences).toEqual(playerPreferences);
    });

    it('gives each player profile its own 180-day expiration', async () => {
        const { getServerPlayerBootstrap } = await import('../src/server/daily-gp-store.ts');
        const beforeWrite = Date.now();

        await getServerPlayerBootstrap({ redditUsername: 'Player-One' });
        await getServerPlayerBootstrap({ redditUsername: 'Player-Two' });

        const first = findWrittenPlayerProfile('reddit:player-one');
        const second = findWrittenPlayerProfile('reddit:player-two');
        expect(first.key).not.toBe(second.key);
        expect(first.options.expiration).toBeInstanceOf(Date);
        expect(second.options.expiration).toBeInstanceOf(Date);
        const minimumExpectedExpiry = beforeWrite + (179 * 24 * 60 * 60 * 1000);
        expect(first.options.expiration.getTime()).toBeGreaterThan(minimumExpectedExpiry);
        expect(second.options.expiration.getTime()).toBeGreaterThan(minimumExpectedExpiry);
        expect(mockRedis.expire).not.toHaveBeenCalledWith('dailygp:player-profiles', expect.anything());
    });
});
