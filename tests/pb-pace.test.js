import { describe, expect, it } from 'vitest';
import {
  createPersonalBestPaceBaseline,
  deriveLapCompletionTimesSecFromGhost,
} from '../game/ghost/pb-pace.js';
import { normalizeLapCompletionTimesSec } from '../game/shared/lap-completion-times.js';

const TRACK = {
  checkpoints: [{
    p1: { x: 5, y: -10 },
    p2: { x: 5, y: 10 },
  }],
  startLine: {
    p1: { x: 0, y: -10 },
    p2: { x: 0, y: 10 },
  },
};

function historicalGhost(lapCount) {
  const samples = [{ timeMs: 0, x: 0, y: 0, angle: 0 }];
  for (let lap = 0; lap < lapCount; lap += 1) {
    samples.push(
      { timeMs: lap * 2000 + 1000, x: 6, y: 0, angle: 0 },
      { timeMs: lap * 2000 + 2000, x: -1, y: 0, angle: 0 },
    );
  }
  return {
    bestTimeMs: lapCount * 2000,
    checkpointTimesSec: Array.from(
      { length: lapCount },
      (_, index) => index * 2 + 0.8,
    ),
    samples,
  };
}

describe('PB pace baselines', () => {
  it.each([
    [1, [2]],
    [2, [13.5, 27]],
    [3, [13.5, 27, 40.5]],
  ])('accepts exact cumulative boundaries for %i laps', (lapCount, boundaries) => {
    const finishTimeSec = boundaries.at(-1);
    expect(normalizeLapCompletionTimesSec(
      finishTimeSec,
      boundaries,
      lapCount,
    )).toEqual(boundaries);
  });

  it.each([
    [[12, 11], 2],
    [[12], 2],
    [[12, 24.1], 2],
    [['bad', 24], 2],
  ])('rejects malformed boundary arrays without invalidating the PB', (boundaries, lapCount) => {
    expect(normalizeLapCompletionTimesSec(24, boundaries, lapCount)).toBeNull();
    expect(createPersonalBestPaceBaseline({
      bestTimeMs: 24_000,
      checkpointTimesSec: [4, 16],
      lapCompletionTimesSec: boundaries,
    }, TRACK, lapCount)).toMatchObject({
      finishTimeSec: 24,
      checkpointTimesSec: [4, 16],
      lapCompletionTimesSec: [],
    });
  });

  it.each([2, 3])(
    'derives all cumulative boundaries from a historical %i-lap ghost',
    (lapCount) => {
      const record = historicalGhost(lapCount);
      const boundaries = deriveLapCompletionTimesSecFromGhost(
        record,
        TRACK,
        lapCount,
      );

      expect(boundaries).toHaveLength(lapCount);
      expect(boundaries[0]).toBeCloseTo(13 / 7);
      if (lapCount === 3) expect(boundaries[1]).toBeCloseTo(27 / 7);
      expect(boundaries.at(-1)).toBe(lapCount * 2);
    },
  );

  it('rejects incomplete ghost crossings instead of fabricating a lap delta', () => {
    const record = {
      bestTimeMs: 4000,
      samples: [
        { timeMs: 0, x: 0, y: 0, angle: 0 },
        { timeMs: 1000, x: 1, y: 0, angle: 0 },
        { timeMs: 2000, x: -1, y: 0, angle: 0 },
        { timeMs: 3000, x: 1, y: 0, angle: 0 },
        { timeMs: 4000, x: -1, y: 0, angle: 0 },
      ],
    };

    expect(deriveLapCompletionTimesSecFromGhost(record, TRACK, 2)).toBeNull();
    expect(createPersonalBestPaceBaseline(record, TRACK, 2)).toMatchObject({
      finishTimeSec: 4,
      lapCompletionTimesSec: [],
    });
  });

  it('prefers exact verified boundaries and freezes every active-run value', () => {
    const baseline = createPersonalBestPaceBaseline({
      bestTimeMs: 4000,
      checkpointTimesSec: [0.8, 2.8],
      lapCompletionTimesSec: [2, 4],
      ...historicalGhost(2),
    }, TRACK, 2);

    expect(baseline.lapCompletionTimesSec).toEqual([2, 4]);
    expect(Object.isFrozen(baseline)).toBe(true);
    expect(Object.isFrozen(baseline.checkpointTimesSec)).toBe(true);
    expect(Object.isFrozen(baseline.lapCompletionTimesSec)).toBe(true);
  });
});
