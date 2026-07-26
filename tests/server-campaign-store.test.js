import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
    hSet: vi.fn(async (key, entries) => {
        const hash = hashes.get(key) ?? new Map();
        for (const [field, value] of Object.entries(entries)) hash.set(field, value);
        hashes.set(key, hash);
        return Object.keys(entries).length;
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

function createTransaction() {
    const commands = [];
    return {
        multi: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {}),
        del: vi.fn(async (...args) => commands.push(() => mockRedis.del(...args))),
        set: vi.fn(async (...args) => commands.push(() => mockRedis.set(...args))),
        hSet: vi.fn(async (...args) => commands.push(() => mockRedis.hSet(...args))),
        zAdd: vi.fn(async (...args) => commands.push(() => mockRedis.zAdd(...args))),
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
        mockRedis.hMGet.mockImplementation(async (key, fields) => (
            fields.map((field) => hashes.get(key)?.get(field) ?? null)
        ));
        mockRedis.hSet.mockImplementation(async (key, entries) => {
            const hash = hashes.get(key) ?? new Map();
            for (const [field, value] of Object.entries(entries)) hash.set(field, value);
            hashes.set(key, hash);
            return Object.keys(entries).length;
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

    it('keeps guests practice-only and performs no Campaign write', async () => {
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
        const { submitServerCampaignRun } = await import('../src/server/campaign-store.ts');
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
                result: {
                    bestTimeMs: 1000,
                    medal: 'author',
                },
                progress: {
                    unlockedRaceIds: ['numbered-v1-00', 'numbered-v1-01'],
                },
                ghostPersistenceStatus: 'stored',
            },
        });
        expect(mockValidateDailyGpReplayDetailed).toHaveBeenCalledWith({
            challenge: expect.objectContaining({
                id: 'numbered-v1-00',
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
                ghostPersistenceStatus: 'unavailable',
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
});
