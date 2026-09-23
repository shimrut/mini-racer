import { finiteNumberOrNull } from '../shared/values.js';

import {
  PB_GHOST_SCHEMA_VERSION,
  PB_GHOST_SIMULATION_REVISION,
} from '../shared/pb-ghost-format.js';
import { createPbGhostPoseRecorder } from '../shared/pb-ghost-recorder.js';

export { createPbGhostPoseRecorder as createLocalPbGhostTraceRecorder };

const REDIS_COMPRESSION_PREFIX = '__gz:b64__:';
const REDIS_COMPRESSION_MIN_LENGTH = 80;
const PB_GHOST_SIZE_REPORTS_KEY = 'MiniRacerPbGhostSizeReports';
const PB_GHOST_SIZE_CAPTURES_KEY = 'MiniRacerPbGhostSizeCaptures';
export const PB_GHOST_SIZE_ENABLED_STORAGE_KEY = 'MiniRacerPbGhostSizeEnabled';
const PB_GHOST_TRACK_FINGERPRINT_LENGTH = 43;

function getUtf8Bytes(value) {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(value);
  }
  if (typeof Buffer === 'function') {
    return new Uint8Array(Buffer.from(value, 'utf8'));
  }

  const encoded = encodeURIComponent(value);
  const bytes = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return new Uint8Array(bytes);
}

function utf8ByteLength(value) {
  return getUtf8Bytes(value).byteLength;
}

function getJsonStorageMeasurement({ trace, record } = {}) {
  const traceJson = JSON.stringify(trace ?? null);
  const recordJson = JSON.stringify(record ?? { ghost: trace ?? null });
  return {
    traceJson,
    recordJson,
    traceJsonBytes: utf8ByteLength(traceJson),
    recordJsonBytes: utf8ByteLength(recordJson),
  };
}

async function readReadableByteLength(readable) {
  const reader = readable.getReader();
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return totalBytes;
    totalBytes += value?.byteLength || 0;
  }
}

async function gzipByteLength(value) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    await writer.write(getUtf8Bytes(value));
    await writer.close();
    return readReadableByteLength(stream.readable);
  } catch (_error) {
    return null;
  }
}

function getRedisValueByteLength(value, valueBytes, gzipBytes) {
  if (!Number.isFinite(gzipBytes)) return null;
  if (typeof value !== 'string' || value.length < REDIS_COMPRESSION_MIN_LENGTH) {
    return valueBytes;
  }

  const base64Bytes = Math.ceil(gzipBytes / 3) * 4;
  const envelopeBytes = utf8ByteLength(REDIS_COMPRESSION_PREFIX) + base64Bytes;
  return envelopeBytes < value.length ? envelopeBytes : valueBytes;
}

function normalizeLapCount(value) {
  return value === 2 || value === 3 ? value : 1;
}

export function createLocalPbGhostStorageRecord({
  trace,
  trackKey = 'unknown',
  rulesRevision = 0,
  lapCount = 1,
  bestTimeMs = trace?.finishTimeMs ?? 0,
  checkpointTimesSec = null,
  lapCompletionTimesSec = null,
  updatedAt = new Date().toISOString(),
} = {}) {
  return {
    schemaVersion: PB_GHOST_SCHEMA_VERSION,
    trackKey: typeof trackKey === 'string' && trackKey ? trackKey : 'unknown',
    trackFingerprint: '0'.repeat(PB_GHOST_TRACK_FINGERPRINT_LENGTH),
    simulationRevision: PB_GHOST_SIMULATION_REVISION,
    rulesRevision: rulesRevision === 1 ? 1 : 0,
    lapCount: normalizeLapCount(lapCount),
    bestTimeMs: Math.round(Number(bestTimeMs) || 0),
    checkpointTimesSec: Array.isArray(checkpointTimesSec)
      ? checkpointTimesSec.slice()
      : null,
    lapCompletionTimesSec: Array.isArray(lapCompletionTimesSec)
      ? lapCompletionTimesSec.slice()
      : null,
    ghost: trace ?? null,
    updatedAt,
  };
}

export async function measurePbGhostStorage({ trace, record } = {}) {
  const {
    traceJson,
    recordJson,
    traceJsonBytes,
    recordJsonBytes,
  } = getJsonStorageMeasurement({ trace, record });
  const [traceGzipBytes, recordGzipBytes] = await Promise.all([
    gzipByteLength(traceJson),
    gzipByteLength(recordJson),
  ]);
  const traceRedisValueBytes = getRedisValueByteLength(
    traceJson,
    traceJsonBytes,
    traceGzipBytes,
  );
  const recordRedisValueBytes = getRedisValueByteLength(
    recordJson,
    recordJsonBytes,
    recordGzipBytes,
  );

  return {
    schemaVersion: PB_GHOST_SCHEMA_VERSION,
    sampleCount: Array.isArray(trace?.deltas)
      ? 1 + trace.deltas.length / 3
      : 0,
    finishTimeMs: finiteNumberOrNull(trace?.finishTimeMs),
    sizes: {
      traceJsonBytes,
      traceGzipBytes,
      traceRedisValueBytes,
      recordJsonBytes,
      recordGzipBytes,
      recordRedisValueBytes,
      compressionUsed: recordRedisValueBytes !== null
        ? recordRedisValueBytes < recordJsonBytes
        : null,
    },
  };
}

function readStoredReports() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PB_GHOST_SIZE_REPORTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function createReportSummary(report) {
  return {
    measuredAt: report.measuredAt,
    metadata: report.metadata,
    sampleCount: report.sampleCount,
    finishTimeMs: report.finishTimeMs,
    sizes: report.sizes,
  };
}

function persistReportSummaries(reports) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      PB_GHOST_SIZE_REPORTS_KEY,
      JSON.stringify(reports.slice(-50)),
    );
  } catch (error) {
    console.warn('[PB ghost size] could not persist report summary', error);
  }
}

function readStoredCaptures() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PB_GHOST_SIZE_CAPTURES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function persistReportCaptures(captures) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      PB_GHOST_SIZE_CAPTURES_KEY,
      JSON.stringify(captures.slice(-10)),
    );
  } catch (error) {
    console.warn('[PB ghost size] could not persist complete capture', error);
  }
}

function createJsonOnlyMeasurement({ trace, record } = {}) {
  const {
    traceJsonBytes,
    recordJsonBytes,
  } = getJsonStorageMeasurement({ trace, record });
  return {
    schemaVersion: PB_GHOST_SCHEMA_VERSION,
    sampleCount: Array.isArray(trace?.deltas)
      ? 1 + trace.deltas.length / 3
      : 0,
    finishTimeMs: finiteNumberOrNull(trace?.finishTimeMs),
    sizes: {
      traceJsonBytes,
      traceGzipBytes: null,
      traceRedisValueBytes: null,
      recordJsonBytes,
      recordGzipBytes: null,
      recordRedisValueBytes: null,
      compressionUsed: null,
    },
  };
}

export function getLargestPbGhostSizeReport(reports = []) {
  return reports.reduce((largest, report) => {
    const largestBytes = largest?.sizes?.traceRedisValueBytes
      ?? largest?.sizes?.traceJsonBytes
      ?? -1;
    const reportBytes = report?.sizes?.traceRedisValueBytes
      ?? report?.sizes?.traceJsonBytes
      ?? -1;
    return reportBytes > largestBytes ? report : largest;
  }, null);
}

export class PbGhostSizeCapture {
  constructor({ persist = true } = {}) {
    this.persist = Boolean(persist);
    this.recorder = null;
    this.metadata = null;
    this.lapCompletionTimesSec = [];
    this.reports = readStoredReports();
    this.storedCaptures = readStoredCaptures();
    this.lastReport = this.storedCaptures.at(-1) ?? null;
  }

  beginRun({
    trackKey,
    mode,
    challengeId,
    rulesRevision,
    lapCount,
    position,
    angle,
  } = {}) {
    this.recorder = createPbGhostPoseRecorder({
      timeSec: 0,
      position,
      angle,
    });
    this.metadata = {
      trackKey: typeof trackKey === 'string' ? trackKey : 'unknown',
      mode: typeof mode === 'string' ? mode : 'unknown',
      challengeId: typeof challengeId === 'string' ? challengeId : null,
      rulesRevision: rulesRevision === 1 ? 1 : 0,
      lapCount: normalizeLapCount(lapCount),
    };
    this.lapCompletionTimesSec = [];
    console.info('[PB ghost size] recording run', this.metadata);
  }

  sample({ timeSec, position, angle } = {}) {
    this.recorder?.sample({ timeSec, position, angle });
  }

  recordLapCompletion(elapsedTimeSec) {
    if (Number.isFinite(elapsedTimeSec)) {
      this.lapCompletionTimesSec.push(Number(elapsedTimeSec));
    }
  }

  cancelRun() {
    this.recorder = null;
    this.metadata = null;
    this.lapCompletionTimesSec = [];
  }

  async finishRun({
    finishTimeSec,
    position,
    angle,
    checkpointTimesSec = null,
  } = {}) {
    if (!this.recorder || !this.metadata) return null;

    const recorder = this.recorder;
    const metadata = this.metadata;
    const lapCompletionTimesSec = this.lapCompletionTimesSec.slice();
    this.cancelRun();

    const trace = recorder.finish({
      timeSec: finishTimeSec,
      position,
      angle,
    });
    if (!trace) {
      console.warn('[PB ghost size] run did not produce a valid trace', {
        finishTimeSec,
        hasRecorder: Boolean(recorder),
      });
      return null;
    }

    const record = createLocalPbGhostStorageRecord({
      trace,
      trackKey: metadata.trackKey,
      rulesRevision: metadata.rulesRevision,
      lapCount: metadata.lapCount,
      bestTimeMs: trace.finishTimeMs,
      checkpointTimesSec,
      lapCompletionTimesSec: lapCompletionTimesSec.length
        ? lapCompletionTimesSec
        : null,
    });
    const report = {
      reportVersion: 1,
      measuredAt: new Date().toISOString(),
      metadata,
      ...createJsonOnlyMeasurement({ trace, record }),
      record,
    };
    this.commitReport(report);

    let measurement;
    try {
      measurement = await measurePbGhostStorage({ trace, record });
    } catch (error) {
      console.warn('[PB ghost size] compression measurement failed', error);
      return report;
    }

    const measuredReport = {
      ...report,
      ...measurement,
    };
    this.commitReport(measuredReport, { replaceLast: true });
    console.info('[PB ghost size]', {
      ...measuredReport.metadata,
      ...measuredReport.sizes,
      sampleCount: measuredReport.sampleCount,
      persisted: this.persist,
    });
    return measuredReport;
  }

  commitReport(report, { replaceLast = false } = {}) {
    this.lastReport = report;
    if (replaceLast && this.storedCaptures.length > 0) {
      this.storedCaptures = [
        ...this.storedCaptures.slice(0, -1),
        report,
      ];
      this.reports = [
        ...this.reports.slice(0, -1),
        createReportSummary(report),
      ];
    } else {
      this.storedCaptures = [...this.storedCaptures, report].slice(-10);
      this.reports = [
        ...this.reports,
        createReportSummary(report),
      ].slice(-50);
    }
    if (this.persist) {
      persistReportSummaries(this.reports);
      persistReportCaptures(this.storedCaptures);
    }
  }

  getReports() {
    return this.reports.slice();
  }

  getLastReport() {
    return this.lastReport;
  }
}

export function shouldCapturePbGhostSize() {
  if (typeof window === 'undefined') return false;
  const value = new URLSearchParams(window.location.search).get('debugPbGhostSize');
  if (['1', 'true', 'yes'].includes(String(value).toLowerCase())) return true;
  try {
    return window.localStorage?.getItem(PB_GHOST_SIZE_ENABLED_STORAGE_KEY) === '1';
  } catch (_error) {
    return false;
  }
}

export function exposePbGhostSizeDebugHooks(engine) {
  window.__PB_GHOST_SIZE_DEBUG__ = Object.freeze({
    enabled: () => Boolean(engine.pbGhostSizeCapture),
    enable: () => {
      try {
        window.localStorage?.setItem(PB_GHOST_SIZE_ENABLED_STORAGE_KEY, '1');
      } catch (_error) {
      }
      engine.pbGhostSizeCapture ??= new PbGhostSizeCapture();
      return true;
    },
    getReports: () => engine.pbGhostSizeCapture?.getReports?.() || [],
    getLastReport: () => engine.pbGhostSizeCapture?.getLastReport?.() || null,
    getLargestReport: () => getLargestPbGhostSizeReport(
      engine.pbGhostSizeCapture?.getReports?.() || [],
    ),
  });
}
