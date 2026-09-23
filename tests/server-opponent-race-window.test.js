import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TRACKS } from '../game/track/tracks.js';
import { CAMPAIGN_ID, CAMPAIGN_STAGES } from '../game/campaign/manifest.js';
import { createTrackFingerprint } from '../src/server/competition/pb-ghost-trace.ts';

const { mockRedis, hashes, strings, sortedSets } = vi.hoisted(() => {
    const hashes = new Map();
    const strings = new Map();
    const sortedSets = new Map();
    return {
        hashes,
        strings,
        sortedSets,
        mockRedis: {
            hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
            hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
            mGet: vi.fn(async (keys) => keys.map((key) => strings.get(key) ?? null)),
            zRange: vi.fn(async (key, start, stop, options) => {
                const ordered = [...(sortedSets.get(key)?.entries() || [])]
                    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1]));
                if (options?.by === 'score') {
                    const lo = Number(start);
                    const hi = Number(stop);
                    let rows = lo > hi
                        ? []
                        : ordered.filter(([, score]) => score >= lo && score <= hi);
                    if (options.reverse) rows = rows.slice().reverse();
                    const offset = options.limit?.offset ?? 0;
                    const count = options.limit?.count;
                    const sliced = Number.isInteger(count)
                        ? rows.slice(offset, offset + count)
                        : rows.slice(offset);
                    return sliced.map(([member, score]) => ({ member, score }));
                }
                return ordered.slice(start, stop + 1).map(([member, score]) => ({ member, score }));
            }),
            zRank: vi.fn(async (key, member) => {
                const ordered = [...(sortedSets.get(key)?.entries() || [])]
                    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1]));
                const index = ordered.findIndex(([candidate]) => candidate === member);
                return index >= 0 ? index : undefined;
            }),
        },
    };
});

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));

import { toCampaignCompetition } from '../src/server/competition/competition.ts';
import { createRedisPlayerProfileKey } from '../src/server/competition/competition-identity.ts';
import { prepareCompetitionOpponentRace } from '../src/server/competition/competition-opponent-race.ts';

const stage = CAMPAIGN_STAGES[0];
const competition = toCampaignCompetition(CAMPAIGN_ID, stage);
const playerId = 'reddit:player';
const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

function pbField(id) {
    return createHash('sha256').update(id, 'utf8').digest('base64url');
}

function checkpointTimes(bestTimeMs) {
    const count = TRACKS[stage.trackKey].checkpoints.length * stage.lapCount;
    return Array.from({ length: count }, (_, index) => (
        ((index + 1) * (bestTimeMs / 1000)) / (count + 1)
    ));
}

function seedEntry(id, bestTimeMs) {
    const entries = hashes.get(competition.entryHashKey) ?? new Map();
    entries.set(id, JSON.stringify({
        playerId: id,
        trackKey: stage.trackKey,
        bestTimeMs,
        updatedAt: '2026-07-27T10:00:00.000Z',
        completedLaps: stage.lapCount,
        checkpointTimesSec: checkpointTimes(bestTimeMs),
        validationMethod: 'strict-replay',
    }));
    hashes.set(competition.entryHashKey, entries);
    const board = sortedSets.get(competition.leaderboardKey) ?? new Map();
    board.set(id, bestTimeMs);
    sortedSets.set(competition.leaderboardKey, board);
}

function seedGhost(id, bestTimeMs) {
    const pbs = hashes.get(competition.pbHashKey) ?? new Map();
    pbs.set(pbField(id), JSON.stringify({
        schemaVersion: 2,
        trackKey: stage.trackKey,
        trackFingerprint: createTrackFingerprint(TRACKS[stage.trackKey]),
        simulationRevision: 1,
        rulesRevision: stage.rulesRevision,
        lapCount: stage.lapCount,
        bestTimeMs,
        checkpointTimesSec: checkpointTimes(bestTimeMs),
        updatedAt: '2026-07-27T10:00:00.000Z',
        ghost: {
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: bestTimeMs,
            origin: [0, 0, 0],
            deltas: [0, 0, 0, 0, 0, 0],
        },
    }));
    hashes.set(competition.pbHashKey, pbs);
}

function seedProfile(id, redditUsername) {
    strings.set(createRedisPlayerProfileKey(id), JSON.stringify({
        playerId: id,
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

function walkCommands() {
    return mockRedis.hGet.mock.calls.length
        + mockRedis.zRange.mock.calls.length
        + mockRedis.hMGet.mock.calls.length
        + mockRedis.mGet.mock.calls.length
        + mockRedis.zRank.mock.calls.length;
}

describe('next-faster opponent windows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hashes.clear();
        strings.clear();
        sortedSets.clear();
        infoSpy.mockClear();
    });

    afterEach(() => {
        infoSpy.mockClear();
    });

    it('returns the rival just ahead in six calls', async () => {
        const rivalId = 'reddit:ahead';
        seedEntry(playerId, 200);
        seedEntry(rivalId, 100);
        seedGhost(rivalId, 100);
        seedProfile(rivalId, 'Ahead');

        await expect(prepareCompetitionOpponentRace({
            competition,
            playerId,
            race: { raceId: stage.raceId },
            selection: { kind: 'next-faster', benchmarkTimeMs: 200 },
        })).resolves.toMatchObject({
            status: 200,
            body: {
                target: {
                    rank: 1,
                    displayName: 'Ahead',
                    bestTimeMs: 100,
                    ghost: { finishTimeMs: 100 },
                },
            },
        });
        expect(walkCommands()).toBe(6);
        expect(mockRedis.zRange).toHaveBeenCalledWith(
            competition.leaderboardKey,
            0,
            199,
            expect.objectContaining({
                by: 'score',
                reverse: true,
                limit: { offset: 0, count: 10 },
            }),
        );
        expect(infoSpy).not.toHaveBeenCalled();
    });

    it('chooses the stored best when the request reports a slower win', async () => {
        const passedId = 'reddit:already-passed';
        const trueRivalId = 'reddit:true-rival';
        seedEntry(playerId, 80);
        seedEntry(passedId, 120);
        seedGhost(passedId, 120);
        seedEntry(trueRivalId, 70);
        seedGhost(trueRivalId, 70);
        seedProfile(trueRivalId, 'TrueRival');

        await expect(prepareCompetitionOpponentRace({
            competition,
            playerId,
            race: { raceId: stage.raceId },
            selection: { kind: 'next-faster', benchmarkTimeMs: 150 },
        })).resolves.toMatchObject({
            status: 200,
            body: { target: { displayName: 'TrueRival', bestTimeMs: 70 } },
        });
    });

    it('skips a stored row whose entry time contradicts its score', async () => {
        const driftedId = 'reddit:drifted';
        const usableId = 'reddit:usable';
        seedEntry(playerId, 200);
        seedEntry(driftedId, 250);
        const board = sortedSets.get(competition.leaderboardKey);
        board.set(driftedId, 150);
        seedGhost(driftedId, 250);
        seedEntry(usableId, 100);
        seedGhost(usableId, 100);
        seedProfile(usableId, 'Usable');

        await expect(prepareCompetitionOpponentRace({
            competition,
            playerId,
            race: { raceId: stage.raceId },
            selection: { kind: 'next-faster', benchmarkTimeMs: 200 },
        })).resolves.toMatchObject({
            status: 200,
            body: { target: { displayName: 'Usable', bestTimeMs: 100 } },
        });
    });

    it('404s without incrementing when the last window is short', async () => {
        seedEntry(playerId, 10_000);
        for (let index = 0; index < 25; index += 1) {
            seedEntry(`reddit:ghostless-${index}`, 1000 + index);
        }

        await expect(prepareCompetitionOpponentRace({
            competition,
            playerId,
            race: { raceId: stage.raceId },
            selection: { kind: 'next-faster', benchmarkTimeMs: 10_000 },
        })).resolves.toMatchObject({
            status: 404,
            body: { reason: 'no_faster_opponent' },
        });
        expect(mockRedis.zRange).toHaveBeenCalledTimes(3);
        expect(infoSpy).not.toHaveBeenCalled();
    });

    it('404s and logs once when sixty ghostless rivals fill every window', async () => {
        seedEntry(playerId, 10_000);
        for (let index = 0; index < 60; index += 1) {
            seedEntry(`reddit:ghostless-${index}`, 1000 + index);
        }

        await expect(prepareCompetitionOpponentRace({
            competition,
            playerId,
            race: { raceId: stage.raceId },
            selection: { kind: 'next-faster', benchmarkTimeMs: 10_000 },
        })).resolves.toMatchObject({
            status: 404,
            body: { reason: 'no_faster_opponent' },
        });
        expect(mockRedis.zRange).toHaveBeenCalledTimes(6);
        expect(mockRedis.hMGet).toHaveBeenCalledTimes(12);
        expect(walkCommands()).toBe(19);
        expect(infoSpy).toHaveBeenCalledTimes(1);
        const line = String(infoSpy.mock.calls[0][0]);
        expect(line).toContain('60-rival cap');
        expect(line).not.toContain(playerId);
        expect(line).not.toMatch(/reddit:/);
    });
});
