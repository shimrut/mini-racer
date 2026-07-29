import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TRACKS } from '../game/track/tracks.js';
import { createTrackFingerprint } from '../src/server/pb-ghost-trace.ts';

const hashes = new Map();
const strings = new Map();
const mockRedis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options = {}) => {
        if (options.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (key) => {
        strings.delete(key);
        return 1;
    }),
    hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? [])),
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
    mGet: vi.fn(async (keys) => keys.map((key) => strings.get(key) ?? null)),
    hDel: vi.fn(async (key, fields) => {
        const hash = hashes.get(key);
        if (!hash) return 0;
        return fields.filter((field) => hash.delete(field)).length;
    }),
    zRem: vi.fn(async () => 1),
    hSet: vi.fn(async (key, entries) => {
        const hash = hashes.get(key) ?? new Map();
        for (const [field, value] of Object.entries(entries)) hash.set(field, value);
        hashes.set(key, hash);
        return Object.keys(entries).length;
    }),
    hSetNX: vi.fn(async (key, field, value) => {
        const hash = hashes.get(key) ?? new Map();
        if (hash.has(field)) return 0;
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
    }),
    incrBy: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    expireTime: vi.fn(async () => Math.floor(Date.now() / 1000) + 60),
    zAdd: vi.fn(async () => 1),
    zCard: vi.fn(async () => 0),
    zRange: vi.fn(async () => []),
    zRank: vi.fn(async () => undefined),
    watch: vi.fn(),
};
const mockValidateDailyGpReplayDetailed = vi.fn();

/**
 * Display names come from the player profile now, not from a name frozen into
 * the leaderboard row, so a board that should show a name needs a profile.
 */
function seedPlayerProfile(playerId, redditUsername) {
    const playerKey = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    strings.set(`dailygp:player-profile:${playerKey}`, JSON.stringify({
        playerId,
        leaderboardIdentity: 'reddit',
        redditUsername,
        preferences: null,
        hasSeenGame: true,
        hasAnyData: true,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    }));
}

function createTransaction() {
    const commands = [];
    return {
        multi: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {}),
        del: vi.fn(async (...args) => commands.push(() => mockRedis.del(...args))),
        set: vi.fn(async (...args) => commands.push(() => mockRedis.set(...args))),
        hSet: vi.fn(async (...args) => commands.push(() => mockRedis.hSet(...args))),
        zAdd: vi.fn(async (...args) => commands.push(() => mockRedis.zAdd(...args))),
        expire: vi.fn(async (...args) => commands.push(() => mockRedis.expire(...args))),
        exec: vi.fn(async () => {
            const results = [];
            for (const command of commands) results.push(await command());
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

describe('Campaign server store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hashes.clear();
        strings.clear();
        mockRedis.get.mockImplementation(async (key) => strings.get(key) ?? null);
        mockRedis.set.mockImplementation(async (key, value, options = {}) => {
            if (options.nx && strings.has(key)) return '';
            strings.set(key, value);
            return 'OK';
        });
        mockRedis.del.mockImplementation(async (key) => {
            strings.delete(key);
            return 1;
        });
        mockRedis.hGet.mockImplementation(async (key, field) => hashes.get(key)?.get(field) ?? null);
        mockRedis.hGetAll.mockImplementation(async (key) => Object.fromEntries(hashes.get(key) ?? []));
        mockRedis.hMGet.mockImplementation(async (key, fields) => (
            fields.map((field) => hashes.get(key)?.get(field) ?? null)
        ));
        mockRedis.hSet.mockImplementation(async (key, entries) => {
            const hash = hashes.get(key) ?? new Map();
            for (const [field, value] of Object.entries(entries)) hash.set(field, value);
            hashes.set(key, hash);
            return Object.keys(entries).length;
        });
        mockRedis.hSetNX.mockImplementation(async (key, field, value) => {
            const hash = hashes.get(key) ?? new Map();
            if (hash.has(field)) return 0;
            hash.set(field, value);
            hashes.set(key, hash);
            return 1;
        });
        mockRedis.incrBy.mockResolvedValue(1);
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 60);
        mockRedis.zAdd.mockResolvedValue(1);
        mockRedis.zCard.mockResolvedValue(0);
        mockRedis.zRange.mockResolvedValue([]);
        mockRedis.zRank.mockResolvedValue(undefined);
        mockRedis.watch.mockImplementation(() => createTransaction());
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 12.345,
                bestTimeMs: 12345,
                completedLaps: 1,
                checkpointTimesSec: [4.2, 9.8],
                lapCompletionTimesSec: [12.345],
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 50,
                    origin: [0, 0, 0],
                    deltas: [1, 1, 1],
                },
                method: 'finish',
            },
        });
    });

    it('refuses an unidentified request and performs no Campaign write', async () => {
        const { getServerCampaignBootstrap, submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
        const bootstrap = await getServerCampaignBootstrap({ redditUsername: null });
        expect(bootstrap).toMatchObject({
            status: 200,
            body: {
                signedIn: false,
                progress: { unlockedRaceIds: ['numbered-v1-00'] },
            },
        });

        const submission = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { inputs: [] },
            redditUsername: null,
        });
        expect(submission).toMatchObject({ status: 401, body: { accepted: false } });
        expect(mockRedis.hSet).not.toHaveBeenCalled();
        expect(mockRedis.set).not.toHaveBeenCalled();
        expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    it('keeps each player progress in its own key rather than one campaign hash', async () => {
        const { startServerCampaignRace, getServerCampaignBootstrap } = await import('../src/server/campaign-store.ts');
        await startServerCampaignRace({ raceId: 'numbered-v1-00', redditUsername: 'RaceFan' });
        await startServerCampaignRace({ raceId: 'numbered-v1-00', redditUsername: 'OtherRacer' });

        const progressKeys = [...strings.keys()].filter((key) => key.includes(':progress'));
        expect(progressKeys).toHaveLength(2);
        expect(new Set(progressKeys).size).toBe(2);
        // Progress must never be a field inside one shared, unbounded hash.
        expect([...hashes.keys()].some((key) => key.endsWith(':progress'))).toBe(false);

        const first = await getServerCampaignBootstrap({ redditUsername: 'RaceFan' });
        const second = await getServerCampaignBootstrap({ redditUsername: 'OtherRacer' });
        expect(first.body.progress.startedAt).toEqual(expect.any(String));
        expect(second.body.progress.startedAt).toEqual(expect.any(String));
    });

    it('persists Campaign start once so an unfinished run resumes as Continue', async () => {
        const {
            getServerCampaignBootstrap,
            startServerCampaignRace,
        } = await import('../src/server/campaign-store.ts');
        const first = await startServerCampaignRace({
            raceId: 'numbered-v1-00',
            redditUsername: 'RaceFan',
        });
        const second = await startServerCampaignRace({
            raceId: 'numbered-v1-00',
            redditUsername: 'RaceFan',
        });
        const bootstrap = await getServerCampaignBootstrap({ redditUsername: 'RaceFan' });

        expect(first.body.progress.startedAt).toEqual(expect.any(String));
        expect(second.body.progress.startedAt).toBe(first.body.progress.startedAt);
        expect(bootstrap.body.progress.startedAt).toBe(first.body.progress.startedAt);
    });

    it('persists the replay-derived result and unlocks the next race only from the server medal', async () => {
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 1,
                bestTimeMs: 1000,
                completedLaps: 1,
                checkpointTimesSec: [0.4, 0.8],
                lapCompletionTimesSec: [1],
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 50,
                    origin: [0, 0, 0],
                    deltas: [1, 1, 1],
                },
                method: 'finish',
            },
        });
        const {
            getServerCampaignPbGhost,
            submitServerCampaignRun,
        } = await import('../src/server/campaign-store.ts');
        const result = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 1,
            replay: { rulesRevision: 1, targetLapNumber: 1, inputs: [{ frames: 60, left: false, right: false, relaunchDelay: false }] },
            redditUsername: 'RaceFan',
        });

        expect(result).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                improved: true,
                bestTimeMs: 1000,
                trackPbPersistenceStatus: 'stored',
                progress: {
                    // One Author is four medals, past stage 02's price of 3 — but
                    // the ladder still opens only the stage after the one raced.
                    unlockedRaceIds: ['numbered-v1-00', 'numbered-v1-01'],
                    resultsByRaceId: {
                        'numbered-v1-00': { bestTimeMs: 1000, medal: 'author' },
                    },
                },
            },
        });
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalledWith({
            challenge: expect.objectContaining({
                trackKey: 'numberZero',
                objectiveParams: { lapCount: 1 },
                rulesRevision: 1,
            }),
            replay: expect.any(Object),
        });
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            'campaign:numbered-v1:leaderboard:numbered-v1-00',
            { member: 'reddit:racefan', score: 1000 },
        );
        await expect(getServerCampaignPbGhost({
            raceId: 'numbered-v1-00',
            redditUsername: 'RaceFan',
        })).resolves.toMatchObject({
            status: 200,
            body: {
                personalBest: {
                    bestTimeMs: 1000,
                    lapCompletionTimesSec: [1],
                },
            },
        });
    });

    it('persists verified Campaign PB pace even when the run earns no medal', async () => {
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 999,
                bestTimeMs: 999_000,
                completedLaps: 1,
                checkpointTimesSec: [300, 600],
                lapCompletionTimesSec: [999],
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 50,
                    origin: [0, 0, 0],
                    deltas: [1, 1, 1],
                },
                method: 'finish',
            },
        });
        const {
            getServerCampaignPbGhost,
            submitServerCampaignRun,
        } = await import('../src/server/campaign-store.ts');

        const submission = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { rulesRevision: 1, targetLapNumber: 1, inputs: [] },
            redditUsername: 'NoMedalYet',
        });
        const stored = await getServerCampaignPbGhost({
            raceId: 'numbered-v1-00',
            redditUsername: 'NoMedalYet',
        });

        expect(submission).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                bestTimeMs: 999_000,
                trackPbPersistenceStatus: 'stored',
                progress: {
                    resultsByRaceId: {
                        'numbered-v1-00': { medal: null, bestTimeMs: 999_000 },
                    },
                },
            },
        });
        expect(stored).toMatchObject({
            status: 200,
            body: {
                personalBest: {
                    bestTimeMs: 999_000,
                    lapCompletionTimesSec: [999],
                },
            },
        });
    });

    it('does not reject an authoritative result when Campaign ghost storage fails', async () => {
        const defaultHSet = mockRedis.hSet.getMockImplementation();
        mockRedis.hSet.mockImplementation(async (key, entries) => {
            if (String(key).includes(':pbs:')) throw new Error('ghost unavailable');
            return defaultHSet(key, entries);
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
        const result = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { inputs: [{ frames: 60, left: false, right: false, relaunchDelay: false }] },
            redditUsername: 'RaceFan',
        });

        expect(result).toMatchObject({
            status: 200,
            body: {
                accepted: true,
                improved: true,
                trackPbPersistenceStatus: 'unavailable',
            },
        });
        expect(consoleError).toHaveBeenCalled();
    });

    it('rejects locked stages before replay validation', async () => {
        const { startServerCampaignRace, submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
        expect(await startServerCampaignRace({
            raceId: 'numbered-v1-01',
            redditUsername: 'RaceFan',
        })).toMatchObject({ status: 403 });
        expect(await submitServerCampaignRun({
            raceId: 'numbered-v1-01',
            trackKey: 'numberOne',
            replay: {},
            redditUsername: 'RaceFan',
        })).toMatchObject({ status: 403, body: { accepted: false } });
        expect(mockValidateDailyGpReplayDetailed).not.toHaveBeenCalled();
    });

    it('marks and prepares only an exact compatible Campaign opponent ghost without exposing identity', async () => {
        const raceId = 'numbered-v1-00';
        const playerId = 'reddit:opponent';
        const updatedAt = '2026-07-27T10:00:00.000Z';
        const result = {
            raceId,
            trackKey: 'numberZero',
            lapCount: 1,
            rulesRevision: 1,
            bestTimeMs: 100,
            medal: 'author',
            checkpointTimesSec: [0.02, 0.05, 0.08],
            updatedAt,
        };
        const entryKey = `campaign:numbered-v1:leaderboard:${raceId}:entries`;
        const pbKey = `campaign:numbered-v1:pbs:${raceId}`;
        seedPlayerProfile(playerId, 'Opponent');
        hashes.set(entryKey, new Map([[
            playerId,
            JSON.stringify({ ...result, playerId }),
        ]]));
        hashes.set(pbKey, new Map([[
            createHash('sha256').update(playerId, 'utf8').digest('base64url'),
            JSON.stringify({
                ...result,
                schemaVersion: 2,
                simulationRevision: 1,
                trackFingerprint: createTrackFingerprint(TRACKS.numberZero),
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 100,
                    origin: [0, 0, 0],
                    deltas: [0, 0, 0, 0, 0, 0],
                },
            }),
        ]]));
        mockRedis.zCard.mockResolvedValue(1);
        mockRedis.zRange.mockResolvedValue([{ member: playerId, score: 100 }]);

        const {
            getServerCampaignSnapshot,
            prepareServerCampaignLeaderboardRace,
        } = await import('../src/server/campaign-store.ts');
        await expect(getServerCampaignSnapshot({
            raceId,
            redditUsername: 'RaceFan',
        })).resolves.toMatchObject({
            status: 200,
            body: {
                topRows: [{
                    rank: 1,
                    displayName: 'Opponent',
                    opponentRaceAvailable: true,
                }],
            },
        });

        const prepared = await prepareServerCampaignLeaderboardRace({
            raceId,
            redditUsername: 'RaceFan',
            selection: {
                kind: 'row',
                rank: 1,
                displayName: 'Opponent',
                bestTimeMs: 100,
                updatedAt,
            },
        });
        expect(prepared).toMatchObject({
            status: 200,
            body: {
                mode: 'campaign',
                race: { raceId, trackKey: 'numberZero' },
                target: {
                    rank: 1,
                    displayName: 'Opponent',
                    bestTimeMs: 100,
                    checkpointTimesSec: [0.02, 0.05, 0.08],
                    updatedAt,
                    ghost: { finishTimeMs: 100 },
                },
            },
        });
        expect(JSON.stringify(prepared)).not.toContain(playerId);
    });

    it('offers the closest faster rival after a win, and none once the player leads', async () => {
        const raceId = 'numbered-v1-00';
        const rivalId = 'reddit:opponent';
        const playerId = 'reddit:racefan';
        const baseResult = {
            raceId,
            trackKey: 'numberZero',
            lapCount: 1,
            rulesRevision: 1,
            medal: 'gold',
            checkpointTimesSec: [0.02, 0.05, 0.08],
        };
        seedPlayerProfile(rivalId, 'Opponent');
        seedPlayerProfile(playerId, 'RaceFan');
        const entries = new Map([
            [rivalId, JSON.stringify({
                ...baseResult,
                playerId: rivalId,
                bestTimeMs: 100,
                updatedAt: '2026-07-27T10:00:00.000Z',
            })],
            [playerId, JSON.stringify({
                ...baseResult,
                playerId,
                bestTimeMs: 140,
                updatedAt: '2026-07-27T11:00:00.000Z',
            })],
        ]);
        hashes.set(`campaign:numbered-v1:leaderboard:${raceId}:entries`, entries);
        hashes.set(`campaign:numbered-v1:pbs:${raceId}`, new Map([[
            createHash('sha256').update(rivalId, 'utf8').digest('base64url'),
            JSON.stringify({
                ...baseResult,
                bestTimeMs: 100,
                updatedAt: '2026-07-27T09:59:59.812Z',
                schemaVersion: 2,
                simulationRevision: 1,
                trackFingerprint: createTrackFingerprint(TRACKS.numberZero),
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 100,
                    origin: [0, 0, 0],
                    deltas: [0, 0, 0, 0, 0, 0],
                },
            }),
        ]]));
        const ranked = [
            { member: rivalId, score: 100 },
            { member: playerId, score: 140 },
        ];
        mockRedis.zCard.mockResolvedValue(ranked.length);
        mockRedis.zRange.mockImplementation(async (_key, start, stop) => (
            ranked.slice(start, stop + 1)
        ));
        mockRedis.zRank.mockImplementation(async (_key, member) => {
            const index = ranked.findIndex((row) => row.member === member);
            return index === -1 ? undefined : index;
        });

        const { prepareServerCampaignLeaderboardRace } = await import('../src/server/campaign-store.ts');
        await expect(prepareServerCampaignLeaderboardRace({
            raceId,
            redditUsername: 'RaceFan',
            selection: { kind: 'next-faster', benchmarkTimeMs: 140 },
        })).resolves.toMatchObject({
            status: 200,
            body: { target: { rank: 1, displayName: 'Opponent', bestTimeMs: 100 } },
        });

        // Once the player owns the top time there is nobody left to chase, and
        // the finish falls back to Improve on the strength of this answer.
        ranked.reverse();
        entries.set(playerId, JSON.stringify({
            ...baseResult,
            playerId,
            bestTimeMs: 80,
            updatedAt: '2026-07-27T11:30:00.000Z',
        }));
        await expect(prepareServerCampaignLeaderboardRace({
            raceId,
            redditUsername: 'RaceFan',
            selection: { kind: 'next-faster', benchmarkTimeMs: 80 },
        })).resolves.toMatchObject({
            status: 404,
            body: { reason: 'no_faster_opponent' },
        });
    });

    it('races a stored ghost whose record timestamp predates the leaderboard entry', async () => {
        const raceId = 'numbered-v1-00';
        const playerId = 'reddit:opponent';
        const result = {
            raceId,
            trackKey: 'numberZero',
            lapCount: 1,
            rulesRevision: 1,
            bestTimeMs: 100,
            medal: 'author',
            checkpointTimesSec: [0.02, 0.05, 0.08],
            updatedAt: '2026-07-27T10:00:00.000Z',
        };
        const ghost = {
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: 100,
            origin: [0, 0, 0],
            deltas: [0, 0, 0, 0, 0, 0],
        };
        const pbField = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        const entryKey = `campaign:numbered-v1:leaderboard:${raceId}:entries`;
        const pbKey = `campaign:numbered-v1:pbs:${raceId}`;
        seedPlayerProfile(playerId, 'Opponent');
        hashes.set(entryKey, new Map([[
            playerId,
            JSON.stringify({ ...result, playerId }),
        ]]));
        hashes.set(pbKey, new Map([[
            pbField,
            JSON.stringify({
                ...result,
                // Written by its own clock before the two writes shared one.
                updatedAt: '2026-07-27T09:59:59.812Z',
                schemaVersion: 2,
                simulationRevision: 1,
                trackFingerprint: createTrackFingerprint(TRACKS.numberZero),
                ghost,
            }),
        ]]));
        mockRedis.zCard.mockResolvedValue(1);
        mockRedis.zRange.mockResolvedValue([{ member: playerId, score: 100 }]);

        const {
            getServerCampaignSnapshot,
            prepareServerCampaignLeaderboardRace,
        } = await import('../src/server/campaign-store.ts');
        await expect(getServerCampaignSnapshot({
            raceId,
            redditUsername: 'RaceFan',
        })).resolves.toMatchObject({
            status: 200,
            body: { topRows: [{ rank: 1, opponentRaceAvailable: true }] },
        });
        await expect(prepareServerCampaignLeaderboardRace({
            raceId,
            redditUsername: 'RaceFan',
            selection: {
                kind: 'row',
                rank: 1,
                displayName: 'Opponent',
                bestTimeMs: 100,
                updatedAt: result.updatedAt,
            },
        })).resolves.toMatchObject({
            status: 200,
            body: { target: { ghost: { finishTimeMs: 100 } } },
        });

        // The best time is what pins the ghost to the row, so a record left
        // behind by a faster entry is still refused.
        hashes.get(pbKey).set(pbField, JSON.stringify({
            ...result,
            bestTimeMs: 140,
            schemaVersion: 2,
            simulationRevision: 1,
            trackFingerprint: createTrackFingerprint(TRACKS.numberZero),
            ghost: { ...ghost, finishTimeMs: 140 },
        }));
        await expect(getServerCampaignSnapshot({
            raceId,
            redditUsername: 'RaceFan',
        })).resolves.toMatchObject({
            status: 200,
            body: { topRows: [{ rank: 1, opponentRaceAvailable: false }] },
        });
        await expect(prepareServerCampaignLeaderboardRace({
            raceId,
            redditUsername: 'RaceFan',
            selection: {
                kind: 'row',
                rank: 1,
                displayName: 'Opponent',
                bestTimeMs: 100,
                updatedAt: result.updatedAt,
            },
        })).resolves.toMatchObject({
            status: 409,
            body: { reason: 'ghost_unavailable' },
        });
    });

    it('ranks a guest who carries a valid token', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const guestToken = await mintGuestPlayerToken('guest-racer');
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');

        const submission = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { rulesRevision: 1, targetLapNumber: 1, inputs: [] },
            playerId: 'guest-racer',
            guestToken,
        });

        expect(submission).toMatchObject({
            status: 200,
            body: { accepted: true, improved: true, bestTimeMs: 12345 },
        });
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            'campaign:numbered-v1:leaderboard:numbered-v1-00',
            { member: 'guest:guest-racer', score: 12345 },
        );
    });

    it('keeps a guest Campaign standing bounded but well past the guest profile', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const guestToken = await mintGuestPlayerToken('guest-ttl');
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');

        await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { rulesRevision: 1, targetLapNumber: 1, inputs: [] },
            playerId: 'guest-ttl',
            guestToken,
        });

        const boardExpiries = mockRedis.expire.mock.calls
            .filter(([key]) => String(key).startsWith('campaign:') && !String(key).includes('rate-limit'))
            .map(([, seconds]) => seconds);
        expect(boardExpiries.length).toBeGreaterThan(0);
        // Long enough that returning after the 7-day guest profile lapses does
        // not cost the unlocks they earned.
        for (const seconds of boardExpiries) {
            expect(seconds).toBeGreaterThan(7 * 24 * 60 * 60);
        }
    });

    it('never expires a signed-in player Campaign standing', async () => {
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
        await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { rulesRevision: 1, targetLapNumber: 1, inputs: [] },
            redditUsername: 'Permanent',
        });

        const campaignExpiries = mockRedis.expire.mock.calls
            .filter(([key]) => String(key).startsWith('campaign:') && !String(key).includes('rate-limit'));
        expect(campaignExpiries).toEqual([]);
    });

    it('moves a guest Campaign standing onto the account at sign-in, keeping the better time', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const guestToken = await mintGuestPlayerToken('guest-merge');
        const {
            getServerCampaignBootstrap,
            mergeGuestCampaignProgress,
            submitServerCampaignRun,
        } = await import('../src/server/campaign-store.ts');

        // The guest earns Author on stage 00, which unlocks stage 01.
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 1,
                bestTimeMs: 1000,
                completedLaps: 1,
                checkpointTimesSec: [0.4],
                lapCompletionTimesSec: [1],
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 1000,
                    origin: [0, 0, 0],
                    deltas: [1, 1, 1],
                },
                method: 'finish',
            },
        });
        await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { rulesRevision: 1, targetLapNumber: 1, inputs: [] },
            playerId: 'guest-merge',
            guestToken,
        });

        const merged = await mergeGuestCampaignProgress({
            guestPlayerId: 'guest:guest-merge',
            redditPlayerId: 'reddit:claimed',
        });
        expect(merged).toEqual({ merged: true, mergedRaceIds: ['numbered-v1-00'] });

        // The account now owns the unlock the guest earned...
        await expect(getServerCampaignBootstrap({ redditUsername: 'Claimed' }))
            .resolves.toMatchObject({
                status: 200,
                body: {
                    progress: {
                        unlockedRaceIds: ['numbered-v1-00', 'numbered-v1-01'],
                        resultsByRaceId: {
                            'numbered-v1-00': { bestTimeMs: 1000, medal: 'author' },
                        },
                    },
                },
            });
        // ...and the guest keeps nothing, so a second call changes nothing.
        await expect(mergeGuestCampaignProgress({
            guestPlayerId: 'guest:guest-merge',
            redditPlayerId: 'reddit:claimed',
        })).resolves.toEqual({ merged: false, mergedRaceIds: [] });
    });

    it('refuses to trade a verified account time down for a slower guest one', async () => {
        const { mergeGuestCampaignProgress, parseCampaignProgress } = await import('../src/server/campaign-store.ts');
        const progressKeyFor = (playerId) => `campaign:numbered-v1:progress:${
            createHash('sha256').update(playerId, 'utf8').digest('base64url')
        }`;
        const stageResult = (bestTimeMs, medal) => ({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            lapCount: 1,
            rulesRevision: 1,
            bestTimeMs,
            medal,
            checkpointTimesSec: null,
            updatedAt: '2026-07-27T10:00:00.000Z',
        });
        strings.set(progressKeyFor('guest:slower'), JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: { 'numbered-v1-00': stageResult(9000, 'bronze') },
            updatedAt: '2026-07-27T10:00:00.000Z',
        }));
        strings.set(progressKeyFor('reddit:faster'), JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: { 'numbered-v1-00': stageResult(1000, 'author') },
            updatedAt: '2026-07-27T10:00:00.000Z',
        }));

        await expect(mergeGuestCampaignProgress({
            guestPlayerId: 'guest:slower',
            redditPlayerId: 'reddit:faster',
        })).resolves.toEqual({ merged: false, mergedRaceIds: [] });

        const kept = parseCampaignProgress(strings.get(progressKeyFor('reddit:faster')));
        expect(kept.resultsByRaceId['numbered-v1-00']).toMatchObject({
            bestTimeMs: 1000,
            medal: 'author',
        });
    });
});
