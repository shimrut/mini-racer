import { createHash } from 'node:crypto';
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
import { TRACKS } from '../game/track/tracks.js';

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

    it('keeps valid traces when recording at 1/60 sim steps (grid snap + count reconcile)', () => {
        const fixedDt = 1 / 60;
        for (let frames = 120; frames <= 1800; frames += 1) {
            const recorder = createPbGhostTraceRecorder({
                timeSec: 0,
                position: { x: 0, y: 0 },
                angle: 0,
            });
            let timeSec = 0;
            for (let frame = 1; frame <= frames; frame += 1) {
                timeSec += fixedDt;
                recorder.sample({
                    timeSec,
                    position: { x: frame * 0.1, y: frame * 0.05 },
                    angle: frame * 0.01,
                });
            }
            const trace = recorder.finish({
                timeSec,
                position: { x: frames * 0.1, y: frames * 0.05 },
                angle: frames * 0.01,
            });
            expect(trace, `frames=${frames}`).not.toBeNull();
            expect(isValidPbGhostTrace(trace), `frames=${frames}`).toBe(true);
            expect(trace.finishTimeMs).toBe(Math.round(timeSec * 1000));
        }
    });

    it('records a valid ghost for the prior 121-frame / ~2017ms failure case', () => {
        const fixedDt = 1 / 60;
        const frames = 121;
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        let timeSec = 0;
        for (let frame = 1; frame <= frames; frame += 1) {
            timeSec += fixedDt;
            recorder.sample({
                timeSec,
                position: { x: frame, y: 0 },
                angle: 0,
            });
        }
        const trace = recorder.finish({
            timeSec,
            position: { x: frames, y: 0 },
            angle: 0,
        });
        expect(Math.round(timeSec * 1000)).toBe(2017);
        expect(trace).not.toBeNull();
        expect(isValidPbGhostTrace(trace)).toBe(true);
        expect(trace.finishTimeMs).toBe(2017);
        expect(getPbGhostTraceSampleCount(trace)).toBe(
            Math.ceil(2017 / PB_GHOST_SAMPLE_INTERVAL_MS) + 1,
        );
    });

    function reconstructRegularSamples(trace) {
        const samples = [{
            timeMs: 0,
            xCm: trace.origin[0],
            yCm: trace.origin[1],
            angleMilli: trace.origin[2],
        }];
        let xCm = trace.origin[0];
        let yCm = trace.origin[1];
        let angleMilli = trace.origin[2];
        for (let offset = 0; offset < trace.deltas.length; offset += 3) {
            xCm += trace.deltas[offset];
            yCm += trace.deltas[offset + 1];
            angleMilli += trace.deltas[offset + 2];
            const index = 1 + offset / 3;
            const isFinish = index === trace.deltas.length / 3;
            samples.push({
                timeMs: isFinish ? trace.finishTimeMs : index * PB_GHOST_SAMPLE_INTERVAL_MS,
                xCm,
                yCm,
                angleMilli,
            });
        }
        return samples;
    }

    it('lerps late 60Hz poses back to the due 50ms grid instead of stamping the late frame', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.03333333333333333,
            position: { x: 1, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.06666666666666667,
            position: { x: 3, y: 0 },
            angle: 0,
        });
        const trace = recorder.finish({
            timeSec: 0.06666666666666667,
            position: { x: 3, y: 0 },
            angle: 0,
        });
        expect(trace).not.toBeNull();
        // At 50ms, between 33.3ms (x=1) and 66.7ms (x=3): (0.05 - 1/30) / (1/15) = 0.5 → x = 2.
        expect(trace.origin).toEqual([0, 0, 0]);
        expect(trace.deltas[0]).toBe(200);
        expect(trace.deltas[1]).toBe(0);
        expect(trace.deltas.slice(0, 3)).not.toEqual([300, 0, 0]);
    });

    it('uses the prior 60Hz pose for the first grid sample, not a lerp from t=0 across 50ms', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 1 / 60,
            position: { x: 0.1, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 2 / 60,
            position: { x: 0.3, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 3 / 60,
            position: { x: 0.6, y: 0 },
            angle: 0,
        });
        const trace = recorder.finish({
            timeSec: 3 / 60,
            position: { x: 0.6, y: 0 },
            angle: 0,
        });
        expect(trace).not.toBeNull();
        // 3/60 === 0.05 exactly → on-grid hit uses current pose x=0.6 → 60cm
        expect(trace.deltas[0]).toBe(60);
    });

    it('handles duplicate timestamps without NaN and still finishes a valid trace', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 0,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 0,
        });
        expect(trace).not.toBeNull();
        expect(isValidPbGhostTrace(trace)).toBe(true);
        expect(trace.deltas.every(Number.isSafeInteger)).toBe(true);
    });

    it('emits one lerped sample per crossed grid time on a multi-interval jump', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.15,
            position: { x: 3, y: 0 },
            angle: 0,
        });
        const trace = recorder.finish({
            timeSec: 0.15,
            position: { x: 3, y: 0 },
            angle: 0,
        });
        expect(trace).not.toBeNull();
        expect(getPbGhostTraceSampleCount(trace)).toBe(4);
        const samples = reconstructRegularSamples(trace);
        expect(samples[1]).toMatchObject({ timeMs: 50, xCm: 100 });
        expect(samples[2]).toMatchObject({ timeMs: 100, xCm: 200 });
        expect(samples[3]).toMatchObject({ timeMs: 150, xCm: 300 });
    });

    it('shortest-arc lerps angle across ±π when sampling onto the grid', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: Math.PI - 0.1,
        });
        recorder.sample({
            timeSec: 1 / 30,
            position: { x: 0, y: 0 },
            angle: Math.PI - 0.1,
        });
        recorder.sample({
            timeSec: 2 / 30,
            position: { x: 0, y: 0 },
            angle: -Math.PI + 0.1,
        });
        const trace = recorder.finish({
            timeSec: 2 / 30,
            position: { x: 0, y: 0 },
            angle: -Math.PI + 0.1,
        });
        expect(trace).not.toBeNull();
        // Mid-grid at 50ms is halfway on the short arc (+0.1 rad from start).
        const samples = reconstructRegularSamples(trace);
        const midAngle = samples[1].angleMilli / 1000;
        expect(midAngle).toBeCloseTo(Math.PI, 2);
        expect(Math.abs(trace.deltas[2])).toBeLessThan(500);
    });

    it('keeps straight-accel ghost lead under one centimetre through the former drift region', () => {
        const fixedDt = 1 / 60;
        const accel = 20;
        let timeSec = 0;
        let speed = 0;
        let x = 0;
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        const truth = [{ t: 0, x: 0 }];
        for (let frame = 1; frame <= 120; frame += 1) {
            speed += accel * fixedDt;
            x += speed * fixedDt;
            timeSec += fixedDt;
            recorder.sample({
                timeSec,
                position: { x, y: 0 },
                angle: 0,
            });
            truth.push({ t: timeSec, x });
        }
        const trace = recorder.finish({
            timeSec,
            position: { x, y: 0 },
            angle: 0,
        });
        expect(trace).not.toBeNull();
        const samples = reconstructRegularSamples(trace);
        const regular = samples.slice(0, -1);

        function truthXAt(t) {
            for (let i = 1; i < truth.length; i += 1) {
                if (truth[i].t + 1e-15 >= t) {
                    const before = truth[i - 1];
                    const after = truth[i];
                    const span = after.t - before.t || 1;
                    return before.x + (after.x - before.x) * ((t - before.t) / span);
                }
            }
            return truth.at(-1).x;
        }

        let maxLead = 0;
        for (const sample of regular) {
            const lead = Math.abs(sample.xCm / 100 - truthXAt(sample.timeMs / 1000));
            if (lead > maxLead) maxLead = lead;
        }
        expect(maxLead).toBeLessThanOrEqual(0.01);
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

    it('rejects invalid finish poses when fewer than two samples remain', () => {
        expect(createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        }).finish({
            timeSec: 0,
            position: { x: Number.NaN, y: 0 },
            angle: 0,
        })).toBeNull();
    });

    it('rejects unsafe integer overflow and uses shortest angular deltas', () => {
        expect(isValidPbGhostTrace(validTrace({
            origin: [Number.MAX_SAFE_INTEGER, 0, 0],
            deltas: [1, 0, 0],
            finishTimeMs: 50,
        }))).toBe(false);

        const halfTurnMilli = Math.round(Math.PI * 1000);
        const recorderWrap = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: halfTurnMilli / 1000,
        });
        recorderWrap.sample({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: -halfTurnMilli / 1000,
        });
        const wrapped = recorderWrap.finish({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: -halfTurnMilli / 1000,
        });
        expect(Math.abs(wrapped.deltas[2])).toBeLessThan(halfTurnMilli);
    });

    it('drops samples before the first interval and rejects negative timestamps', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: -0.5,
            position: { x: 5, y: 5 },
            angle: 1,
        });
        recorder.sample({
            timeSec: 0.02,
            position: { x: 1, y: 1 },
            angle: 0.1,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 2, y: 2 },
            angle: 0.2,
        });
        expect(trace).not.toBeNull();
        expect(getPbGhostTraceSampleCount(trace)).toBe(2);
        expect(trace.origin).toEqual([0, 0, 0]);
    });

    it('rejects traces whose reconstructed pose leaves safe integers', () => {
        expect(isValidPbGhostTrace(validTrace({
            origin: [0, 0, 0],
            deltas: [Number.MAX_SAFE_INTEGER, 0, 0, 1, 0, 0],
            finishTimeMs: 50,
        }))).toBe(false);
    });

    it('rejects traces with more than the maximum allowed samples', () => {
        const deltas = Array.from({ length: PB_GHOST_MAX_SAMPLES * 3 }, () => 0);
        const finishTimeMs = (PB_GHOST_MAX_SAMPLES - 1) * PB_GHOST_SAMPLE_INTERVAL_MS;
        expect(isValidPbGhostTrace(validTrace({
            finishTimeMs,
            deltas,
        }))).toBe(false);
    });

    it('ignores recorder samples with missing position components', () => {
        expect(createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: Number.NaN, y: 0 },
            angle: 0,
        }).finish({
            timeSec: 0.05,
            position: { x: 1, y: 1 },
            angle: 0.1,
        })).toBeNull();

        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: Number.NaN },
            angle: 0.1,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 2, y: 2 },
            angle: 0.2,
        });
        expect(trace).not.toBeNull();
        expect(getPbGhostTraceSampleCount(trace)).toBe(2);
    });

    it('accepts large valid traces that remain under the encoded-byte cap', () => {
        const deltas = Array.from({ length: 999 * 3 }, () => 0);
        const finishTimeMs = 999 * PB_GHOST_SAMPLE_INTERVAL_MS;
        const trace = validTrace({ finishTimeMs, deltas });
        expect(Buffer.byteLength(JSON.stringify(trace), 'utf8'))
            .toBeLessThanOrEqual(PB_GHOST_MAX_ENCODED_BYTES);
        expect(isValidPbGhostTrace(trace)).toBe(true);
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

    it('keeps published Daily geometry fingerprints stable for PB continuity', () => {
        expect(createTrackFingerprint(TRACKS.pretzelArena))
            .toBe('y3lf9P0rGLuJ4-Lj3_TJvTTvW2sjdIGqj4PMyQjhV_8');
        expect(createTrackFingerprint(TRACKS.cobaltRun))
            .toBe('rJDsRof10WuAqb4gIPB5cKn0hSlKeb9dqMWqmLoJOSg');
    });

    it('rejects quantized poses with null position or missing coordinates', () => {
        expect(createPbGhostTraceRecorder({
            timeSec: 0,
            position: null,
            angle: 0,
        }).finish({
            timeSec: 0.05,
            position: { x: 1, y: 1 },
            angle: 0.1,
        })).toBeNull();

        expect(createPbGhostTraceRecorder({
            timeSec: 0,
            position: { y: 0 },
            angle: 0,
        }).finish({
            timeSec: 0.05,
            position: { x: 1, y: 1 },
            angle: 0.1,
        })).toBeNull();
    });

    it('accepts encoded traces up to the byte cap and rejects ones above it', () => {
        const compactTrace = validTrace({
            finishTimeMs: 999 * PB_GHOST_SAMPLE_INTERVAL_MS,
            deltas: Array.from({ length: 999 * 3 }, () => 0),
        });
        expect(Buffer.byteLength(JSON.stringify(compactTrace), 'utf8'))
            .toBeLessThanOrEqual(PB_GHOST_MAX_ENCODED_BYTES);
        expect(isValidPbGhostTrace(compactTrace)).toBe(true);

        const oversizedTrace = validTrace({
            finishTimeMs: (PB_GHOST_MAX_SAMPLES - 1) * PB_GHOST_SAMPLE_INTERVAL_MS,
            deltas: Array.from(
                { length: (PB_GHOST_MAX_SAMPLES - 1) * 3 },
                () => Number.MAX_SAFE_INTEGER,
            ),
        });
        expect(Buffer.byteLength(JSON.stringify(oversizedTrace), 'utf8'))
            .toBeGreaterThan(PB_GHOST_MAX_ENCODED_BYTES);
        expect(isValidPbGhostTrace(oversizedTrace)).toBe(false);
    });

    it('keeps a half-turn angular delta unwrapped at the inclusive boundary', () => {
        const halfTurnMilli = Math.round(Math.PI * 1000);
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: halfTurnMilli / 1000,
        });
        const trace = recorder.finish({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: halfTurnMilli / 1000,
        });
        expect(trace.deltas[2]).toBe(halfTurnMilli);
    });

    it('requires every origin and delta component to be a safe integer', () => {
        expect(isValidPbGhostTrace(validTrace({
            origin: [0, 1, Number.MAX_SAFE_INTEGER + 1],
            deltas: [0, 0, 0],
        }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({
            origin: [0, 0, 0],
            deltas: [0, 0, 0, 1, 2, Number.MAX_SAFE_INTEGER + 1],
            finishTimeMs: 100,
        }))).toBe(false);
    });

    it('reconstructs multi-step pose deltas additively during validation', () => {
        const trace = validTrace({
            origin: [0, 0, 0],
            deltas: [10, 20, 100, 5, 5, -50],
            finishTimeMs: 100,
        });
        expect(isValidPbGhostTrace(trace)).toBe(true);

        let xCm = trace.origin[0];
        let yCm = trace.origin[1];
        let angleMilli = trace.origin[2];
        for (let index = 0; index < trace.deltas.length; index += 3) {
            xCm += trace.deltas[index];
            yCm += trace.deltas[index + 1];
            angleMilli += trace.deltas[index + 2];
        }
        expect([xCm, yCm, angleMilli]).toEqual([15, 25, 50]);
    });

    it('replaces exact finish poses that share a timestamp and skips identical duplicates', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        recorder.sample({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 0,
        });
        const replaced = recorder.finish({
            timeSec: 0.05,
            position: { x: 2, y: 0 },
            angle: 0.1,
        });
        expect(getPbGhostTraceSampleCount(replaced)).toBe(2);
        expect(replaced.deltas).toEqual([200, 0, 100]);

        const duplicate = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        duplicate.sample({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 0,
        });
        const unchanged = duplicate.finish({
            timeSec: 0.05,
            position: { x: 1, y: 0 },
            angle: 0,
        });
        expect(getPbGhostTraceSampleCount(unchanged)).toBe(2);
        expect(unchanged.deltas).toEqual([100, 0, 0]);
    });

    it('overflows when the recorder reaches the maximum sample count', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        for (let index = 1; index < PB_GHOST_MAX_SAMPLES; index += 1) {
            recorder.sample({
                timeSec: index * 0.05,
                position: { x: index, y: 0 },
                angle: 0,
            });
        }
        recorder.sample({
            timeSec: PB_GHOST_MAX_SAMPLES * 0.05,
            position: { x: 99, y: 0 },
            angle: 0,
        });
        expect(recorder.finish({
            timeSec: PB_GHOST_MAX_SAMPLES * 0.05,
            position: { x: 99, y: 0 },
            angle: 0,
        })).toBeNull();
    });

    it('returns null from finish when overflowed, origin is missing, or only one pose remains', () => {
        const overflowed = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        for (let index = 1; index <= PB_GHOST_MAX_SAMPLES; index += 1) {
            overflowed.sample({
                timeSec: index * 0.05,
                position: { x: index, y: 0 },
                angle: 0,
            });
        }
        expect(overflowed.finish({
            timeSec: (PB_GHOST_MAX_SAMPLES + 1) * 0.05,
            position: { x: 99, y: 0 },
            angle: 0,
        })).toBeNull();

        expect(createPbGhostTraceRecorder({
            timeSec: Number.NaN,
            position: { x: 0, y: 0 },
            angle: 0,
        }).finish({
            timeSec: 0.05,
            position: { x: 1, y: 1 },
            angle: 0.1,
        })).toBeNull();
    });

    it('hashes track fingerprints with utf-8 encoded stable geometry', () => {
        const track = {
            outer: [{ x: 0, y: 0 }],
            inner: [{ x: 1, y: 1 }],
            startLine: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
            startPos: { x: 0, y: -1 },
            startAngle: 0,
            checkpoints: [{ x: 2, y: 2 }],
        };
        const stable = {
            outer: track.outer,
            inner: track.inner,
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle,
            checkpoints: track.checkpoints,
        };
        const expected = createHash('sha256')
            .update(JSON.stringify(stable), 'utf8')
            .digest('base64url');
        expect(createTrackFingerprint(track)).toBe(expected);
    });

    it('returns null from finish when recorder overflow discarded intermediate samples (L160)', () => {
        const recorder = createPbGhostTraceRecorder({
            timeSec: 0,
            position: { x: 0, y: 0 },
            angle: 0,
        });
        for (let index = 1; index <= PB_GHOST_MAX_SAMPLES + 1; index += 1) {
            recorder.sample({
                timeSec: index * 0.05,
                position: { x: index, y: index },
                angle: index * 0.01,
            });
        }

        expect(recorder.finish({
            timeSec: (PB_GHOST_MAX_SAMPLES + 2) * 0.05,
            position: { x: 99, y: 99 },
            angle: 1,
        })).toBeNull();
    });
});
