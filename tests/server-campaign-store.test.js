import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { TRACKS } from '../game/track/tracks.js';
import { CAMPAIGN_STAGES } from '../game/campaign/manifest.js';
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
        hashes.delete(key);
        return 1;
    }),
    hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? [])),
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
    // Delegate so a test that overrides get() also steers the batched read the lock layer uses.
    mGet: vi.fn(async (keys) => await Promise.all(keys.map((key) => mockRedis.get(key)))),
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
    zScore: vi.fn(async () => undefined),
    zRank: vi.fn(async () => undefined),
    watch: vi.fn(),
};
const mockValidateDailyGpReplayDetailed = vi.fn();

function decodeCompressedValue(value) {
    if (typeof value !== 'string' || !value.startsWith('__gz:b64__:')) return value;
    try {
        return gunzipSync(Buffer.from(value.slice('__gz:b64__:'.length), 'base64')).toString('utf8');
    } catch (_error) {
        return value;
    }
}

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
        hDel: vi.fn(async (...args) => commands.push(() => mockRedis.hDel(...args))),
        zAdd: vi.fn(async (...args) => commands.push(() => mockRedis.zAdd(...args))),
        zRem: vi.fn(async (...args) => commands.push(() => mockRedis.zRem(...args))),
        incrBy: vi.fn(async (...args) => commands.push(() => mockRedis.incrBy(...args))),
        expire: vi.fn(async (...args) => commands.push(() => mockRedis.expire(...args))),
        discard: vi.fn(async () => {}),
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
            hashes.delete(key);
            return 1;
        });
        mockRedis.hGet.mockImplementation(async (key, field) => (
            decodeCompressedValue(hashes.get(key)?.get(field) ?? null)
        ));
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
        mockRedis.zScore.mockResolvedValue(undefined);
        mockRedis.zRank.mockResolvedValue(undefined);
        mockRedis.watch.mockImplementation(() => createTransaction());
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 12.345,
                bestTimeMs: 12345,
                completedLaps: 2,
                checkpointTimesSec: [4.2, 9.8],
                lapCompletionTimesSec: [6.1, 12.345],
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

    it('unlocks Crimson from retained Campaign results created before unlock tracking', async () => {
        const playerId = 'reddit:campaign-veteran';
        const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        strings.set(`campaign:numbered-v1:progress:${playerHash}`, JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: {
                'numbered-v1-00': {
                    raceId: 'numbered-v1-00',
                    trackKey: 'numberZero',
                    lapCount: 2,
                    rulesRevision: 1,
                    bestTimeMs: 1000,
                    medal: 'author',
                    checkpointTimesSec: null,
                    updatedAt: '2026-07-27T10:00:00.000Z',
                },
            },
            updatedAt: '2026-07-27T10:00:00.000Z',
        }));
        const { getServerCampaignBootstrap } = await import('../src/server/campaign-store.ts');

        const bootstrap = await getServerCampaignBootstrap({
            redditUsername: 'Campaign-Veteran',
        });

        expect(bootstrap.body.carUnlocks.progress.completedRace).toBe(1);
        expect(bootstrap.body.carUnlocks.unlockedAssets)
            .toContain('assets/cars/mr_extra_crimson.webp');
    });

    it('persists the replay-derived result and unlocks the next race only from the server medal', async () => {
        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 1,
                bestTimeMs: 1000,
                completedLaps: 2,
                checkpointTimesSec: [0.4, 0.8],
                lapCompletionTimesSec: [0.5, 1],
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
            replay: { rulesRevision: 1, targetLapNumber: 2, inputs: [{ frames: 60, left: false, right: false, relaunchDelay: false }] },
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
                objectiveParams: { lapCount: 2 },
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
                    lapCompletionTimesSec: [0.5, 1],
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
                completedLaps: 2,
                checkpointTimesSec: [300, 600],
                lapCompletionTimesSec: [499, 999],
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
            replay: { rulesRevision: 1, targetLapNumber: 2, inputs: [] },
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
                    lapCompletionTimesSec: [499, 999],
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

    it('refuses a queued result whose account changed, before the stage lock can hide why', async () => {
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');

        const lockedStage = await submitServerCampaignRun({
            raceId: 'numbered-v1-01',
            trackKey: 'numberOne',
            replay: {},
            redditUsername: 'RaceFan',
            submissionOwnerId: 'reddit:someone-else',
        });
        const unlockedStage = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { inputs: [{ frames: 60, left: false, right: false, relaunchDelay: false }] },
            redditUsername: 'RaceFan',
            submissionOwnerId: 'reddit:someone-else',
        });

        for (const result of [lockedStage, unlockedStage]) {
            expect(result).toMatchObject({
                status: 409,
                body: { accepted: false, reason: 'submission_identity_changed' },
            });
        }
        expect(mockValidateDailyGpReplayDetailed).not.toHaveBeenCalled();
    });

    it('accepts a queued result that still names the account submitting it', async () => {
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');

        const result = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { inputs: [{ frames: 60, left: false, right: false, relaunchDelay: false }] },
            redditUsername: 'RaceFan',
            submissionOwnerId: 'reddit:racefan',
        });

        expect(result).toMatchObject({ status: 200, body: { accepted: true } });
    });

    it('marks and prepares only an exact compatible Campaign opponent ghost without exposing identity', async () => {
        const raceId = 'numbered-v1-00';
        const playerId = 'reddit:opponent';
        const updatedAt = '2026-07-27T10:00:00.000Z';
        const result = {
            raceId,
            trackKey: 'numberZero',
            lapCount: 2,
            rulesRevision: 1,
            bestTimeMs: 100,
            medal: 'author',
            checkpointTimesSec: [0.02, 0.05, 0.08, 0.11, 0.14, 0.17],
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
                    checkpointTimesSec: [0.02, 0.05, 0.08, 0.11, 0.14, 0.17],
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
            lapCount: 2,
            rulesRevision: 1,
            medal: 'gold',
            checkpointTimesSec: [0.02, 0.05, 0.08, 0.11, 0.14, 0.17],
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
            lapCount: 2,
            rulesRevision: 1,
            bestTimeMs: 100,
            medal: 'author',
            checkpointTimesSec: [0.02, 0.05, 0.08, 0.11, 0.14, 0.17],
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
            replay: { rulesRevision: 1, targetLapNumber: 2, inputs: [] },
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

    it('keeps shared Campaign collections permanent and expires only guest-owned progress after one year', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const guestToken = await mintGuestPlayerToken('guest-ttl');
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');

        await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { rulesRevision: 1, targetLapNumber: 2, inputs: [] },
            playerId: 'guest-ttl',
            guestToken,
        });

        const boardExpiries = mockRedis.expire.mock.calls
            .filter(([key]) => String(key).startsWith('campaign:') && !String(key).includes('rate-limit'))
            .map(([, seconds]) => seconds);
        expect(boardExpiries).toEqual([]);
        const progressSet = mockRedis.set.mock.calls.find(([key]) => String(key).includes(':progress:'));
        expect(progressSet?.[2]?.expiration).toBeInstanceOf(Date);
        expect(progressSet[2].expiration.getTime() - Date.now())
            .toBeGreaterThan(364 * 24 * 60 * 60 * 1000);
        expect(progressSet[2].expiration.getTime() - Date.now())
            .toBeLessThanOrEqual((365 * 24 * 60 * 60 * 1000) + 1000);
        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            'campaign:numbered-v1:guest-expiry',
            expect.objectContaining({ member: 'guest:guest-ttl' }),
        );
    });

    it('prunes an expired guest from every Campaign collection in one watched transaction', async () => {
        const nowMs = Date.now();
        const guestPlayerId = 'guest:expired';
        const guestField = createHash('sha256').update(guestPlayerId, 'utf8').digest('base64url');
        const { CAMPAIGN_GUEST_EXPIRY_KEY, cleanupExpiredCampaignGuests } = await import(
            '../src/server/campaign-store.ts'
        );
        mockRedis.zRange.mockResolvedValue([{
            member: guestPlayerId,
            score: nowMs - 1,
        }]);
        mockRedis.zScore.mockResolvedValue(nowMs - 1);

        await expect(cleanupExpiredCampaignGuests(nowMs)).resolves.toBe(1);

        expect(mockRedis.watch).toHaveBeenCalledWith(
            CAMPAIGN_GUEST_EXPIRY_KEY,
            expect.stringContaining(':progress-lock:'),
        );
        expect(mockRedis.del).toHaveBeenCalledWith(
            `campaign:numbered-v1:progress:${guestField}`,
        );
        expect(mockRedis.zRem).toHaveBeenCalledWith(
            CAMPAIGN_GUEST_EXPIRY_KEY,
            [guestPlayerId],
        );
        expect(mockRedis.hDel).toHaveBeenCalledWith(
            'campaign:numbered-v1:leaderboard:numbered-v1-00:entries',
            [guestPlayerId],
        );
        expect(mockRedis.hDel).toHaveBeenCalledWith(
            'campaign:numbered-v1:pbs:numbered-v1-00',
            [guestField],
        );
        expect(mockRedis.incrBy).toHaveBeenCalledWith(
            'campaign:numbered-v1:leaderboard:numbered-v1-00:standings-revision',
            1,
        );
    });

    it('does not delete a guest whose expiry was refreshed while cleanup was reading', async () => {
        const nowMs = Date.now();
        const guestPlayerId = 'guest:returning';
        const { cleanupExpiredCampaignGuests } = await import('../src/server/campaign-store.ts');
        mockRedis.zRange.mockResolvedValue([{
            member: guestPlayerId,
            score: nowMs - 1,
        }]);
        mockRedis.zScore.mockResolvedValue(nowMs + 90_000);

        await expect(cleanupExpiredCampaignGuests(nowMs)).resolves.toBe(0);

        expect(mockRedis.del).not.toHaveBeenCalled();
        expect(mockRedis.zRem).not.toHaveBeenCalled();
    });

    it('aborts cleanup while a guest progress update owns its lock', async () => {
        const nowMs = Date.now();
        const guestPlayerId = 'guest:locked';
        const guestField = createHash('sha256').update(guestPlayerId, 'utf8').digest('base64url');
        const { cleanupExpiredCampaignGuests } = await import('../src/server/campaign-store.ts');
        strings.set(`campaign:numbered-v1:progress-lock:${guestField}`, 'active');
        mockRedis.zRange.mockResolvedValue([{
            member: guestPlayerId,
            score: nowMs - 1,
        }]);
        mockRedis.zScore.mockResolvedValue(nowMs - 1);

        await expect(cleanupExpiredCampaignGuests(nowMs)).resolves.toBe(0);

        expect(mockRedis.del).not.toHaveBeenCalledWith(
            `campaign:numbered-v1:progress:${guestField}`,
        );
        expect(mockRedis.zRem).not.toHaveBeenCalled();
    });

    it('never expires a signed-in player Campaign standing', async () => {
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
        await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { rulesRevision: 1, targetLapNumber: 2, inputs: [] },
            redditUsername: 'Permanent',
        });

        const campaignExpiries = mockRedis.expire.mock.calls
            .filter(([key]) => String(key).startsWith('campaign:') && !String(key).includes('rate-limit'));
        expect(campaignExpiries).toEqual([]);
    });

    it('repairs missing progress when an accepted retry is no longer a board improvement', async () => {
        const playerId = 'reddit:repair';
        const entryKey = 'campaign:numbered-v1:leaderboard:numbered-v1-00:entries';
        hashes.set(entryKey, new Map([[
            playerId,
            JSON.stringify({
                playerId,
                trackKey: 'numberZero',
                bestTimeMs: 12_345,
                updatedAt: '2026-07-27T10:00:00.000Z',
                completedLaps: 2,
                checkpointTimesSec: [4.2, 9.8],
                validationMethod: 'strict-replay',
            }),
        ]]));
        const { submitServerCampaignRun, getServerCampaignBootstrap } = await import(
            '../src/server/campaign-store.ts'
        );

        const result = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { inputs: [] },
            redditUsername: 'Repair',
        });

        expect(result).toMatchObject({ status: 200, body: { accepted: true, improved: false } });
        await expect(getServerCampaignBootstrap({ redditUsername: 'Repair' }))
            .resolves.toMatchObject({
                body: {
                    progress: {
                        resultsByRaceId: {
                            'numbered-v1-00': { bestTimeMs: 12_345 },
                        },
                    },
                },
            });
    });

    it('repairs missing progress from a strict-replay leaderboard entry on bootstrap', async () => {
        const playerId = 'reddit:bootstrap-repair';
        const entryKey = 'campaign:numbered-v1:leaderboard:numbered-v1-00:entries';
        hashes.set(entryKey, new Map([[
            playerId,
            JSON.stringify({
                playerId,
                trackKey: 'numberZero',
                bestTimeMs: 12_345,
                updatedAt: '2026-07-27T10:00:00.000Z',
                completedLaps: 2,
                checkpointTimesSec: [4.2, 9.8],
                validationMethod: 'strict-replay',
            }),
        ]]));
        const { getServerCampaignBootstrap } = await import('../src/server/campaign-store.ts');

        await expect(getServerCampaignBootstrap({ redditUsername: 'Bootstrap-Repair' }))
            .resolves.toMatchObject({
                body: {
                    progress: {
                        resultsByRaceId: {
                            'numbered-v1-00': { bestTimeMs: 12_345 },
                        },
                    },
                },
            });
    });

    it('never lets a slower accepted retry overwrite a faster Campaign result', async () => {
        const playerId = 'reddit:faster';
        const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        strings.set(`campaign:numbered-v1:progress:${playerHash}`, JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: {
                'numbered-v1-00': {
                    raceId: 'numbered-v1-00',
                    trackKey: 'numberZero',
                    lapCount: 2,
                    rulesRevision: 1,
                    bestTimeMs: 1_000,
                    medal: 'author',
                    checkpointTimesSec: [0.4, 0.8],
                    updatedAt: '2026-07-27T10:00:00.000Z',
                },
            },
            updatedAt: '2026-07-27T10:00:00.000Z',
        }));
        hashes.set('campaign:numbered-v1:leaderboard:numbered-v1-00:entries', new Map([[
            playerId,
            JSON.stringify({
                playerId,
                trackKey: 'numberZero',
                bestTimeMs: 1_000,
                updatedAt: '2026-07-27T10:00:00.000Z',
                completedLaps: 2,
                checkpointTimesSec: [0.4, 0.8],
                validationMethod: 'strict-replay',
            }),
        ]]));
        const { submitServerCampaignRun, getServerCampaignBootstrap } = await import(
            '../src/server/campaign-store.ts'
        );

        const result = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { inputs: [] },
            redditUsername: 'Faster',
        });

        expect(result).toMatchObject({ status: 200, body: { accepted: true, improved: false } });
        await expect(getServerCampaignBootstrap({ redditUsername: 'Faster' }))
            .resolves.toMatchObject({
                body: {
                    progress: {
                        resultsByRaceId: {
                            'numbered-v1-00': { bestTimeMs: 1_000, medal: 'author' },
                        },
                    },
                },
            });
    });

    it('preserves both stages when different Campaign submissions overlap', async () => {
        const playerId = 'reddit:overlap';
        const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        strings.set(`campaign:numbered-v1:progress:${playerHash}`, JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: {
                'numbered-v1-00': {
                    raceId: 'numbered-v1-00',
                    trackKey: 'numberZero',
                    lapCount: 2,
                    rulesRevision: 1,
                    bestTimeMs: 20_000,
                    medal: 'author',
                    checkpointTimesSec: null,
                    updatedAt: '2026-07-27T10:00:00.000Z',
                },
            },
            updatedAt: '2026-07-27T10:00:00.000Z',
        }));
        const { getServerCampaignBootstrap, submitServerCampaignRun } = await import(
            '../src/server/campaign-store.ts'
        );

        const [first, second] = await Promise.all([
            submitServerCampaignRun({
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                replay: { inputs: [] },
                redditUsername: 'Overlap',
            }),
            submitServerCampaignRun({
                raceId: 'numbered-v1-01',
                trackKey: 'numberOne',
                replay: { inputs: [] },
                redditUsername: 'Overlap',
            }),
        ]);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        await expect(getServerCampaignBootstrap({ redditUsername: 'Overlap' }))
            .resolves.toMatchObject({
                body: {
                    progress: {
                        resultsByRaceId: {
                            'numbered-v1-00': { bestTimeMs: 12_345 },
                            'numbered-v1-01': { bestTimeMs: 12_345 },
                        },
                    },
                },
            });
    });

    it('moves a guest Campaign standing onto the account at sign-in, keeping the better time', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player-token.ts');
        const guestToken = await mintGuestPlayerToken('guest-merge');
        const {
            getServerCampaignBootstrap,
            mergeGuestCampaignProgress,
            submitServerCampaignRun,
        } = await import('../src/server/campaign-store.ts');

        mockValidateDailyGpReplayDetailed.mockReturnValue({
            ok: true,
            run: {
                bestTimeSec: 1,
                bestTimeMs: 1000,
                completedLaps: 2,
                checkpointTimesSec: [0.4],
                lapCompletionTimesSec: [0.5, 1],
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
            replay: { rulesRevision: 1, targetLapNumber: 2, inputs: [] },
            playerId: 'guest-merge',
            guestToken,
        });

        mockRedis.incrBy.mockClear();
        const merged = await mergeGuestCampaignProgress({
            guestPlayerId: 'guest:guest-merge',
            redditPlayerId: 'reddit:claimed',
        });
        expect(merged).toEqual({ merged: true, mergedRaceIds: ['numbered-v1-00'] });
        expect(mockRedis.incrBy).toHaveBeenCalledWith(
            'campaign:numbered-v1:leaderboard:numbered-v1-00:standings-revision',
            1,
        );

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
        await expect(mergeGuestCampaignProgress({
            guestPlayerId: 'guest:guest-merge',
            redditPlayerId: 'reddit:claimed',
        })).resolves.toEqual({ merged: false, mergedRaceIds: [] });
    });

    it('recovers a verified guest standing when the Campaign progress write was missed', async () => {
        const guestPlayerId = 'guest:orphan-standing';
        const redditPlayerId = 'reddit:orphan-standing';
        const raceId = 'numbered-v1-01';
        const guestEntryKey = `campaign:numbered-v1:leaderboard:${raceId}:entries`;
        const pbKey = `campaign:numbered-v1:pbs:${raceId}`;
        const guestPbField = createHash('sha256').update(guestPlayerId, 'utf8').digest('base64url');
        const redditPbField = createHash('sha256').update(redditPlayerId, 'utf8').digest('base64url');
        const updatedAt = '2026-07-27T10:00:00.000Z';
        hashes.set(guestEntryKey, new Map([[
            guestPlayerId,
            JSON.stringify({
                playerId: guestPlayerId,
                trackKey: 'numberOne',
                bestTimeMs: 9_000,
                updatedAt,
                completedLaps: 2,
                checkpointTimesSec: [4.5],
                validationMethod: 'strict-replay',
                strictReplayFailureReason: null,
            }),
        ]]));
        hashes.set(pbKey, new Map([[
            guestPbField,
            JSON.stringify({
                schemaVersion: 2,
                trackKey: 'numberOne',
                trackFingerprint: createTrackFingerprint(TRACKS.numberOne),
                simulationRevision: 1,
                rulesRevision: 1,
                lapCount: 2,
                bestTimeMs: 9_000,
                checkpointTimesSec: [4.5],
                lapCompletionTimesSec: [4.5, 9],
                ghost: null,
                updatedAt,
            }),
        ]]));
        const {
            cleanupGuestCampaignProgress,
            getServerCampaignBootstrap,
            mergeGuestCampaignProgress,
        } = await import('../src/server/campaign-store.ts');

        await expect(mergeGuestCampaignProgress({ guestPlayerId, redditPlayerId }))
            .resolves.toEqual({ merged: true, mergedRaceIds: [raceId] });
        await expect(getServerCampaignBootstrap({ redditUsername: 'Orphan-Standing' }))
            .resolves.toMatchObject({
                body: {
                    progress: {
                        resultsByRaceId: {
                            [raceId]: {
                                bestTimeMs: 9_000,
                                checkpointTimesSec: [4.5],
                            },
                        },
                    },
                },
            });
        expect(hashes.get(guestEntryKey)?.has(guestPlayerId)).toBe(true);
        expect(hashes.get(guestEntryKey)?.has(redditPlayerId)).toBe(true);
        expect(hashes.get(pbKey)?.has(guestPbField)).toBe(true);
        expect(hashes.get(pbKey)?.has(redditPbField)).toBe(true);

        await expect(cleanupGuestCampaignProgress({ guestPlayerId })).resolves.toBe(false);
        expect(hashes.get(guestEntryKey)?.has(guestPlayerId)).toBe(false);
        expect(hashes.get(pbKey)?.has(guestPbField)).toBe(false);
    });

    it('keeps guest data for a retry when an account promotion write fails', async () => {
        const guestPlayerId = 'guest:partial-merge';
        const redditPlayerId = 'reddit:partial-merge';
        const progressKeyFor = (playerId) => `campaign:numbered-v1:progress:${
            createHash('sha256').update(playerId, 'utf8').digest('base64url')
        }`;
        const result = {
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            lapCount: 2,
            rulesRevision: 1,
            bestTimeMs: 1_000,
            medal: 'author',
            checkpointTimesSec: null,
            updatedAt: '2026-07-27T10:00:00.000Z',
        };
        strings.set(progressKeyFor(guestPlayerId), JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: { 'numbered-v1-00': result },
            updatedAt: result.updatedAt,
        }));
        const guestEntryKey = 'campaign:numbered-v1:leaderboard:numbered-v1-00:entries';
        hashes.set(guestEntryKey, new Map([[
            guestPlayerId,
            JSON.stringify({
                ...result,
                playerId: guestPlayerId,
                completedLaps: 2,
                validationMethod: 'strict-replay',
            }),
        ]]));
        const { mergeGuestCampaignProgress } = await import('../src/server/campaign-store.ts');
        const defaultHSet = mockRedis.hSet.getMockImplementation();
        mockRedis.hSet.mockImplementation(async (key, entries) => {
            if (String(key) === guestEntryKey && Object.hasOwn(entries, redditPlayerId)) {
                throw new Error('account board unavailable');
            }
            return defaultHSet(key, entries);
        });

        await expect(mergeGuestCampaignProgress({ guestPlayerId, redditPlayerId }))
            .rejects.toThrow('account board unavailable');
        expect(strings.has(progressKeyFor(guestPlayerId))).toBe(true);
        expect(hashes.get(guestEntryKey)?.has(guestPlayerId)).toBe(true);

        mockRedis.hSet.mockImplementation(defaultHSet);
        await expect(mergeGuestCampaignProgress({ guestPlayerId, redditPlayerId }))
            .resolves.toEqual({ merged: true, mergedRaceIds: ['numbered-v1-00'] });
        expect(strings.has(progressKeyFor(guestPlayerId))).toBe(true);
    });

    it('repairs an account rank when a prior promotion copied its entry but missed the sorted-set write', async () => {
        const guestPlayerId = 'guest:rank-retry';
        const redditPlayerId = 'reddit:rank-retry';
        const raceId = 'numbered-v1-00';
        const entryKey = `campaign:numbered-v1:leaderboard:${raceId}:entries`;
        const progressKeyFor = (playerId) => `campaign:numbered-v1:progress:${
            createHash('sha256').update(playerId, 'utf8').digest('base64url')
        }`;
        const result = {
            raceId,
            trackKey: 'numberZero',
            lapCount: 2,
            rulesRevision: 1,
            bestTimeMs: 1_000,
            medal: 'author',
            checkpointTimesSec: null,
            updatedAt: '2026-07-27T10:00:00.000Z',
        };
        strings.set(progressKeyFor(guestPlayerId), JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: { [raceId]: result },
            updatedAt: result.updatedAt,
        }));
        hashes.set(entryKey, new Map([
            [guestPlayerId, JSON.stringify({
                ...result,
                playerId: guestPlayerId,
                completedLaps: 2,
                validationMethod: 'strict-replay',
                strictReplayFailureReason: null,
            })],
            [redditPlayerId, JSON.stringify({
                ...result,
                playerId: redditPlayerId,
                completedLaps: 2,
                validationMethod: 'strict-replay',
                strictReplayFailureReason: null,
            })],
        ]));
        const { mergeGuestCampaignProgress } = await import('../src/server/campaign-store.ts');

        await expect(mergeGuestCampaignProgress({ guestPlayerId, redditPlayerId }))
            .resolves.toEqual({ merged: false, mergedRaceIds: [] });

        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            `campaign:numbered-v1:leaderboard:${raceId}`,
            { member: redditPlayerId, score: result.bestTimeMs },
        );
        expect(hashes.get(entryKey)?.has(guestPlayerId)).toBe(true);
    });

    it('restores a missing Campaign rank from its retained strict entry during bootstrap', async () => {
        const playerId = 'reddit:rank-bootstrap';
        const raceId = 'numbered-v1-00';
        const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        strings.set(`campaign:numbered-v1:progress:${playerHash}`, JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: {
                [raceId]: {
                    raceId,
                    trackKey: 'numberZero',
                    lapCount: 2,
                    rulesRevision: 1,
                    bestTimeMs: 1_000,
                    medal: 'author',
                    checkpointTimesSec: null,
                    updatedAt: '2026-07-27T10:00:00.000Z',
                },
            },
            updatedAt: '2026-07-27T10:00:00.000Z',
        }));
        hashes.set(`campaign:numbered-v1:leaderboard:${raceId}:entries`, new Map([[
            playerId,
            JSON.stringify({
                playerId,
                trackKey: 'numberZero',
                bestTimeMs: 1_000,
                updatedAt: '2026-07-27T10:00:00.000Z',
                completedLaps: 2,
            }),
        ]]));
        const { getServerCampaignBootstrap } = await import('../src/server/campaign-store.ts');

        await getServerCampaignBootstrap({ redditUsername: 'Rank-Bootstrap' });

        expect(mockRedis.zAdd).toHaveBeenCalledWith(
            `campaign:numbered-v1:leaderboard:${raceId}`,
            { member: playerId, score: 1_000 },
        );
    });

    it('renews every Campaign merge lock while stage data is still being read', async () => {
        vi.useFakeTimers();
        try {
            const { mergeGuestCampaignProgress } = await import('../src/server/campaign-store.ts');
            const defaultHGet = mockRedis.hGet.getMockImplementation();
            let releaseStageRead;
            const stageReadBlocked = new Promise((resolve) => { releaseStageRead = resolve; });
            let stageReadStarted;
            const stageReadReached = new Promise((resolve) => { stageReadStarted = resolve; });
            let blocked = false;
            mockRedis.hGet.mockImplementation(async (...args) => {
                if (!blocked) {
                    blocked = true;
                    stageReadStarted();
                    await stageReadBlocked;
                }
                return defaultHGet(...args);
            });

            const merge = mergeGuestCampaignProgress({
                guestPlayerId: 'guest:renew-locks',
                redditPlayerId: 'reddit:renew-locks',
            });
            await stageReadReached;
            await vi.advanceTimersByTimeAsync(10_000);
            releaseStageRead();
            await merge;

            const renewedLockKeys = new Set(mockRedis.expire.mock.calls
                .map(([key]) => key)
                .filter((key) => String(key).includes(':submit-lock:')
                    || String(key).includes(':progress-lock:')));
            expect(renewedLockKeys.size).toBe(CAMPAIGN_STAGES.length * 2 + 2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops Campaign promotion before writes when any acquired lock is no longer owned', async () => {
        const guestPlayerId = 'guest:lost-merge-lock';
        const redditPlayerId = 'reddit:lost-merge-lock';
        const guestProgressKey = `campaign:numbered-v1:progress:${
            createHash('sha256').update(guestPlayerId, 'utf8').digest('base64url')
        }`;
        strings.set(guestProgressKey, JSON.stringify({
            campaignId: 'numbered-v1',
            startedAt: '2026-07-01T00:00:00.000Z',
            resultsByRaceId: {},
            updatedAt: '2026-07-01T00:00:00.000Z',
        }));
        const defaultGet = mockRedis.get.getMockImplementation();
        mockRedis.get.mockImplementation(async (key) => {
            if (String(key).includes(':submit-lock:') && String(key).includes(guestPlayerId)) {
                return 'successor-owner';
            }
            return defaultGet(key);
        });
        const { mergeGuestCampaignProgress } = await import('../src/server/campaign-store.ts');

        await expect(mergeGuestCampaignProgress({ guestPlayerId, redditPlayerId }))
            .rejects.toThrow('Campaign merge ownership was lost.');
        expect(strings.has(guestProgressKey)).toBe(true);
        expect(mockRedis.hSet).not.toHaveBeenCalledWith(
            expect.stringContaining('leaderboard'),
            expect.objectContaining({ [redditPlayerId]: expect.anything() }),
        );
    });

    it('refuses to trade a verified account time down for a slower guest one', async () => {
        const {
            getServerCampaignPbGhost,
            mergeGuestCampaignProgress,
            parseCampaignProgress,
        } = await import('../src/server/campaign-store.ts');
        const progressKeyFor = (playerId) => `campaign:numbered-v1:progress:${
            createHash('sha256').update(playerId, 'utf8').digest('base64url')
        }`;
        const stageResult = (bestTimeMs, medal) => ({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            lapCount: 2,
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
        const pbRecord = (bestTimeMs) => JSON.stringify({
            schemaVersion: 2,
            trackKey: 'numberZero',
            trackFingerprint: createTrackFingerprint(TRACKS.numberZero),
            simulationRevision: 1,
            rulesRevision: 1,
            lapCount: 2,
            bestTimeMs,
            checkpointTimesSec: null,
            lapCompletionTimesSec: null,
            ghost: null,
            updatedAt: '2026-07-27T10:00:00.000Z',
        });
        const pbKey = 'campaign:numbered-v1:pbs:numbered-v1-00';
        hashes.set(pbKey, new Map([
            [createHash('sha256').update('guest:slower', 'utf8').digest('base64url'), pbRecord(9000)],
            [createHash('sha256').update('reddit:faster', 'utf8').digest('base64url'), pbRecord(1000)],
        ]));

        await expect(mergeGuestCampaignProgress({
            guestPlayerId: 'guest:slower',
            redditPlayerId: 'reddit:faster',
        })).resolves.toEqual({ merged: false, mergedRaceIds: [] });

        const kept = parseCampaignProgress(strings.get(progressKeyFor('reddit:faster')));
        expect(kept.resultsByRaceId['numbered-v1-00']).toMatchObject({
            bestTimeMs: 1000,
            medal: 'author',
        });
        await expect(getServerCampaignPbGhost({
            raceId: 'numbered-v1-00',
            redditUsername: 'Faster',
        })).resolves.toMatchObject({
            status: 200,
            body: { personalBest: { bestTimeMs: 1000 } },
        });
    });

    it('strips releaseLock from Campaign non-200 replies', async () => {
        const competitionSubmit = await import('../src/server/competition-submit.ts');
        vi.spyOn(competitionSubmit, 'submitCompetitionRun').mockResolvedValueOnce({
            status: 422,
            body: { accepted: false, error: 'bad replay', reason: 'truncated_mismatch' },
            releaseLock: Promise.resolve(),
        });
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
        const result = await submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
            replay: { inputs: [] },
        });
        expect(result).toEqual({
            status: 422,
            body: { accepted: false, error: 'bad replay', reason: 'truncated_mismatch' },
        });
        expect(result).not.toHaveProperty('releaseLock');
    });

    it('awaits releaseLock when post-accept unlock work rejects', async () => {
        const competitionSubmit = await import('../src/server/competition-submit.ts');
        let releaseResolved = false;
        const releaseLock = Promise.resolve().then(() => {
            releaseResolved = true;
        });
        vi.spyOn(competitionSubmit, 'submitCompetitionRun').mockResolvedValueOnce({
            status: 200,
            body: {
                accepted: true,
                improved: true,
                bestTimeMs: 12_345,
                checkpointTimesSec: [4.2, 9.8],
            },
            releaseLock,
        });
        const carUnlockStore = await import('../src/server/car-unlock-store.ts');
        vi.spyOn(carUnlockStore, 'getCarUnlockSnapshot').mockRejectedValueOnce(new Error('unlock snapshot failed'));
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
        await expect(submitServerCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            playerId: 'browser-player-id',
            redditUsername: 'Pm-User',
            replay: { inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }] },
        })).rejects.toThrow('unlock snapshot failed');
        expect(releaseResolved).toBe(true);
    });
});
