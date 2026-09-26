import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { toDailyCompetition } from '../src/server/competition/competition.ts';
import { decodeCompressedValue } from './helpers/redis-compressed-face.js';

const { redis } = vi.hoisted(() => {
    const strings = new Map();
    const hashes = new Map();
    const expirations = new Map();
    return {
        redis: {
            strings,
            hashes,
            expirations,
            get: vi.fn(async (key) => strings.get(key) ?? null),
            set: vi.fn(async (key, value, options = {}) => {
                if (options.nx && strings.has(key)) return '';
                strings.set(key, value);
                return 'OK';
            }),
            del: vi.fn(async (key) => {
                strings.delete(key);
                hashes.delete(key);
            }),
            hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
            hMGet: vi.fn(async (key, fields) => fields.map((field) => (
                hashes.get(key)?.get(field) ?? null
            ))),
            hSet: vi.fn(async (key, values) => {
                const hash = hashes.get(key) ?? new Map();
                hashes.set(key, hash);
                Object.entries(values).forEach(([field, value]) => hash.set(field, value));
                return 1;
            }),
            hDel: vi.fn(async (key, fields) => {
                const hash = hashes.get(key);
                fields.forEach((field) => hash?.delete(field));
                return 1;
            }),
            expire: vi.fn(async (key, seconds) => {
                expirations.set(key, seconds);
                return true;
            }),
            watch: vi.fn(async () => {
                const commands = [];
                return {
                    multi: vi.fn(async () => undefined),
                    unwatch: vi.fn(async () => undefined),
                    hSet: vi.fn(async (...args) => commands.push(() => redis.hSet(...args))),
                    expire: vi.fn(async (...args) => commands.push(() => redis.expire(...args))),
                    del: vi.fn(async (...args) => commands.push(() => redis.del(...args))),
                    exec: vi.fn(async () => {
                        const results = [];
                        for (const command of commands) results.push(await command());
                        return results;
                    }),
                };
            }),
        },
    };
});

vi.mock('@devvit/redis', async () => {
    const { asCompressedRedis } = await import('./helpers/redis-compressed-face.js');
    return { redisCompressed: asCompressedRedis(redis) };
});

import {
    createPbGhostTraceRecorder,
    createTrackFingerprint,
    getPbGhostTraceSampleCount,
    isValidPbGhostTrace,
    PB_GHOST_MAX_SAMPLES,
    PB_GHOST_SAMPLE_INTERVAL_MS,
    PB_GHOST_SIMULATION_REVISION,
} from '../src/server/competition/pb-ghost-trace.ts';
import {
    getPlayerTrackPbRecord,
    getPlayerTrackPbRecords,
    seedPlayerTrackPersonalBest,
    upsertPlayerTrackPersonalBest,
} from '../src/server/competition/pb-ghost-store.ts';
import { getDailyGpCompetitionTtlSeconds } from '../src/server/daily/daily-gp-model.ts';

const TRACK = {
    outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    inner: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }],
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
    startPos: { x: 0, y: -1 },
    startAngle: 0,
    checkpoints: [],
};

const CHALLENGE = {
    id: 'daily-gp-2030-01-01',
    challengeDate: '2030-01-01',
    trackKey: 'circuit',
    startsAt: '2030-01-01T00:00:00.000Z',
    endsAt: '2030-01-02T00:00:00.000Z',
    availableUntil: '2030-01-08T00:00:00.000Z',
    status: 'active',
    objectiveType: 'single_lap_fastest',
    objectiveParams: {},
    skin: 'default',
};

const GHOST = {
    schemaVersion: 2,
    sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
    finishTimeMs: 50,
    origin: [0, -100, 0],
    deltas: [100, 100, 100],
};

describe('PB ghost trace and storage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redis.strings.clear();
        redis.hashes.clear();
        redis.expirations.clear();
        redis.get.mockImplementation(async (key) => redis.strings.get(key) ?? null);
    });

    it('samples simulation time at 20 Hz and appends the exact final pose', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        for (let frame = 1; frame <= 60; frame += 1) {
            recorder.sample({
                timeSec: frame / 60,
                position: { x: frame / 10, y: frame / 20 },
                angle: frame / 100,
            });
        }
        const trace = recorder.finish({
            timeSec: 1.012,
            position: { x: 9, y: 8 },
            angle: 0.75,
        });

        expect(trace).toMatchObject({
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: 1012,
            origin: [0, 0, 0],
        });
        expect(getPbGhostTraceSampleCount(trace)).toBe(22);
        const final = trace.deltas.reduce((pose, value, index) => {
            pose[index % 3] += value;
            return pose;
        }, [...trace.origin]);
        expect(final).toEqual([900, 800, 750]);
    });

    it('cuts a representative 12-second trace to less than half the legacy JSON size', () => {
        const poseAt = (timeSec) => ({
            timeSec,
            position: {
                x: 50 + 30 * Math.cos(timeSec * 0.7),
                y: 40 + 25 * Math.sin(timeSec * 0.7),
            },
            angle: Math.atan2(
                17.5 * Math.cos(timeSec * 0.7),
                -21 * Math.sin(timeSec * 0.7),
            ),
        });
        const recorder = createPbGhostTraceRecorder(poseAt(0));
        for (let frame = 1; frame <= 12 * 60; frame += 1) {
            recorder.sample(poseAt(frame / 60));
        }
        const trace = recorder.finish(poseAt(12));
        const legacy = {
            schemaVersion: 1,
            sampleRateHz: 20,
            samples: Array.from({ length: 12 * 20 + 1 }, (_, index) => {
                const pose = poseAt(index / 20);
                return [
                    index * 50,
                    Math.round(pose.position.x * 1000),
                    Math.round(pose.position.y * 1000),
                    Math.round(pose.angle * 1000),
                ];
            }),
        };

        expect(Buffer.byteLength(JSON.stringify(trace), 'utf8'))
            .toBeLessThan(Buffer.byteLength(JSON.stringify(legacy), 'utf8') * 0.5);
    });

    it('uses the shortest angular delta across the wrap boundary', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 1, y: 1 },
            angle: 3.13,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 0.9, y: 0.8 },
            angle: -3.13,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 0.9, y: 0.8 },
            angle: -3.13,
        });

        expect(trace.origin).toEqual([100, 100, 3130]);
        expect(trace.deltas).toEqual([-10, -20, 23]);
    });

    it('validates negative deltas, timing, point limits and encoded size', () => {
        expect(isValidPbGhostTrace({
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: 50,
            origin: [100, 100, 100],
            deltas: [-10, -20, -30],
        })).toBe(true);
        expect(isValidPbGhostTrace({
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: 51,
            origin: [0, 0, 0],
            deltas: [0, 0, 0],
        })).toBe(false);
        expect(isValidPbGhostTrace({
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: 50,
            origin: [0, 0, 0],
            deltas: [0, 0],
        })).toBe(false);
        expect(isValidPbGhostTrace({
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: (PB_GHOST_MAX_SAMPLES - 1) * 50,
            origin: [0, 0, 0],
            deltas: Array((PB_GHOST_MAX_SAMPLES - 1) * 3).fill(0),
        })).toBe(true);
        expect(isValidPbGhostTrace({
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: PB_GHOST_MAX_SAMPLES * 50,
            origin: [0, 0, 0],
            deltas: Array(PB_GHOST_MAX_SAMPLES * 3).fill(0),
        })).toBe(false);
        expect(isValidPbGhostTrace({
            schemaVersion: 2,
            sampleIntervalMs: 50,
            finishTimeMs: (PB_GHOST_MAX_SAMPLES - 1) * 50,
            origin: [0, 0, 0],
            deltas: Array((PB_GHOST_MAX_SAMPLES - 1) * 3).fill(1_000_000_000),
        })).toBe(false);
    });

    it('keeps only the strictly faster per-track record', async () => {
        const first = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        });
        const slower = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 13_000,
            checkpointTimesSec: [5, 9],
            ghost: null,
        });

        expect(first.improved).toBe(true);
        expect(slower.improved).toBe(false);
        expect(slower.record.bestTimeMs).toBe(12_000);
        expect(slower.record.ghost).toEqual(GHOST);
        expect(redis.expire).toHaveBeenLastCalledWith(
            `dailygp:challenge-pbs:${CHALLENGE.id}`,
            getDailyGpCompetitionTtlSeconds(CHALLENGE),
        );
    });

    it('keeps a pre-slip revision-1 PB and ghost until current handling beats it', async () => {
        expect(PB_GHOST_SIMULATION_REVISION).toBe(1);
        const playerId = 'reddit:pre-slip-racer';
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const field = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        redis.hashes.set(collectionKey, new Map([[field, JSON.stringify({
            schemaVersion: 2,
            trackKey: CHALLENGE.trackKey,
            trackFingerprint: createTrackFingerprint(TRACK),
            simulationRevision: 1,
            rulesRevision: 0,
            lapCount: 1,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            lapCompletionTimesSec: null,
            ghost: GHOST,
            updatedAt: '2026-08-08T00:00:00.000Z',
        })]]));

        expect(await getPlayerTrackPbRecord({
            playerId,
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        })).toMatchObject({ bestTimeMs: 12_000, ghost: GHOST });

        const slower = await upsertPlayerTrackPersonalBest({
            playerId,
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_100,
            checkpointTimesSec: [4.1, 8.1],
            ghost: {
                ...GHOST,
                origin: [10, -100, 0],
            },
        });
        expect(slower).toMatchObject({
            improved: false,
            record: { bestTimeMs: 12_000, ghost: GHOST },
        });

        const replacementGhost = {
            ...GHOST,
            origin: [20, -100, 0],
        };
        const faster = await upsertPlayerTrackPersonalBest({
            playerId,
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 11_900,
            checkpointTimesSec: [3.9, 7.9],
            ghost: replacementGhost,
        });
        expect(faster).toMatchObject({
            improved: true,
            record: { bestTimeMs: 11_900, ghost: replacementGhost },
        });
    });

    it('selects a retained strict daily best and the current verified ghost under one lock', async () => {
        const retained = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:retained',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 13_000,
            checkpointTimesSec: [5, 9],
            ghost: GHOST,
            retainedPersonalBest: {
                bestTimeMs: 12_000,
                checkpointTimesSec: [4, 8],
                updatedAt: '2026-07-01T00:00:00.000Z',
            },
        });

        expect(retained.improved).toBe(false);
        expect(retained.record).toMatchObject({
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: null,
            updatedAt: '2026-07-01T00:00:00.000Z',
        });

        redis.strings.clear();
        redis.hashes.clear();
        const tied = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:tied',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4.1, 8.1],
            ghost: GHOST,
            retainedPersonalBest: {
                bestTimeMs: 12_000,
                checkpointTimesSec: [4, 8],
                updatedAt: '2026-07-01T00:00:00.000Z',
            },
        });

        expect(tied.improved).toBe(true);
        expect(tied.record).toMatchObject({
            bestTimeMs: 12_000,
            checkpointTimesSec: [4.1, 8.1],
            ghost: GHOST,
        });
    });

    it('enriches an equal time-only record with the current verified ghost', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:enriched',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: null,
        });

        const result = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:enriched',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4.1, 8.1],
            ghost: GHOST,
            retainedPersonalBest: {
                bestTimeMs: 13_000,
                checkpointTimesSec: [5, 9],
                updatedAt: '2026-07-01T00:00:00.000Z',
            },
        });

        expect(result.improved).toBe(true);
        expect(result.record).toMatchObject({
            bestTimeMs: 12_000,
            checkpointTimesSec: [4.1, 8.1],
            ghost: GHOST,
        });
    });

    it('does not write when a successor owns the PB lock before the transaction', async () => {
        redis.get.mockImplementation(async (key) => (
            String(key).startsWith('dailygp:challenge-pb-lock:')
                ? 'successor-token'
                : redis.strings.get(key) ?? null
        ));

        await expect(upsertPlayerTrackPersonalBest({
            playerId: 'reddit:stale-owner',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        })).rejects.toThrow('Personal best lock ownership was lost.');
        expect(redis.hSet).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
    });

    it('does not let lock cleanup errors replace a committed PB outcome', async () => {
        let lockReads = 0;
        redis.get.mockImplementation(async (key) => {
            if (String(key).startsWith('dailygp:challenge-pb-lock:')) {
                lockReads += 1;
                if (lockReads > 1) throw new Error('cleanup unavailable');
            }
            return redis.strings.get(key) ?? null;
        });

        await expect(upsertPlayerTrackPersonalBest({
            playerId: 'reddit:cleanup',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        })).resolves.toMatchObject({
            improved: true,
            record: { bestTimeMs: 12_000, ghost: GHOST },
        });
        expect(redis.hSet).toHaveBeenCalled();
    });

    it('applies the fixed competition deadline to every challenge PB collection', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'guest:racer',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        });

        expect(redis.expire).toHaveBeenCalledWith(
            `dailygp:challenge-pbs:${CHALLENGE.id}`,
            getDailyGpCompetitionTtlSeconds(CHALLENGE),
        );
    });

    it('isolates recurring tracks by challenge and never extends either fixed deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-02T00:00:00.000Z'));
        const laterChallenge = {
            ...CHALLENGE,
            id: 'daily-gp-2030-01-08',
            challengeDate: '2030-01-08',
            startsAt: '2030-01-08T00:00:00.000Z',
            endsAt: '2030-01-09T00:00:00.000Z',
            availableUntil: '2030-01-15T00:00:00.000Z',
        };

        try {
            await upsertPlayerTrackPersonalBest({
                playerId: 'reddit:recurring',
                competition: toDailyCompetition(CHALLENGE),
                track: TRACK,
                bestTimeMs: 12_000,
                checkpointTimesSec: null,
                ghost: GHOST,
            });
            await upsertPlayerTrackPersonalBest({
                playerId: 'reddit:recurring',
                competition: toDailyCompetition(laterChallenge),
                track: TRACK,
                bestTimeMs: 13_000,
                checkpointTimesSec: null,
                ghost: null,
            });

            expect([...redis.hashes.keys()]).toEqual(expect.arrayContaining([
                `dailygp:challenge-pbs:${CHALLENGE.id}`,
                `dailygp:challenge-pbs:${laterChallenge.id}`,
            ]));
            expect(redis.expirations.get(`dailygp:challenge-pbs:${CHALLENGE.id}`))
                .toBe(getDailyGpCompetitionTtlSeconds(CHALLENGE));
            expect(redis.expirations.get(`dailygp:challenge-pbs:${laterChallenge.id}`))
                .toBe(getDailyGpCompetitionTtlSeconds(laterChallenge));
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects PB writes after the challenge retention deadline', async () => {
        vi.useFakeTimers();
        // The archive keeps a day for 50 years.
        vi.setSystemTime(new Date('2079-12-20T00:00:00.001Z'));
        try {
            await expect(upsertPlayerTrackPersonalBest({
                playerId: 'reddit:late',
                competition: toDailyCompetition(CHALLENGE),
                track: TRACK,
                bestTimeMs: 12_000,
                checkpointTimesSec: null,
                ghost: GHOST,
            })).rejects.toThrow('retention deadline has passed');
            expect(redis.hSet).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores a stored PB when competitive track geometry changes', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        });
        const changedTrack = {
            ...TRACK,
            startPos: { x: 1, y: -1 },
        };
        vi.clearAllMocks();

        expect(createTrackFingerprint(changedTrack)).not.toBe(createTrackFingerprint(TRACK));
        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:racer',
            competition: toDailyCompetition(CHALLENGE),
            track: changedTrack,
        })).toBeNull();
        expect(redis.hDel).not.toHaveBeenCalled();
    });

    it('clears an incompatible record on the next write, which owns the PB lock', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        });
        const changedTrack = { ...TRACK, startPos: { x: 1, y: -1 } };
        vi.clearAllMocks();

        const result = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            competition: toDailyCompetition(CHALLENGE),
            track: changedTrack,
            bestTimeMs: 15_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        });

        expect(redis.hDel).toHaveBeenCalledWith(
            `dailygp:challenge-pbs:${CHALLENGE.id}`,
            [expect.any(String)],
        );
        expect(result.improved).toBe(true);
        expect(result.record.trackFingerprint).toBe(createTrackFingerprint(changedTrack));
    });

    it('leaves corrupt PB hash entries in place instead of returning them', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:corrupt',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        });
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const field = [...redis.hashes.get(collectionKey).keys()][0];
        redis.hashes.get(collectionKey).set(field, '{not-json');
        vi.clearAllMocks();

        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:corrupt',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        })).toBeNull();
        expect(redis.hDel).not.toHaveBeenCalled();
        expect(redis.hashes.get(collectionKey).get(field)).toBe('{not-json');
    });

    it('keeps a fresh PB written between a corrupt read and its cleanup', async () => {
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const field = createHash('sha256').update('reddit:racing-cleanup', 'utf8').digest('base64url');
        redis.hashes.set(collectionKey, new Map([[field, '{not-json']]));

        redis.hGet.mockImplementationOnce(async () => {
            const raw = '{not-json';
            await upsertPlayerTrackPersonalBest({
                playerId: 'reddit:racing-cleanup',
                competition: toDailyCompetition(CHALLENGE),
                track: TRACK,
                bestTimeMs: 11_000,
                checkpointTimesSec: [4, 8],
                ghost: GHOST,
            });
            return raw;
        });

        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:racing-cleanup',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        })).toBeNull();

        const survivor = await getPlayerTrackPbRecord({
            playerId: 'reddit:racing-cleanup',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        });
        expect(survivor?.bestTimeMs).toBe(11_000);
        expect(survivor?.ghost).not.toBeNull();
    });

    it('rejects PB writes when another update already owns the lock', async () => {
        const playerHash = createHash('sha256').update('reddit:busy', 'utf8').digest('base64url');
        redis.strings.set(`dailygp:challenge-pb-lock:${CHALLENGE.id}:${playerHash}`, 'held-by-other');

        await expect(upsertPlayerTrackPersonalBest({
            playerId: 'reddit:busy',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        })).rejects.toThrow('Personal best update already in progress.');
        expect(redis.hSet).not.toHaveBeenCalled();
    });

    it('fails closed when the PB transaction commits with no results', async () => {
        redis.watch.mockImplementationOnce(async () => ({
            multi: vi.fn(async () => undefined),
            unwatch: vi.fn(async () => undefined),
            hSet: vi.fn(async () => undefined),
            expire: vi.fn(async () => undefined),
            del: vi.fn(async () => undefined),
            exec: vi.fn(async () => []),
        }));

        await expect(upsertPlayerTrackPersonalBest({
            playerId: 'reddit:empty-exec',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        })).rejects.toThrow('Personal best lock ownership was lost.');
    });

    it('stores time-only PBs through the seed helper without a ghost trace', async () => {
        const result = await seedPlayerTrackPersonalBest({
            playerId: 'reddit:seed-only',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 11_500,
            checkpointTimesSec: [3.5, 7.5],
        });

        expect(result.improved).toBe(true);
        expect(result.record).toMatchObject({
            bestTimeMs: 11_500,
            checkpointTimesSec: [3.5, 7.5],
            lapCompletionTimesSec: null,
            ghost: null,
        });
    });

    it('reads compatible PB records in bounded hash batches without cleanup', async () => {
        const competition = toDailyCompetition(CHALLENGE);
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const playerIds = Array.from({ length: 11 }, (_, index) => `reddit:batch-${index}`);
        const validRecord = {
            schemaVersion: 2,
            trackKey: competition.trackKey,
            trackFingerprint: createTrackFingerprint(TRACK),
            simulationRevision: PB_GHOST_SIMULATION_REVISION,
            rulesRevision: 0,
            lapCount: 1,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            lapCompletionTimesSec: null,
            ghost: GHOST,
            updatedAt: '2030-01-01T00:00:00.000Z',
        };
        const incompatibleRecord = {
            ...validRecord,
            trackFingerprint: 'different-track',
        };
        redis.hashes.set(collectionKey, new Map([
            [createHash('sha256').update(playerIds[0], 'utf8').digest('base64url'), JSON.stringify(validRecord)],
            [createHash('sha256').update(playerIds[1], 'utf8').digest('base64url'), JSON.stringify(incompatibleRecord)],
        ]));
        redis.hMGet.mockClear();
        redis.hDel.mockClear();

        const records = await getPlayerTrackPbRecords({
            playerIds,
            competition,
            track: TRACK,
        });

        expect(redis.hMGet).toHaveBeenCalledTimes(2);
        expect(redis.hMGet.mock.calls.map(([, fields]) => fields.length)).toEqual([10, 1]);
        expect(records.get(playerIds[0])).toMatchObject({ bestTimeMs: 12_000, ghost: GHOST });
        expect(records.get(playerIds[1])).toBeNull();
        expect(records.get(playerIds[2])).toBeNull();
        expect(redis.hDel).not.toHaveBeenCalled();
    });

    it('stores exact lap boundaries while accepting historical and malformed records', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:lap-boundaries',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            lapCompletionTimesSec: [12],
            ghost: GHOST,
        });
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const field = [...redis.hashes.get(collectionKey).keys()][0];

        expect((await getPlayerTrackPbRecord({
            playerId: 'reddit:lap-boundaries',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        }))?.lapCompletionTimesSec).toEqual([12]);

        const payload = JSON.parse(decodeCompressedValue(redis.hashes.get(collectionKey).get(field)));
        delete payload.lapCompletionTimesSec;
        redis.hashes.get(collectionKey).set(field, JSON.stringify(payload));
        expect((await getPlayerTrackPbRecord({
            playerId: 'reddit:lap-boundaries',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        }))?.lapCompletionTimesSec).toBeNull();

        payload.lapCompletionTimesSec = [11.5];
        redis.hashes.get(collectionKey).set(field, JSON.stringify(payload));
        expect((await getPlayerTrackPbRecord({
            playerId: 'reddit:lap-boundaries',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        }))?.lapCompletionTimesSec).toBeNull();
    });

    it('drops non-finite checkpoint splits when parsing stored PB records', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:bad-checkpoints',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [1.2, 8],
            ghost: null,
        });
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const field = [...redis.hashes.get(collectionKey).keys()][0];
        const payload = JSON.parse(decodeCompressedValue(redis.hashes.get(collectionKey).get(field)));
        payload.checkpointTimesSec = [1.2, 'nope', 'still-bad'];

        redis.hashes.get(collectionKey).set(field, JSON.stringify(payload));

        const record = await getPlayerTrackPbRecord({
            playerId: 'reddit:bad-checkpoints',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        });

        expect(record?.checkpointTimesSec).toEqual([1.2]);
    });

    it('drops corrupt stored records with invalid schema fields', async () => {
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const field = createHash('sha256').update('reddit:invalid-schema', 'utf8').digest('base64url');
        redis.hashes.set(collectionKey, new Map([[field, JSON.stringify({
            schemaVersion: 1,
            trackKey: 'circuit',
            trackFingerprint: createTrackFingerprint(TRACK),
            simulationRevision: 1,
            bestTimeMs: 12_000,
            updatedAt: '2030-01-01T00:00:00.000Z',
            ghost: null,
        })]]));

        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:invalid-schema',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        })).toBeNull();
        expect(redis.hDel).not.toHaveBeenCalled();
        expect(redis.hashes.get(collectionKey).has(field)).toBe(true);
    });

    it('ignores stored PBs when the challenge track key no longer matches', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:track-key',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: null,
        });

        const mismatchedChallenge = { ...CHALLENGE, trackKey: 'harborParkLoop' };
        vi.clearAllMocks();
        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:track-key',
            competition: toDailyCompetition(mismatchedChallenge),
            track: TRACK,
        })).toBeNull();
        expect(redis.hDel).not.toHaveBeenCalled();
    });

    it('drops invalid ghost traces when reading stored PB records', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:bad-ghost',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_500,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        });
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const field = [...redis.hashes.get(collectionKey).keys()][0];
        const payload = JSON.parse(decodeCompressedValue(redis.hashes.get(collectionKey).get(field)));
        payload.ghost = {
            schemaVersion: 2,
            sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
            finishTimeMs: 0,
            origin: [0, 0, 0],
            deltas: [0, 0, 0],
        };
        redis.hashes.get(collectionKey).set(field, JSON.stringify(payload));

        const record = await getPlayerTrackPbRecord({
            playerId: 'reddit:bad-ghost',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        });

        expect(record?.ghost).toBeNull();
        expect(record?.bestTimeMs).toBe(12_500);
    });

    it('hashes player ids with utf-8 when writing challenge PB hash fields', async () => {
        const playerId = 'reddit:utf8-field';
        const expectedField = createHash('sha256').update(playerId, 'utf8').digest('base64url');
        await upsertPlayerTrackPersonalBest({
            playerId,
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: null,
        });
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        expect([...redis.hashes.get(collectionKey).keys()]).toContain(expectedField);
    });

    it('rejects stored records with empty track keys or invalid schema fields', async () => {
        const collectionKey = `dailygp:challenge-pbs:${CHALLENGE.id}`;
        const emptyKeyField = createHash('sha256').update('reddit:empty-key', 'utf8').digest('base64url');
        const badRevisionField = createHash('sha256').update('reddit:bad-revision', 'utf8').digest('base64url');
        const missingUpdatedAtField = createHash('sha256').update('reddit:no-updated-at', 'utf8').digest('base64url');
        redis.hashes.set(collectionKey, new Map([
            [emptyKeyField, JSON.stringify({
                schemaVersion: 2,
                trackKey: '',
                trackFingerprint: createTrackFingerprint(TRACK),
                simulationRevision: 1,
                bestTimeMs: 12_000,
                updatedAt: '2030-01-01T00:00:00.000Z',
                ghost: null,
            })],
            [badRevisionField, JSON.stringify({
                schemaVersion: 2,
                trackKey: 'circuit',
                trackFingerprint: createTrackFingerprint(TRACK),
                simulationRevision: 0,
                bestTimeMs: 12_000,
                updatedAt: '2030-01-01T00:00:00.000Z',
                ghost: null,
            })],
            [missingUpdatedAtField, JSON.stringify({
                schemaVersion: 2,
                trackKey: 'circuit',
                trackFingerprint: createTrackFingerprint(TRACK),
                simulationRevision: 1,
                bestTimeMs: 12_000,
                updatedAt: 42,
                ghost: null,
            })],
        ]));

        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:empty-key',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        })).toBeNull();
        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:bad-revision',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        })).toBeNull();
        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:no-updated-at',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
        })).toBeNull();
        expect(redis.hDel).not.toHaveBeenCalled();
    });

    it('returns the existing record without rewriting when it already wins the comparison', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:existing-winner',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        });
        vi.clearAllMocks();

        const result = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:existing-winner',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_500,
            checkpointTimesSec: [5, 9],
            ghost: null,
        });

        expect(result.improved).toBe(false);
        expect(result.record.bestTimeMs).toBe(12_000);
        expect(redis.hSet).not.toHaveBeenCalled();
    });

    it('logs challenge PB lock cleanup failures without replacing committed outcomes', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        let lockReads = 0;
        redis.get.mockImplementation(async (key) => {
            if (String(key).startsWith('dailygp:challenge-pb-lock:')) {
                lockReads += 1;
                if (lockReads > 1) throw new Error('release unavailable');
            }
            return redis.strings.get(key) ?? null;
        });

        await expect(upsertPlayerTrackPersonalBest({
            playerId: 'reddit:cleanup-log',
            competition: toDailyCompetition(CHALLENGE),
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        })).resolves.toMatchObject({
            improved: true,
            record: { bestTimeMs: 12_000, ghost: GHOST },
        });
        expect(consoleError).toHaveBeenCalledWith(
            'Challenge PB lock cleanup failed:',
            expect.any(Error),
        );
        consoleError.mockRestore();
    });
});
