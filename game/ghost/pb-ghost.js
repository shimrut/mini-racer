import { finiteNumberOrNull } from '../shared/values.js';
const PB_GHOST_SCHEMA_VERSION = 2;
const SAMPLE_INTERVAL_MS = 50;
const MAX_SAMPLES = 4000;
const MAX_ENCODED_BYTES = 128 * 1024;
const POSITION_SCALE = 100;
const ANGLE_SCALE = 1000;
const GHOST_ALPHA = 0.24;
const FINISH_FADE_MS = 500;

function normalizeObjectSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const timeMs = finiteNumberOrNull(sample.timeMs ?? sample.t);
  const x = finiteNumberOrNull(sample.x);
  const y = finiteNumberOrNull(sample.y);
  const angle = finiteNumberOrNull(sample.angle);
  if (
    timeMs === null
    || x === null
    || y === null
    || angle === null
    || timeMs < 0
  ) {
    return null;
  }
  return { timeMs, x, y, angle };
}

function normalizeInternalSamples(rawSamples) {
  if (!Array.isArray(rawSamples) || rawSamples.length < 2) return null;
  const samples = [];
  let previousTimeMs = -1;
  for (const rawSample of rawSamples) {
    const sample = normalizeObjectSample(rawSample);
    if (!sample || sample.timeMs <= previousTimeMs) return null;
    previousTimeMs = sample.timeMs;
    samples.push(sample);
  }
  return samples;
}

function decodeCompactTrace(trace) {
  if (
    !trace
    || typeof trace !== 'object'
    || trace.schemaVersion !== PB_GHOST_SCHEMA_VERSION
    || trace.sampleIntervalMs !== SAMPLE_INTERVAL_MS
    || !Number.isSafeInteger(trace.finishTimeMs)
    || trace.finishTimeMs <= 0
    || !Array.isArray(trace.origin)
    || trace.origin.length !== 3
    || !trace.origin.every(Number.isSafeInteger)
    || !Array.isArray(trace.deltas)
    || trace.deltas.length < 3
    || trace.deltas.length % 3 !== 0
    || !trace.deltas.every(Number.isSafeInteger)
  ) {
    return null;
  }
  let encodedSize = 0;
  try {
    encodedSize = JSON.stringify(trace).length;
  } catch {
    return null;
  }
  if (encodedSize > MAX_ENCODED_BYTES) return null;
  const sampleCount = 1 + trace.deltas.length / 3;
  if (sampleCount < 2 || sampleCount > MAX_SAMPLES) return null;
  const penultimateTimeMs = (sampleCount - 2) * SAMPLE_INTERVAL_MS;
  const nextRegularTimeMs = (sampleCount - 1) * SAMPLE_INTERVAL_MS;
  if (
    trace.finishTimeMs <= penultimateTimeMs
    || trace.finishTimeMs > nextRegularTimeMs
  ) {
    return null;
  }

  let xCm = trace.origin[0];
  let yCm = trace.origin[1];
  let angleMilli = trace.origin[2];
  const samples = [{
    timeMs: 0,
    x: xCm / POSITION_SCALE,
    y: yCm / POSITION_SCALE,
    angle: angleMilli / ANGLE_SCALE,
  }];
  for (let offset = 0; offset < trace.deltas.length; offset += 3) {
    xCm += trace.deltas[offset];
    yCm += trace.deltas[offset + 1];
    angleMilli += trace.deltas[offset + 2];
    if (![xCm, yCm, angleMilli].every(Number.isSafeInteger)) return null;
    const sampleIndex = 1 + offset / 3;
    samples.push({
      timeMs: sampleIndex === sampleCount - 1
        ? trace.finishTimeMs
        : sampleIndex * SAMPLE_INTERVAL_MS,
      x: xCm / POSITION_SCALE,
      y: yCm / POSITION_SCALE,
      angle: angleMilli / ANGLE_SCALE,
    });
  }
  return samples;
}

export function normalizePbGhostRecord(record) {
  const samples = record?.ghost
    ? decodeCompactTrace(record.ghost)
    : normalizeInternalSamples(record?.samples);
  if (!samples) return null;

  return Object.freeze({
    bestTimeMs: finiteNumberOrNull(record?.bestTimeMs),
    samples: Object.freeze(samples),
    finishTimeMs: samples[samples.length - 1].timeMs,
  });
}

export function interpolatePbGhostPose(samples, timeMs) {
  if (!Array.isArray(samples) || samples.length < 2 || !Number.isFinite(timeMs)) {
    return null;
  }
  if (timeMs <= samples[0].timeMs) return { ...samples[0] };

  const finalSample = samples[samples.length - 1];
  if (timeMs >= finalSample.timeMs) return { ...finalSample };

  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (samples[middle].timeMs <= timeMs) low = middle;
    else high = middle;
  }

  const before = samples[low];
  const after = samples[high];
  const span = after.timeMs - before.timeMs;
  const progress = span > 0 ? (timeMs - before.timeMs) / span : 0;
  let angleDelta = after.angle - before.angle;
  while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
  while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;

  return {
    timeMs,
    x: before.x + (after.x - before.x) * progress,
    y: before.y + (after.y - before.y) * progress,
    angle: before.angle + angleDelta * progress,
  };
}

export class PbGhost {
  constructor({ enabled = true } = {}) {
    this.enabled = Boolean(enabled);
    this.preparedRecord = null;
    this.activeRecord = null;
    this.activeEnabled = false;
    this.preparedSource = null;
    this.activeSource = null;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled && this.activeSource !== 'opponent') {
      this.activeEnabled = false;
    }
    return this.enabled;
  }

  prepare(record) {
    if (this.preparedSource === 'opponent') return false;
    this.preparedRecord = normalizePbGhostRecord(record);
    this.preparedSource = this.preparedRecord ? 'personal-best' : null;
    return this.preparedRecord !== null;
  }

  prepareOpponent(record) {
    this.preparedRecord = normalizePbGhostRecord(record);
    this.preparedSource = this.preparedRecord ? 'opponent' : null;
    return this.preparedRecord !== null;
  }

  beginRun() {
    this.activeRecord = this.preparedRecord;
    this.activeSource = this.preparedSource;
    this.activeEnabled = this.activeRecord !== null
      && (this.enabled || this.activeSource === 'opponent');
    return this.activeEnabled;
  }

  clearPrepared() {
    if (this.preparedSource === 'opponent') return false;
    this.preparedRecord = null;
    this.preparedSource = null;
    return true;
  }

  clearOpponent() {
    const hadOpponent = this.preparedSource === 'opponent'
      || this.activeSource === 'opponent';
    if (!hadOpponent) return false;
    this.preparedRecord = null;
    this.activeRecord = null;
    this.preparedSource = null;
    this.activeSource = null;
    this.activeEnabled = false;
    return true;
  }

  clearTrack() {
    if (this.preparedSource === 'opponent' || this.activeSource === 'opponent') {
      return false;
    }
    this.preparedRecord = null;
    this.activeRecord = null;
    this.preparedSource = null;
    this.activeSource = null;
    this.activeEnabled = false;
    return true;
  }

  getPose(raceTimeSec) {
    if (!this.activeEnabled || !this.activeRecord) return null;
    const raceTimeMs = Math.max(0, Number(raceTimeSec) || 0) * 1000;
    const pose = interpolatePbGhostPose(
      this.activeRecord.samples,
      raceTimeMs,
    );
    return pose ? { ...pose, raceTimeMs } : null;
  }

  render(ctx, {
    raceTimeSec,
    gridSize,
    carSprite,
    drawWidth,
    drawHeight,
  } = {}) {
    if (
      !ctx
      || !carSprite
      || !Number.isFinite(gridSize)
      || gridSize <= 0
      || !Number.isFinite(drawWidth)
      || drawWidth <= 0
      || !Number.isFinite(drawHeight)
      || drawHeight <= 0
    ) {
      return false;
    }
    const pose = this.getPose(raceTimeSec);
    if (!pose) return false;

    const elapsedAfterFinishMs = pose.raceTimeMs - this.activeRecord.finishTimeMs;
    const finishAlpha = elapsedAfterFinishMs <= 0
      ? 1
      : Math.max(0, 1 - elapsedAfterFinishMs / FINISH_FADE_MS);
    if (finishAlpha <= 0) return false;

    ctx.save();
    ctx.translate(pose.x * gridSize, pose.y * gridSize);
    ctx.rotate(pose.angle);
    ctx.globalAlpha *= GHOST_ALPHA * finishAlpha;
    ctx.drawImage(
      carSprite,
      -drawWidth / 2,
      -drawHeight / 2,
      drawWidth,
      drawHeight,
    );
    ctx.restore();
    return true;
  }
}
