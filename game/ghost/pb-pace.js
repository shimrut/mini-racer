import { getCrossingFraction } from '../track/geometry.js';
import { normalizeCheckpointTimesSec } from '../shared/checkpoint-times.js';
import { normalizeLapCompletionTimesSec } from '../shared/lap-completion-times.js';
import { normalizePbGhostRecord } from './pb-ghost.js';

function interpolateTimeSec(before, after, fraction) {
  const beforeSec = Number(before?.timeMs) / 1000;
  const afterSec = Number(after?.timeMs) / 1000;
  if (!Number.isFinite(beforeSec) || !Number.isFinite(afterSec)) return null;
  return beforeSec + (afterSec - beforeSec) * fraction;
}

/**
 * Recovers cumulative lap-boundary timestamps from an older canonical ghost.
 *
 * The trace uses the same car position and ordered checkpoint/start-line gates
 * as simulation. A partial or ambiguous reconstruction is rejected instead of
 * presenting an invented pace delta.
 */
export function deriveLapCompletionTimesSecFromGhost(record, track, lapCount) {
  const expectedLaps = Math.trunc(Number(lapCount));
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

  // The compact trace stores the final finish timestamp exactly, but position
  // quantization can place its last sample just beside the line.
  if (
    boundaries.length === expectedLaps - 1
    && nextCheckpointIndex === checkpoints.length
  ) {
    boundaries.push(finishTimeSec);
  }
  if (boundaries.length !== expectedLaps) return null;
  boundaries[boundaries.length - 1] = finishTimeSec;
  return normalizeLapCompletionTimesSec(finishTimeSec, boundaries, expectedLaps);
}

export function createPersonalBestPaceBaseline(record, track, lapCount) {
  const finishTimeSec = Number(record?.bestTimeMs) / 1000;
  if (!Number.isFinite(finishTimeSec) || finishTimeSec <= 0) return null;

  const checkpointTimesSec = normalizeCheckpointTimesSec(
    finishTimeSec,
    record?.checkpointTimesSec,
  );
  const lapCompletionTimesSec = normalizeLapCompletionTimesSec(
    finishTimeSec,
    record?.lapCompletionTimesSec,
    lapCount,
  ) ?? deriveLapCompletionTimesSecFromGhost(record, track, lapCount);

  return Object.freeze({
    kind: 'personal-best',
    finishTimeSec,
    checkpointTimesSec: Object.freeze(checkpointTimesSec?.slice() ?? []),
    lapCompletionTimesSec: Object.freeze(lapCompletionTimesSec?.slice() ?? []),
  });
}
