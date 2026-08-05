import { describe, expect, it } from 'vitest';
import {
  createLocalPbGhostStorageRecord,
  createLocalPbGhostTraceRecorder,
  getLargestPbGhostSizeReport,
  measurePbGhostStorage,
  PbGhostSizeCapture,
} from '../game/ghost/pb-ghost-size-debug.js';
import { createPbGhostTraceRecorder } from '../src/server/pb-ghost-trace.ts';

function pose(timeSec, x, y = 0, angle = 0) {
  return {
    timeSec,
    position: { x, y },
    angle,
  };
}

describe('local PB ghost size capture', () => {
  it('records the schema-v2 trace on the same 50ms grid as the server', () => {
    const recorder = createLocalPbGhostTraceRecorder(pose(0, 1));
    const serverRecorder = createPbGhostTraceRecorder(pose(0, 1));

    recorder.sample(pose(0.05, 1.5));
    recorder.sample(pose(0.1, 2));
    serverRecorder.sample(pose(0.05, 1.5));
    serverRecorder.sample(pose(0.1, 2));
    const trace = recorder.finish(pose(0.1, 2));
    const serverTrace = serverRecorder.finish(pose(0.1, 2));

    expect(trace).toEqual(serverTrace);
    expect(trace).toMatchObject({
      schemaVersion: 2,
      sampleIntervalMs: 50,
      finishTimeMs: 100,
      origin: [100, 0, 0],
      deltas: [50, 0, 0, 50, 0, 0],
    });
  });

  it('measures trace, full-record, gzip, and Redis-envelope bytes', async () => {
    const trace = {
      schemaVersion: 2,
      sampleIntervalMs: 50,
      finishTimeMs: 4_950,
      origin: [0, 0, 0],
      deltas: Array.from({ length: 99 * 3 }, (_, index) => (
        index % 3 === 0 ? 1 : 0
      )),
    };
    const record = createLocalPbGhostStorageRecord({
      trace,
      trackKey: 'size-test',
      rulesRevision: 1,
      lapCount: 2,
      bestTimeMs: trace.finishTimeMs,
      checkpointTimesSec: [1.25],
      lapCompletionTimesSec: [2.4, 4.95],
    });

    const measurement = await measurePbGhostStorage({ trace, record });

    expect(measurement.sampleCount).toBe(100);
    expect(measurement.finishTimeMs).toBe(4_950);
    expect(measurement.sizes.traceJsonBytes).toBeGreaterThan(0);
    expect(measurement.sizes.recordJsonBytes)
      .toBeGreaterThan(measurement.sizes.traceJsonBytes);
    expect(measurement.sizes.recordGzipBytes).toBeTypeOf('number');
    expect(measurement.sizes.recordRedisValueBytes).toBeTypeOf('number');
    expect(measurement.sizes.recordRedisValueBytes)
      .toBeLessThan(measurement.sizes.recordJsonBytes);
  });

  it('uses the portable gzip fallback when browser compression APIs are unavailable', async () => {
    const previousCompressionStream = globalThis.CompressionStream;
    const previousResponse = globalThis.Response;
    globalThis.CompressionStream = undefined;
    globalThis.Response = undefined;

    try {
      const trace = {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 4_950,
        origin: [0, 0, 0],
        deltas: Array.from({ length: 99 * 3 }, (_, index) => (
          index % 3 === 0 ? 1 : 0
        )),
      };
      const measurement = await measurePbGhostStorage({
        trace,
        record: createLocalPbGhostStorageRecord({ trace }),
      });

      expect(measurement.sizes.traceGzipBytes).toBeTypeOf('number');
      expect(measurement.sizes.recordGzipBytes).toBeTypeOf('number');
      expect(measurement.sizes.recordRedisValueBytes).toBeTypeOf('number');
    } finally {
      globalThis.CompressionStream = previousCompressionStream;
      globalThis.Response = previousResponse;
    }
  });

  it('does not require Response when CompressionStream is available', async () => {
    const previousResponse = globalThis.Response;
    globalThis.Response = undefined;

    try {
      const trace = {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 4_950,
        origin: [0, 0, 0],
        deltas: Array.from({ length: 99 * 3 }, (_, index) => (
          index % 3 === 0 ? 1 : 0
        )),
      };
      const measurement = await measurePbGhostStorage({
        trace,
        record: createLocalPbGhostStorageRecord({ trace }),
      });

      expect(measurement.sizes.recordGzipBytes).toBeTypeOf('number');
      expect(measurement.sizes.recordRedisValueBytes).toBeTypeOf('number');
    } finally {
      globalThis.Response = previousResponse;
    }
  });

  it('keeps Redis values below the server compression threshold uncompressed', async () => {
    const shortValue = 'a'.repeat(77);
    const measurement = await measurePbGhostStorage({
      trace: shortValue,
      record: shortValue,
    });

    expect(measurement.sizes.traceJsonBytes).toBe(79);
    expect(measurement.sizes.traceRedisValueBytes).toBe(79);
    expect(measurement.sizes.recordJsonBytes).toBe(79);
    expect(measurement.sizes.recordRedisValueBytes).toBe(79);
  });

  it('captures a completed local run without changing browser storage by default when disabled', async () => {
    const capture = new PbGhostSizeCapture({ persist: false });
    capture.beginRun({
      trackKey: 'size-test',
      mode: 'daily',
      challengeId: 'debug-size-test',
      rulesRevision: 1,
      lapCount: 1,
      position: { x: 0, y: 0 },
      angle: 0,
    });
    capture.sample(pose(0.05, 1));
    capture.recordLapCompletion(0.05);

    const report = await capture.finishRun({
      finishTimeSec: 0.05,
      position: { x: 1, y: 0 },
      angle: 0,
      checkpointTimesSec: null,
    });

    expect(report.metadata).toMatchObject({
      trackKey: 'size-test',
      challengeId: 'debug-size-test',
      rulesRevision: 1,
      lapCount: 1,
    });
    expect(report.record.ghost).toBeTruthy();
    expect(report.sizes.recordJsonBytes).toBeGreaterThan(0);
    expect(capture.getLastReport()).toBe(report);
    expect(getLargestPbGhostSizeReport(capture.getReports()).sizes.traceRedisValueBytes)
      .toBe(report.sizes.traceRedisValueBytes);
  });

  it('persists JSON sizes before asynchronous compression finishes', async () => {
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    };

    try {
      const capture = new PbGhostSizeCapture();
      capture.beginRun({
        trackKey: 'sync-size-test',
        mode: 'daily',
        position: { x: 0, y: 0 },
        angle: 0,
      });
      capture.sample(pose(0.05, 1));

      const reportPromise = capture.finishRun({
        finishTimeSec: 0.05,
        position: { x: 1, y: 0 },
        angle: 0,
      });
      const pendingCapture = JSON.parse(
        values.get('MiniRacerPbGhostSizeCaptures'),
      ).at(-1);

      expect(pendingCapture.sizes.traceJsonBytes).toBeGreaterThan(0);
      expect(pendingCapture.sizes.recordJsonBytes).toBeGreaterThan(0);

      const report = await reportPromise;
      expect(report.sizes.recordJsonBytes).toBe(pendingCapture.sizes.recordJsonBytes);
      expect(JSON.parse(values.get('MiniRacerPbGhostSizeCaptures')).at(-1).record.ghost)
        .toBeTruthy();
    } finally {
      if (previousStorage === undefined) {
        delete globalThis.localStorage;
      } else {
        globalThis.localStorage = previousStorage;
      }
    }
  });

  it('reloads persisted reports for the next debug-session instance', async () => {
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    };

    try {
      const firstCapture = new PbGhostSizeCapture();
      firstCapture.beginRun({
        trackKey: 'reload-size-test',
        mode: 'daily',
        position: { x: 0, y: 0 },
        angle: 0,
      });
      firstCapture.sample(pose(0.05, 1));
      const report = await firstCapture.finishRun({
        finishTimeSec: 0.05,
        position: { x: 1, y: 0 },
        angle: 0,
      });

      const reloadedCapture = new PbGhostSizeCapture();
      expect(reloadedCapture.getReports()).toHaveLength(1);
      expect(reloadedCapture.getLastReport()).toMatchObject({
        metadata: { trackKey: 'reload-size-test' },
        sizes: { recordJsonBytes: report.sizes.recordJsonBytes },
        record: { ghost: report.record.ghost },
      });
    } finally {
      if (previousStorage === undefined) {
        delete globalThis.localStorage;
      } else {
        globalThis.localStorage = previousStorage;
      }
    }
  });
});
