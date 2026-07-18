import { describe, expect, it } from 'vitest';
import {
    PB_GHOST_MAX_ENCODED_BYTES,
    PB_GHOST_MAX_SAMPLES,
    PB_GHOST_SAMPLE_INTERVAL_MS,
    PB_GHOST_SCHEMA_VERSION,
    createPbGhostTraceRecorder,
    createTrackFingerprint,
    getPbGhostTraceSampleCount,
    isValidPbGhostTrace,
} from '../src/server/pb-ghost-trace.ts';

function validTrace(overrides = {}) {
    return {
        schemaVersion: PB_GHOST_SCHEMA_VERSION,
        sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [1, 2, 3],
        ...overrides,
    };
}

describe('pb-ghost-trace validation and recording edges', () => {
    it('rejects non-objects and incomplete schema fields', () => {
        expect(isValidPbGhostTrace(null)).toBe(false);
        expect(isValidPbGhostTrace(undefined)).toBe(false);
        expect(isValidPbGhostTrace('trace')).toBe(false);
        expect(isValidPbGhostTrace(12)).toBe(false);
        expect(isValidPbGhostTrace({})).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ schemaVersion: 1 }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ sampleIntervalMs: 49 }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: 0 }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: -1 }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: 50.5 }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: Number.NaN }))).toBe(false);
    });

    it('rejects malformed origin and delta arrays', () => {
        expect(isValidPbGhostTrace(validTrace({ origin: [0, 0] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ origin: [0, 0, 0, 0] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ origin: [0, 0, 0.5] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ origin: 'nope' }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ deltas: [] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ deltas: [1, 2] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ deltas: [1, 2, 3, 4] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ deltas: [1, 2, 3.5] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ deltas: 'nope' }))).toBe(false);
    });

    it('enforces finish-time window between penultimate and next regular sample', () => {
        // 2 samples => penultimate 0, next regular 50. finish must be > 0 and <= 50
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: 1, deltas: [0, 0, 0] }))).toBe(true);
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: 0, deltas: [0, 0, 0] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: 50, deltas: [0, 0, 0] }))).toBe(true);
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: 51, deltas: [0, 0, 0] }))).toBe(false);

        // 3 samples => penultimate 50, next regular 100
        expect(isValidPbGhostTrace(validTrace({
            finishTimeMs: 50,
            deltas: [0, 0, 0, 0, 0, 0],
        }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({
            finishTimeMs: 51,
            deltas: [0, 0, 0, 0, 0, 0],
        }))).toBe(true);
        expect(isValidPbGhostTrace(validTrace({
            finishTimeMs: 100,
            deltas: [0, 0, 0, 0, 0, 0],
        }))).toBe(true);
        expect(isValidPbGhostTrace(validTrace({
            finishTimeMs: 101,
            deltas: [0, 0, 0, 0, 0, 0],
        }))).toBe(false);
    });

    it('reports sample counts only for well-formed delta lengths', () => {
        expect(getPbGhostTraceSampleCount(null)).toBe(0);
        expect(getPbGhostTraceSampleCount({})).toBe(0);
        expect(getPbGhostTraceSampleCount({ deltas: [1, 2] })).toBe(0);
        expect(getPbGhostTraceSampleCount({ deltas: [1, 2, 3] })).toBe(2);
        expect(getPbGhostTraceSampleCount({ deltas: [1, 2, 3, 4, 5, 6] })).toBe(3);
    });

    it('rejects oversized encoded traces even when schema looks valid', () => {
        const fatDeltas = Array.from(
            { length: (PB_GHOST_MAX_SAMPLES - 1) * 3 },
            () => Number.MAX_SAFE_INTEGER,
        );
        const fatFinish = (PB_GHOST_MAX_SAMPLES - 1) * PB_GHOST_SAMPLE_INTERVAL_MS;
        const fatTrace = validTrace({
            finishTimeMs: fatFinish,
            deltas: fatDeltas,
        });
        expect(Buffer.byteLength(JSON.stringify(fatTrace), 'utf8'))
            .toBeGreaterThan(PB_GHOST_MAX_ENCODED_BYTES);
        expect(isValidPbGhostTrace(fatTrace)).toBe(false);
    });

    it('ignores duplicate samples, early samples, and invalid poses while recording', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 1, y: 2 },
            angle: 0.5,
        });
        recorder.sample({
            timeSec: 0.01,
            position: { x: 1, y: 2 },
            angle: 0.5,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: 2 },
            angle: 0.5,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: Number.NaN, y: 2 },
            angle: 0.5,
        });
        recorder.sample({
            timeSec: -1,
            position: { x: 3, y: 4 },
            angle: 1,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 2, y: 3 },
            angle: 1,
        });
        expect(trace).not.toBeNull();
        expect(getPbGhostTraceSampleCount(trace)).toBe(2);
        expect(trace.origin).toEqual([100, 200, 500]);
        expect(trace.deltas).toEqual([100, 100, 500]);
    });

    it('returns null when finish cannot produce at least two distinct samples', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        expect(recorder.finish({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        })).toBeNull();
    });

    it('rejects invalid initial poses and drops recorder overflow past max samples', () => {
        expect(createPbGhostTraceRecorder({
            timeSec: Number.NaN,
            position: { x: 0, y: 0 },
            angle: 0,
        }).finish({
            timeSec: 0.05,
            position: { x: 1, y: 1 },
            angle: 0,
        })).toBeNull();

        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        for (let index = 1; index <= PB_GHOST_MAX_SAMPLES + 5; index += 1) {
            recorder.sample({
                timeSec: index * 0.05,
                position: { x: index, y: index },
                angle: index * 0.01,
            });
        }
        expect(recorder.finish({
            timeSec: (PB_GHOST_MAX_SAMPLES + 6) * 0.05,
            position: { x: 99, y: 99 },
            angle: 1,
        })).toBeNull();
    });

    it('replaces an exact finish pose that shares the previous sample timestamp', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: 1 },
            angle: 0.1,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 2, y: 3 },
            angle: 0.2,
        });
        expect(trace).not.toBeNull();
        expect(getPbGhostTraceSampleCount(trace)).toBe(2);
        expect(trace.origin).toEqual([0, 0, 0]);
        expect(trace.deltas).toEqual([200, 300, 200]);
    });

    it('wraps large negative angular deltas through the shortest path', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: -3.13,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 3.13,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 3.13,
        });
        expect(trace.deltas[2]).toBeLessThan(0);
        expect(Math.abs(trace.deltas[2])).toBeLessThan(Math.PI * 1000);
    });

    it('hashes only the stable track shape fields', () => {
        const base = {
            outer: [{ x: 0, y: 0 }],
            inner: [{ x: 1, y: 1 }],
            startLine: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
            startPos: { x: 0, y: -1 },
            startAngle: 0,
            checkpoints: [{ x: 2, y: 2 }],
            deco: 'ignored',
        };
        const other = { ...base, deco: 'changed', author: 'x' };
        expect(createTrackFingerprint(base)).toBe(createTrackFingerprint(other));
        expect(createTrackFingerprint({
            ...base,
            startAngle: 1,
        })).not.toBe(createTrackFingerprint(base));
    });
});
