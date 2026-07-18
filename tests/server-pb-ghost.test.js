import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';

function decodeCompressedValue(value) {
    const prefix = '__gz:b64__:';
    return typeof value === 'string' && value.startsWith(prefix)
        ? gunzipSync(Buffer.from(value.slice(prefix.length), 'base64')).toString('utf8')
        : value;
}

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
            hGet: vi.fn(async (key, field) => decodeCompressedValue(hashes.get(key)?.get(field) ?? null)),
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

vi.mock('@devvit/redis', () => ({
    redisCompressed: redis,
}));

import {
    createPbGhostTraceRecorder,
    createTrackFingerprint,
    getPbGhostTraceSampleCount,
    isValidPbGhostTrace,
    PB_GHOST_MAX_SAMPLES,
    PB_GHOST_SAMPLE_INTERVAL_MS,
    PB_GHOST_SAMPLE_RATE_HZ,
} from '../src/server/pb-ghost-trace.ts';
import {
    getPlayerTrackPbRecord,
    upsertPlayerTrackPersonalBest,
} from '../src/server/pb-ghost-store.ts';
import { getDailyGpCompetitionTtlSeconds } from '../src/server/daily-gp-model.ts';

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
            challenge: CHALLENGE,
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        });
        const slower = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            challenge: CHALLENGE,
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

    it('selects a retained strict daily best and the current verified ghost under one lock', async () => {
        const retained = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:retained',
            challenge: CHALLENGE,
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
            challenge: CHALLENGE,
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
            challenge: CHALLENGE,
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: null,
        });

        const result = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:enriched',
            challenge: CHALLENGE,
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
            challenge: CHALLENGE,
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
            challenge: CHALLENGE,
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
            challenge: CHALLENGE,
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
                challenge: CHALLENGE,
                track: TRACK,
                bestTimeMs: 12_000,
                checkpointTimesSec: null,
                ghost: GHOST,
            });
            await upsertPlayerTrackPersonalBest({
                playerId: 'reddit:recurring',
                challenge: laterChallenge,
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
        vi.setSystemTime(new Date('2030-01-08T06:00:00.001Z'));
        try {
            await expect(upsertPlayerTrackPersonalBest({
                playerId: 'reddit:late',
                challenge: CHALLENGE,
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

    it('deletes a stored PB when competitive track geometry changes', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            challenge: CHALLENGE,
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        });
        const changedTrack = {
            ...TRACK,
            startPos: { x: 1, y: -1 },
        };

        expect(createTrackFingerprint(changedTrack)).not.toBe(createTrackFingerprint(TRACK));
        expect(await getPlayerTrackPbRecord({
            playerId: 'reddit:racer',
            challenge: CHALLENGE,
            track: changedTrack,
        })).toBeNull();
        expect(redis.hDel).toHaveBeenCalledWith(
            `dailygp:challenge-pbs:${CHALLENGE.id}`,
            [expect.any(String)],
        );
    });
});
