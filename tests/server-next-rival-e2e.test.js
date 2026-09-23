import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TRACKS } from '../game/track/tracks.js';
import { CAMPAIGN_ID, CAMPAIGN_STAGES } from '../game/campaign/manifest.js';
import { PB_GHOST_SAMPLE_INTERVAL_MS } from '../src/server/competition/pb-ghost-trace.ts';

vi.mock('@devvit/redis', async () => {
    const { RedisTestDouble } = await import('./redis-test-double.js');
    const { asCompressedRedis } = await import('./helpers/redis-compressed-face.js');
    const redis = new RedisTestDouble();
    redis.zRangeCalls = [];
    const rawZRange = redis.zRange.bind(redis);
    redis.zRange = async (key, start, stop, options) => {
        if (options?.by === 'score' && Number(start) > Number(stop)) {
            throw new Error(`BYSCORE bounds inverted (${start} then ${stop}); Devvit answers nothing.`);
        }
        redis.zRangeCalls.push({
            key,
            start,
            stop,
            offset: options?.limit?.offset ?? 0,
        });
        return rawZRange(key, start, stop, options);
    };
    return { redis, redisCompressed: asCompressedRedis(redis) };
});

import { redis } from '@devvit/redis';
import { toCampaignCompetition, toDailyCompetition } from '../src/server/competition/competition.ts';
import { createRedisPlayerProfileKey } from '../src/server/competition/competition-identity.ts';
import { getPlayerTrackPbRecords, upsertPlayerTrackPersonalBest } from '../src/server/competition/pb-ghost-store.ts';
import { getServerDailyGpChallenge } from '../src/server/daily/daily-gp-store.ts';
import { prepareServerLeaderboardRace } from '../src/server/competition/leaderboard-race-service.ts';
import { opponentRaceEngineMethods } from '../game/scoreboard/opponent-race-engine-methods.js';
import { decodeCompressedValue } from './helpers/redis-compressed-face.js';

const stage = CAMPAIGN_STAGES[0];
const competition = toCampaignCompetition(CAMPAIGN_ID, stage);
const PLAYER_ID = 'reddit:e2eracer';
const PLAYER_TIME_MS = 5000;
const RACEABLE_TIME_MS = 4000;
const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
const originalFetch = globalThis.fetch;

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

async function seedRacerOn(target, playerId, bestTimeMs, { raceable = false, displayName = null } = {}) {
    const count = TRACKS[target.competition.trackKey].checkpoints.length * target.competition.lapCount;
    const times = Array.from({ length: count }, (_, index) => (
        ((index + 1) * (bestTimeMs / 1000)) / (count + 1)
    ));
    await redis.hSet(target.competition.entryHashKey, {
        [playerId]: JSON.stringify({
            playerId,
            trackKey: target.competition.trackKey,
            bestTimeMs,
            updatedAt: '2026-07-27T10:00:00.000Z',
            completedLaps: target.competition.lapCount,
            medal: 'gold',
            checkpointTimesSec: times,
        }),
    });
    await redis.zAdd(target.competition.leaderboardKey, { member: playerId, score: bestTimeMs });
    await upsertPlayerTrackPersonalBest({
        playerId,
        competition: target.competition,
        track: TRACKS[target.competition.trackKey],
        bestTimeMs,
        checkpointTimesSec: raceable ? times : null,
        ghost: raceable ? ghostFor(bestTimeMs) : null,
    });
    if (displayName) await seedProfile(playerId, displayName);
}

async function seedRacer(playerId, bestTimeMs, options = {}) {
    await seedRacerOn({ competition }, playerId, bestTimeMs, options);
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
        handleStartDailyChallenge() {},
        async startCampaignStageAgainstOpponent(_race, target) {
            startedAgainst.push(target);
            return true;
        },
        async startDailyChallengeAgainstOpponent(_race, target) {
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
            [0, 4999, 0],
            [0, 4999, 10],
            [0, 4999, 20],
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
        expect(windows.at(-1)).toMatchObject({ start: 0, stop: 4999, offset: 50 });
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

    it('runs the same walk on today\'s Daily board and starts Daily against the ghost', async () => {
        const challenge = await getServerDailyGpChallenge();
        const daily = { competition: toDailyCompetition(challenge) };
        await seedRacerOn(daily, PLAYER_ID, PLAYER_TIME_MS);
        for (let i = 0; i < 22; i += 1) {
            await seedRacerOn(daily, `reddit:daily-ghostless-${i}`, 4999 - i);
        }
        await seedRacerOn(daily, 'reddit:daily-rival', RACEABLE_TIME_MS, {
            raceable: true,
            displayName: 'DailyRival',
        });

        const { engine, primaryActions, startedAgainst } = createFinishPanelEngine();
        engine.configureLeaderboardOpponentFinish({
            mode: 'daily',
            race: challenge,
            finalTime: PLAYER_TIME_MS / 1000,
            comparison: { target: { displayName: 'Prev' }, outcome: 'won' },
            waitForVerification: true,
        });
        await engine.resolveLeaderboardOpponentAdvanceAfterVerification({
            mode: 'daily',
            competitionId: challenge.id,
            benchmarkTimeMs: PLAYER_TIME_MS,
        });

        const windows = redis.zRangeCalls.filter((call) => (
            call.key === daily.competition.leaderboardKey
        ));
        expect(windows.map((call) => [call.start, call.stop, call.offset])).toEqual([
            [0, 4999, 0],
            [0, 4999, 10],
            [0, 4999, 20],
        ]);
        expect(primaryActions.at(-1)).toMatchObject({
            label: 'Next rival',
            ariaLabel: 'Next rival: #1 DailyRival',
        });

        await primaryActions.at(-1).action();
        expect(startedAgainst.at(-1)).toMatchObject({
            mode: 'daily',
            competitionId: challenge.id,
            bestTimeMs: RACEABLE_TIME_MS,
            ghost: { finishTimeMs: RACEABLE_TIME_MS },
        });
    });

    it('stores a real PB as a compressed envelope that only the compressed face decodes', async () => {
        await seedRacer('reddit:rival', RACEABLE_TIME_MS, { raceable: true, displayName: 'Rival' });

        const records = await getPlayerTrackPbRecords({
            playerIds: ['reddit:rival'],
            competition,
            track: TRACKS[stage.trackKey],
        });
        expect(records.get('reddit:rival')).toMatchObject({
            bestTimeMs: RACEABLE_TIME_MS,
            ghost: { finishTimeMs: RACEABLE_TIME_MS },
        });

        const field = createHash('sha256').update('reddit:rival', 'utf8').digest('base64url');
        const stored = await redis.hGet(competition.pbHashKey, field);
        expect(stored.startsWith('__gz:b64__:')).toBe(true);
        expect(JSON.parse(decodeCompressedValue(stored))).toMatchObject({
            bestTimeMs: RACEABLE_TIME_MS,
        });
    });
});
