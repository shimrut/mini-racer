import { getCrossingFraction } from '../track/geometry.js';
import { normalizeCheckpointTimesSec } from '../shared/checkpoint-times.js';
import {
  LAP_FINISH_TOLERANCE_SEC,
  normalizeLapCompletionTimesSec,
} from '../shared/lap-completion-times.js';
import { normalizePbGhostRecord } from './pb-ghost.js';

function interpolateTimeSec(before, after, fraction) {
  const beforeSec = Number(before?.timeMs) / 1000;
  const afterSec = Number(after?.timeMs) / 1000;
  if (!Number.isFinite(beforeSec) || !Number.isFinite(afterSec)) return null;
  return beforeSec + (afterSec - beforeSec) * fraction;
}

function resolveExpectedLapCount(lapCount, record) {
  const requested = Math.trunc(Number(lapCount));
  if (requested === 2 || requested === 3) return requested;
  const recorded = Math.trunc(Number(record?.lapCount));
  if (recorded === 2 || recorded === 3) return recorded;
  if (requested === 1) return 1;
  if (recorded === 1) return 1;
  return requested;
}

export function deriveLapCompletionTimesSecFromGhost(record, track, lapCount) {
  const expectedLaps = resolveExpectedLapCount(lapCount, record);
  const normalizedGhost = normalizePbGhostRecord(record);
  const finishTimeSec = Number(record?.bestTimeMs) / 1000;
  const checkpoints = Array.isArray(track?.checkpoints) ? track.checkpoints : [];
  const startLine = track?.startLine;
  if (
    !normalizedGhost
    || !startLine
    || !Number.isInteger(expectedLaps)
    || expectedLaps < 1
    || !Number.isFinite(finishTimeSec)
    || finishTimeSec <= 0
  ) {
    return null;
  }

  let nextCheckpointIndex = 0;
  const boundaries = [];
  const samples = normalizedGhost.samples;

  for (let sampleIndex = 1; sampleIndex < samples.length && boundaries.length < expectedLaps; sampleIndex += 1) {
    const before = samples[sampleIndex - 1];
    const after = samples[sampleIndex];
    let lastCrossingFraction = -Number.EPSILON;

    while (nextCheckpointIndex < checkpoints.length) {
      const checkpoint = checkpoints[nextCheckpointIndex];
      const fraction = getCrossingFraction(before, after, checkpoint?.p1, checkpoint?.p2);
      if (fraction === null || fraction + Number.EPSILON < lastCrossingFraction) break;
      nextCheckpointIndex += 1;
      lastCrossingFraction = fraction;
    }

    if (nextCheckpointIndex < checkpoints.length) continue;
    const finishFraction = getCrossingFraction(before, after, startLine.p1, startLine.p2);
    if (finishFraction === null || finishFraction + Number.EPSILON < lastCrossingFraction) continue;
    const boundarySec = interpolateTimeSec(before, after, finishFraction);
    if (!Number.isFinite(boundarySec) || boundarySec <= 0) return null;
    boundaries.push(boundarySec);
    nextCheckpointIndex = 0;
  }

  const lastFoundBoundarySec = boundaries[boundaries.length - 1];
  const maxIntermediateBoundarySec = finishTimeSec * (expectedLaps - 0.5) / expectedLaps;
  if (
    boundaries.length === expectedLaps - 1
    && nextCheckpointIndex === checkpoints.length
    && Number.isFinite(lastFoundBoundarySec)
    && lastFoundBoundarySec < finishTimeSec - LAP_FINISH_TOLERANCE_SEC
    && lastFoundBoundarySec <= maxIntermediateBoundarySec
  ) {
    boundaries.push(finishTimeSec);
  }
  if (boundaries.length !== expectedLaps) return null;
  boundaries[boundaries.length - 1] = finishTimeSec;
  return normalizeLapCompletionTimesSec(finishTimeSec, boundaries, expectedLaps);
}

export function createPersonalBestPaceBaseline(record, track, lapCount) {
  const finishTimeSec = Number.isFinite(record?.finishTimeSec)
    ? record.finishTimeSec
    : Number(record?.bestTimeMs) / 1000;
  if (!Number.isFinite(finishTimeSec) || finishTimeSec <= 0) return null;

  const expectedLapCount = resolveExpectedLapCount(lapCount, record);
  const checkpointTimesSec = normalizeCheckpointTimesSec(
    finishTimeSec,
    record?.checkpointTimesSec,
  );
  const lapCompletionTimesSec = normalizeLapCompletionTimesSec(
    finishTimeSec,
    record?.lapCompletionTimesSec,
    expectedLapCount,
  ) ?? deriveLapCompletionTimesSecFromGhost(record, track, expectedLapCount);

  return Object.freeze({
    kind: 'personal-best',
    finishTimeSec,
    checkpointTimesSec: Object.freeze(checkpointTimesSec?.slice() ?? []),
    lapCompletionTimesSec: Object.freeze(lapCompletionTimesSec?.slice() ?? []),
  });
}

export function getLapPaceDeltaSec({
  elapsedTimeSec,
  lapNumber,
  requiredLaps,
  isFinalLap = false,
  paceBaseline,
} = {}) {
  if (!Number.isFinite(elapsedTimeSec) || !Number.isInteger(lapNumber) || lapNumber < 1) {
    return null;
  }
  const boundaries = paceBaseline?.lapCompletionTimesSec;
  if (!Array.isArray(boundaries)) return null;
  const requestedLaps = Math.trunc(Number(requiredLaps));
  const expectedLaps = requestedLaps === 2 || requestedLaps === 3
    ? requestedLaps
    : (boundaries.length === 2 || boundaries.length === 3 ? boundaries.length : 1);
  if (expectedLaps > 1 && boundaries.length !== expectedLaps) return null;
  const pbLapBoundarySec = boundaries[lapNumber - 1];
  if (!Number.isFinite(pbLapBoundarySec)) return null;
  const finishTimeSec = Number(paceBaseline?.finishTimeSec);
  if (
    expectedLaps > 1
    && !isFinalLap
    && Number.isFinite(finishTimeSec)
    && Math.abs(pbLapBoundarySec - finishTimeSec) <= LAP_FINISH_TOLERANCE_SEC
  ) {
    return null;
  }
  return elapsedTimeSec - pbLapBoundarySec;
}
