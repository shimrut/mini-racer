const POSITION_SCALE = 1000;
const ANGLE_SCALE = 1000;
const GHOST_ALPHA = 0.24;
const FINISH_FADE_MS = 500;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTupleSample(sample) {
  if (!Array.isArray(sample) || sample.length < 4) return null;
  const timeMs = finiteNumber(sample[0]);
  const xMilli = finiteNumber(sample[1]);
  const yMilli = finiteNumber(sample[2]);
  const angleMilli = finiteNumber(sample[3]);
  if (
    timeMs === null
    || xMilli === null
    || yMilli === null
    || angleMilli === null
    || timeMs < 0
  ) {
    return null;
  }
  return {
    timeMs,
    x: xMilli / POSITION_SCALE,
    y: yMilli / POSITION_SCALE,
    angle: angleMilli / ANGLE_SCALE,
  };
}

function normalizeObjectSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const timeMs = finiteNumber(sample.timeMs ?? sample.t);
  const x = finiteNumber(sample.x);
  const y = finiteNumber(sample.y);
  const angle = finiteNumber(sample.angle);
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

export function normalizePbGhostRecord(record) {
  const rawSamples = record?.ghost?.samples ?? record?.samples;
  if (!Array.isArray(rawSamples) || rawSamples.length < 2) return null;

  const samples = [];
  let previousTimeMs = -1;
  for (const rawSample of rawSamples) {
    const sample = Array.isArray(rawSample)
      ? normalizeTupleSample(rawSample)
      : normalizeObjectSample(rawSample);
    if (!sample || sample.timeMs <= previousTimeMs) return null;
    previousTimeMs = sample.timeMs;
    samples.push(sample);
  }

  return Object.freeze({
    bestTimeMs: finiteNumber(record?.bestTimeMs),
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
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.activeEnabled = false;
    return this.enabled;
  }

  prepare(record) {
    this.preparedRecord = normalizePbGhostRecord(record);
    return this.preparedRecord !== null;
  }

  beginRun() {
    this.activeRecord = this.preparedRecord;
    this.activeEnabled = this.enabled && this.activeRecord !== null;
    return this.activeEnabled;
  }

  clearTrack() {
    this.preparedRecord = null;
    this.activeRecord = null;
    this.activeEnabled = false;
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
