import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { TRACKS } from '../game/track/tracks.js';
import { createTrackFingerprint } from '../src/server/competition/pb-ghost-trace.ts';

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

// Only Numbers is live from the app data. These tests need a second live
// series, as if the Creator had made it live.
vi.mock('../game/campaign/series-rules.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isAppCampaignSeriesLive: (series) => ['numbered-v1', 'test-v1'].includes(series?.id),
}));
vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));
vi.mock('../src/server/competition/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: mockValidateDailyGpReplayDetailed,
}));


// Two live series: the real Numbers series and a 10-stage test series.
const TEST_SERIES_TRACKS = [
    'circuit', 'sunlitTemple', 'albertGardens', 'kettleRun', 'twinRise',
    'templeStraight', 'speedAltar', 'mistfallCircuit', 'doubleTrouble', 'sharkBite',
];
vi.mock('../game/campaign/series.json', async () => {
    const { readFileSync } = await import('node:fs');
    const real = JSON.parse(readFileSync(new URL('../game/campaign/series.json', import.meta.url), 'utf8'));
    return {
        default: {
            series: [
                real.series.find((series) => series.id === 'numbered-v1'),
                {
                    id: 'test-v1',
                    name: 'Test',
                    ground: 'tarmac',
                    stages: TEST_SERIES_TRACKS.map((trackKey, index) => ({
                        trackKey,
                        laps: 1,
                        requiredMedals: index * 2,
                    })),
                },
            ],
        },
    };
});

function progressKeyFor(seriesId, playerId) {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `campaign:${seriesId}:progress:${playerHash}`;
}

function oneLapRun(bestTimeMs = 1000) {
    return {
        ok: true,
        run: {
            bestTimeSec: bestTimeMs / 1000,
            bestTimeMs,
            completedLaps: 1,
            checkpointTimesSec: [bestTimeMs / 2000],
            lapCompletionTimesSec: [bestTimeMs / 1000],
            ghost: {
                schemaVersion: 2,
                sampleIntervalMs: 50,
                finishTimeMs: 50,
                origin: [0, 0, 0],
                deltas: [1, 1, 1],
            },
            method: 'finish',
        },
    };
}

describe('Campaign with more than one live series', () => {
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


    it('keeps the stage IDs and series of each live series apart', async () => {
        const manifest = await import('../game/campaign/manifest.js');
        expect(manifest.CAMPAIGN_SERIES.map((series) => series.id)).toEqual(['numbered-v1', 'test-v1']);
        expect(manifest.getCampaignStage('test-v1-03')).toMatchObject({ seriesId: 'test-v1', trackKey: 'kettleRun' });
        expect(manifest.getCampaignStage('numbered-v1-03')).toMatchObject({ seriesId: 'numbered-v1' });
        expect(manifest.getCampaignUnlockedRaceIds({})).toEqual(['numbered-v1-00', 'test-v1-00']);
        // Medals of one series do not open stages of another series.
        const numbersMedals = Object.fromEntries(manifest.getCampaignSeriesStages(manifest.CAMPAIGN_NUMBERS_SERIES_ID).slice(0, 8).map((stage) => [
            stage.raceId,
            { medal: 'author' },
        ]));
        expect(manifest.getCampaignUnlockedRaceIds(numbersMedals)).toContain('numbered-v1-08');
        expect(manifest.getCampaignUnlockedRaceIds(numbersMedals).filter((id) => id.startsWith('test-v1')))
            .toEqual(['test-v1-00']);
        expect(manifest.isCampaignSeriesFinished('test-v1', { 'test-v1-09': { medal: 'bronze' } })).toBe(true);
    });

    it('returns the stages of the series that the bootstrap asks for, and a summary of all series', async () => {
        const { getServerCampaignBootstrap } = await import('../src/server/campaign/campaign-store.ts');
        const numbers = await getServerCampaignBootstrap({ redditUsername: 'RaceFan' });
        const test = await getServerCampaignBootstrap({ redditUsername: 'RaceFan', seriesId: 'test-v1' });

        expect(numbers.body.campaignId).toBe('numbered-v1');
        expect(numbers.body.stages[0].raceId).toBe('numbered-v1-00');
        expect(test.body.campaignId).toBe('test-v1');
        expect(test.body.stages.map((stage) => stage.raceId)).toHaveLength(10);
        expect(test.body.progress).toMatchObject({ campaignId: 'test-v1', unlockedRaceIds: ['test-v1-00'] });
        expect(test.body.series.map((series) => series.id)).toEqual(['numbered-v1', 'test-v1']);
        expect(Object.keys(test.body.standingsByRaceId)).toEqual(test.body.stages.map((stage) => stage.raceId));
    });

    it('saves a run in the record of its own series and opens the next stage there', async () => {
        mockValidateDailyGpReplayDetailed.mockReturnValue(oneLapRun(1000));
        const {
            getServerCampaignBootstrap,
            submitServerCampaignRun,
        } = await import('../src/server/campaign/campaign-store.ts');

        const result = await submitServerCampaignRun({
            raceId: 'test-v1-00',
            trackKey: 'circuit',
            replay: { inputs: [] },
            redditUsername: 'RaceFan',
        });

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
            accepted: true,
            progress: { campaignId: 'test-v1', unlockedRaceIds: ['test-v1-00', 'test-v1-01'] },
        });
        const playerId = 'reddit:racefan';
        expect(JSON.parse(strings.get(progressKeyFor('test-v1', playerId))).resultsByRaceId)
            .toHaveProperty('test-v1-00');
        expect(strings.has(progressKeyFor('numbered-v1', playerId))).toBe(false);
        expect([...hashes.keys()]).toContain('campaign:test-v1:leaderboard:test-v1-00:entries');

        const numbers = await getServerCampaignBootstrap({ redditUsername: 'RaceFan' });
        expect(numbers.body.progress.unlockedRaceIds).toEqual(['numbered-v1-00']);
        expect(numbers.body.series.find((series) => series.id === 'test-v1')).toMatchObject({
            medalCount: 4,
            finished: false,
        });
        // The author medal from the test series counts for the car skins.
        expect(numbers.body.carUnlocks.progress.campaignAuthor).toBe(1);
    });

    it('keeps a saved row on a stage the request does not know, and leaves it out of the answer', async () => {
        mockValidateDailyGpReplayDetailed.mockReturnValue(oneLapRun(1000));
        const playerId = 'reddit:racefan';
        // A stage published after this request took its list: the list has 00 to 09.
        const newerStageRow = {
            raceId: 'test-v1-10',
            trackKey: 'babylonRace',
            lapCount: 1,
            rulesRevision: 1,
            bestTimeMs: 2000,
            medal: 'gold',
            checkpointTimesSec: null,
            updatedAt: '2026-09-30T10:00:00.000Z',
        };
        strings.set(progressKeyFor('test-v1', playerId), JSON.stringify({
            campaignId: 'test-v1',
            startedAt: '2026-09-01T00:00:00.000Z',
            resultsByRaceId: {
                'test-v1-10': newerStageRow,
                // A known stage on old rules is dropped, as before.
                'test-v1-01': { ...newerStageRow, raceId: 'test-v1-01', trackKey: 'sunlitTemple', rulesRevision: 99 },
                // A row of another series whose name starts with this one.
                'test-v1-x-00': { ...newerStageRow, raceId: 'test-v1-x-00' },
            },
            updatedAt: '2026-09-30T10:00:00.000Z',
        }));
        const { submitServerCampaignRun } = await import('../src/server/campaign/campaign-store.ts');

        const result = await submitServerCampaignRun({
            raceId: 'test-v1-00',
            trackKey: 'circuit',
            replay: { inputs: [] },
            redditUsername: 'RaceFan',
        });

        expect(result.status).toBe(200);
        expect(Object.keys(result.body.progress.resultsByRaceId)).toEqual(['test-v1-00']);
        expect(result.body.progress.unlockedRaceIds).toEqual(['test-v1-00', 'test-v1-01']);
        const saved = JSON.parse(strings.get(progressKeyFor('test-v1', playerId))).resultsByRaceId;
        expect(saved['test-v1-10']).toEqual(newerStageRow);
        expect(saved).toHaveProperty('test-v1-00');
        expect(saved).not.toHaveProperty('test-v1-01');
        expect(saved).not.toHaveProperty('test-v1-x-00');
    });

    it('shows a board result during a transfer of the account, and writes no progress', async () => {
        const playerId = 'reddit:racefan';
        const { guestProgressSelectionAccountPendingKey } = await import('../src/server/player/guest-retirement.ts');
        strings.set(guestProgressSelectionAccountPendingKey(playerId), 'guest:transferring');
        hashes.set('campaign:test-v1:leaderboard:test-v1-00:entries', new Map([[playerId, JSON.stringify({
            playerId,
            displayName: 'RaceFan',
            bestTimeMs: 4000,
            trackKey: 'circuit',
            completedLaps: 1,
            validationMethod: 'strict-replay',
            updatedAt: '2026-09-30T10:00:00.000Z',
        })]]));
        const { getServerCampaignBootstrap } = await import('../src/server/campaign/campaign-store.ts');

        const result = await getServerCampaignBootstrap({ redditUsername: 'RaceFan', seriesId: 'test-v1' });

        expect(result.status).toBe(200);
        expect(result.body.progress.resultsByRaceId).toHaveProperty('test-v1-00');
        expect(strings.has(progressKeyFor('test-v1', playerId))).toBe(false);
    });

    it('refuses a stage whose series medals are not enough, whatever the other series holds', async () => {
        const playerId = 'reddit:racefan';
        strings.set(progressKeyFor('numbered-v1', playerId), JSON.stringify({
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
        const { startServerCampaignRace } = await import('../src/server/campaign/campaign-store.ts');
        expect((await startServerCampaignRace({ raceId: 'numbered-v1-01', redditUsername: 'RaceFan' })).status)
            .toBe(200);
        expect((await startServerCampaignRace({ raceId: 'test-v1-01', redditUsername: 'RaceFan' })).status)
            .toBe(403);
    });

    it('keeps a guest\'s other series alive when the guest plays one series', async () => {
        const { mintGuestPlayerToken } = await import('../src/server/player/player-token.ts');
        const { submitServerCampaignRun } = await import('../src/server/campaign/campaign-store.ts');
        mockValidateDailyGpReplayDetailed.mockReturnValue(oneLapRun(1000));
        const guestToken = await mintGuestPlayerToken('series-guest');
        const result = await submitServerCampaignRun({
            raceId: 'test-v1-00',
            trackKey: 'circuit',
            replay: { inputs: [] },
            playerId: 'series-guest',
            guestToken,
        });

        expect(result.status).toBe(200);
        expect(mockRedis.expire).toHaveBeenCalledWith(
            progressKeyFor('numbered-v1', 'guest:series-guest'),
            365 * 24 * 60 * 60,
        );
        expect(mockRedis.expire).not.toHaveBeenCalledWith(
            progressKeyFor('test-v1', 'guest:series-guest'),
            expect.anything(),
        );
    });

    it('accepts a Head to Head origin only when the stage belongs to its series', async () => {
        const { isCampaignStageOfSeries } = await import('../src/server/head-to-head/head-to-head-model.ts');
        expect(isCampaignStageOfSeries('test-v1', 'test-v1-03')).toBe(true);
        expect(isCampaignStageOfSeries('numbered-v1', 'numbered-v1-03')).toBe(true);
        expect(isCampaignStageOfSeries('numbered-v1', 'test-v1-03')).toBe(false);
        expect(isCampaignStageOfSeries('dirt-v1', 'test-v1-03')).toBe(false);
    });
});
