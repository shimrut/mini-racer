import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        },
    };
});

vi.mock('@devvit/redis', () => ({
    redisCompressed: redis,
}));

import {
    createPbGhostTraceRecorder,
    createTrackFingerprint,
    PB_GHOST_SAMPLE_RATE_HZ,
} from '../src/server/pb-ghost-trace.ts';
import {
    getPlayerTrackPbRecord,
    upsertPlayerTrackPersonalBest,
} from '../src/server/pb-ghost-store.ts';
import { DAILY_GP_PLAYER_PROFILE_TTL_SECONDS } from '../src/server/daily-gp-model.ts';

const TRACK = {
    outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    inner: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }],
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
    startPos: { x: 0, y: -1 },
    startAngle: 0,
    checkpoints: [],
};

const GHOST = {
    schemaVersion: 1,
    sampleRateHz: PB_GHOST_SAMPLE_RATE_HZ,
    samples: [
        [0, 0, -1000, 0],
        [1000, 1000, 0, 100],
    ],
};

describe('PB ghost trace and storage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redis.strings.clear();
        redis.hashes.clear();
        redis.expirations.clear();
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

        expect(trace.sampleRateHz).toBe(20);
        expect(trace.samples[0]).toEqual([0, 0, 0, 0]);
        expect(trace.samples.at(-1)).toEqual([1012, 9000, 8000, 750]);
        expect(trace.samples.length).toBe(22);
    });

    it('keeps only the strictly faster per-track record', async () => {
        const first = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            isGuest: false,
            trackKey: 'circuit',
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: [4, 8],
            ghost: GHOST,
        });
        const slower = await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            isGuest: false,
            trackKey: 'circuit',
            track: TRACK,
            bestTimeMs: 13_000,
            checkpointTimesSec: [5, 9],
            ghost: null,
        });

        expect(first.improved).toBe(true);
        expect(slower.improved).toBe(false);
        expect(slower.record.bestTimeMs).toBe(12_000);
        expect(slower.record.ghost).toEqual(GHOST);
        expect(redis.expire).not.toHaveBeenCalled();
    });

    it('applies rolling retention only to guest collections', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'guest:racer',
            isGuest: true,
            trackKey: 'circuit',
            track: TRACK,
            bestTimeMs: 12_000,
            checkpointTimesSec: null,
            ghost: GHOST,
        });

        expect(redis.expire).toHaveBeenCalledWith(
            expect.stringMatching(/^dailygp:track-pbs:/),
            DAILY_GP_PLAYER_PROFILE_TTL_SECONDS,
        );
    });

    it('deletes a stored PB when competitive track geometry changes', async () => {
        await upsertPlayerTrackPersonalBest({
            playerId: 'reddit:racer',
            isGuest: false,
            trackKey: 'circuit',
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
            trackKey: 'circuit',
            track: changedTrack,
        })).toBeNull();
        expect(redis.hDel).toHaveBeenCalledWith(
            expect.stringMatching(/^dailygp:track-pbs:/),
            ['circuit'],
        );
    });
});
