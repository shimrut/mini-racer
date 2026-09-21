import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import { CAMPAIGN_ID, CAMPAIGN_STAGES } from '../game/campaign/manifest.js';
import { PB_GHOST_SAMPLE_INTERVAL_MS } from '../src/server/pb-ghost-trace.ts';

vi.mock('@devvit/redis', async () => {
    const COMPRESSION_PREFIX = '__gz:b64__:';
    const { gunzipSync } = await import('node:zlib');
    const { RedisTestDouble } = await import('./redis-test-double.js');
    function decodeCompressedValue(value) {
        return typeof value === 'string' && value.startsWith(COMPRESSION_PREFIX)
            ? gunzipSync(Buffer.from(value.slice(COMPRESSION_PREFIX.length), 'base64')).toString('utf8')
            : value;
    }
    const redis = new RedisTestDouble();
    redis.zRangeCalls = [];
    const rawHGet = redis.hGet.bind(redis);
    const rawHMGet = redis.hMGet.bind(redis);
    const rawZRange = redis.zRange.bind(redis);
    redis.hGet = async (key, field) => decodeCompressedValue(await rawHGet(key, field));
    redis.hMGet = async (key, fields) => (await rawHMGet(key, fields)).map(decodeCompressedValue);
    redis.zRange = async (key, start, stop, options) => {
        if (options?.by === 'score' && options?.reverse && Number(start) < Number(stop)) {
            throw new Error(`REV BYSCORE bounds inverted (${start} then ${stop})`);
        }
        redis.zRangeCalls.push({
            key,
            start,
            stop,
            offset: options?.limit?.offset ?? 0,
        });
        return rawZRange(key, start, stop, options);
    };
    return { redis, redisCompressed: redis };
});

import { redis } from '@devvit/redis';
import { toCampaignCompetition } from '../src/server/competition.ts';
import { createRedisPlayerProfileKey } from '../src/server/competition-identity.ts';
import { upsertPlayerTrackPersonalBest } from '../src/server/pb-ghost-store.ts';
import { prepareServerLeaderboardRace } from '../src/server/leaderboard-race-service.ts';
import { opponentRaceEngineMethods } from '../game/scoreboard/opponent-race-engine-methods.js';

const stage = CAMPAIGN_STAGES[0];
const competition = toCampaignCompetition(CAMPAIGN_ID, stage);
const track = TRACKS[stage.trackKey];
const PLAYER_ID = 'reddit:e2eracer';
const PLAYER_TIME_MS = 5000;
const RACEABLE_TIME_MS = 4000;
const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
const originalFetch = globalThis.fetch;

function checkpointTimes(bestTimeMs) {
    const count = track.checkpoints.length * stage.lapCount;
    return Array.from({ length: count }, (_, index) => (
        ((index + 1) * (bestTimeMs / 1000)) / (count + 1)
    ));
}

function ghostFor(timeMs) {
    const lastIntervalIndex = Math.ceil(timeMs / PB_GHOST_SAMPLE_INTERVAL_MS);
    return {
        schemaVersion: 2,
        sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
        finishTimeMs: timeMs,
        origin: [0, 0, 0],
        deltas: Array.from({ length: lastIntervalIndex * 3 }, () => 0),
    };
}

function scoreWindows() {
    return redis.zRangeCalls.filter((call) => call.key === competition.leaderboardKey);
}

async function seedProfile(playerId, redditUsername) {
    await redis.set(createRedisPlayerProfileKey(playerId), JSON.stringify({
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

async function seedRacer(playerId, bestTimeMs, { raceable = false, displayName = null } = {}) {
    await redis.hSet(competition.entryHashKey, {
        [playerId]: JSON.stringify({
            playerId,
            trackKey: stage.trackKey,
            bestTimeMs,
            updatedAt: '2026-07-27T10:00:00.000Z',
            completedLaps: stage.lapCount,
            medal: 'gold',
            checkpointTimesSec: checkpointTimes(bestTimeMs),
        }),
    });
    await redis.zAdd(competition.leaderboardKey, { member: playerId, score: bestTimeMs });
    await upsertPlayerTrackPersonalBest({
        playerId,
        competition,
        track,
        bestTimeMs,
        checkpointTimesSec: raceable ? checkpointTimes(bestTimeMs) : null,
        ghost: raceable ? ghostFor(bestTimeMs) : null,
    });
    if (displayName) await seedProfile(playerId, displayName);
}

function installServerBackedFetch() {
    globalThis.fetch = async (_url, init) => {
        const result = await prepareServerLeaderboardRace({
            ...JSON.parse(init.body),
            redditUsername: 'E2ERacer',
            requestRateLimitIdentity: 't2_e2e',
        });
        return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            json: async () => result.body,
        };
    };
}

function createFinishPanelEngine() {
    const primaryActions = [];
    const startedAgainst = [];
    const engine = {
        modal: {
            closeModal() {},
            setCombinedPrimaryAction(action) {
                primaryActions.push(action);
            },
        },
        startCampaignStage() {},
        async startCampaignStageAgainstOpponent(_race, target) {
            startedAgainst.push(target);
            return true;
        },
        ...opponentRaceEngineMethods,
    };
    return { engine, primaryActions, startedAgainst };
}

async function finishWonOpponentRace(engine, timeSec) {
    engine.configureLeaderboardOpponentFinish({
        mode: 'campaign',
        race: { raceId: stage.raceId },
        finalTime: timeSec,
        comparison: { target: { displayName: 'Prev' }, outcome: 'won' },
        waitForVerification: true,
    });
    await engine.resolveLeaderboardOpponentAdvanceAfterVerification({
        mode: 'campaign',
        competitionId: stage.raceId,
        benchmarkTimeMs: Math.round(timeSec * 1000),
    });
}

describe('next-rival finish-panel to Redis', () => {
    beforeEach(() => {
        redis.reset();
        redis.zRangeCalls.length = 0;
        infoSpy.mockClear();
        installServerBackedFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        infoSpy.mockClear();
    });

    it('pages closest-first until the first raceable rival, then the panel starts that ghost', async () => {
        await seedRacer(PLAYER_ID, PLAYER_TIME_MS);
        await seedRacer('reddit:behind', 6000);
        await seedRacer('reddit:faster-still', 3000);
        for (let i = 0; i < 22; i += 1) {
            await seedRacer(`reddit:ghostless-${i}`, 4999 - i);
        }
        await seedRacer('reddit:rival', RACEABLE_TIME_MS, { raceable: true, displayName: 'Rival' });

        const { engine, primaryActions, startedAgainst } = createFinishPanelEngine();
        await finishWonOpponentRace(engine, 5);

        const windows = scoreWindows();
        expect(windows).toHaveLength(3);
        expect(windows.map((call) => [call.start, call.stop, call.offset])).toEqual([
            [4999, 0, 0],
            [4999, 0, 10],
            [4999, 0, 20],
        ]);
        expect(primaryActions.at(-1)).toMatchObject({
            label: 'Next rival',
            ariaLabel: 'Next rival: #2 Rival',
        });

        await primaryActions.at(-1).action();
        expect(startedAgainst.at(-1)).toMatchObject({
            rank: 2,
            displayName: 'Rival',
            bestTimeMs: RACEABLE_TIME_MS,
            ghost: { finishTimeMs: RACEABLE_TIME_MS },
        });
    });

    it('keeps Improve after sixty unraceable racers ahead and logs the cap once', async () => {
        await seedRacer(PLAYER_ID, PLAYER_TIME_MS);
        for (let i = 0; i < 60; i += 1) {
            await seedRacer(`reddit:ghostless-${i}`, 4999 - i);
        }

        const { engine, primaryActions } = createFinishPanelEngine();
        await finishWonOpponentRace(engine, 5);

        const windows = scoreWindows();
        expect(windows).toHaveLength(6);
        expect(windows.at(-1)).toMatchObject({ start: 4999, stop: 0, offset: 50 });
        expect(primaryActions.at(-1)).toMatchObject({ label: 'Improve' });
        expect(infoSpy.mock.calls.some((call) => String(call[0]).includes('60-rival cap'))).toBe(true);
    });

    it('still races a rival picked from the standings by row', async () => {
        await seedRacer(PLAYER_ID, PLAYER_TIME_MS);
        await seedRacer('reddit:rival', RACEABLE_TIME_MS, { raceable: true, displayName: 'Rival' });

        const { engine, startedAgainst } = createFinishPanelEngine();
        const prepared = await engine.prepareNextLeaderboardOpponent({
            mode: 'campaign',
            competitionId: stage.raceId,
            benchmarkTimeMs: PLAYER_TIME_MS,
        });
        const started = await engine.prepareAndStartLeaderboardOpponent({
            mode: 'campaign',
            competitionId: stage.raceId,
            entry: {
                rank: prepared.target.rank,
                displayName: prepared.target.displayName,
                bestTimeMs: prepared.target.bestTimeMs,
                updatedAt: prepared.target.updatedAt,
            },
        });

        expect(started.ok).toBe(true);
        expect(startedAgainst.at(-1)).toMatchObject({
            displayName: 'Rival',
            bestTimeMs: RACEABLE_TIME_MS,
            ghost: { finishTimeMs: RACEABLE_TIME_MS },
        });
    });
});
