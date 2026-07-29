import { describe, expect, it, vi } from 'vitest';
import {
  PbGhost,
  interpolatePbGhostPose,
  normalizePbGhostRecord,
} from '../game/ghost/pb-ghost.js';

const record = {
  bestTimeMs: 100,
  ghost: {
    schemaVersion: 2,
    sampleIntervalMs: 50,
    finishTimeMs: 100,
    origin: [100, 200, 3100],
    deltas: [200, 200, 83, 200, 200, 100],
  },
};

describe('PB ghost playback', () => {
  it('normalizes compact server samples', () => {
    expect(normalizePbGhostRecord(record)).toMatchObject({
      bestTimeMs: 100,
      finishTimeMs: 100,
      samples: [
        { timeMs: 0, x: 1, y: 2, angle: 3.1 },
        { timeMs: 50, x: 3, y: 4, angle: 3.183 },
        { timeMs: 100, x: 5, y: 6, angle: 3.283 },
      ],
    });
  });

  it('rejects malformed and non-monotonic traces', () => {
    expect(normalizePbGhostRecord(null)).toBe(null);
    expect(normalizePbGhostRecord({
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [],
      },
    })).toBe(null);
    expect(normalizePbGhostRecord({
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 75,
        origin: [0, 0, 0],
        deltas: [1, 1, 1],
      },
    })).toBe(null);
    expect(normalizePbGhostRecord({
      ghost: {
        ...record.ghost,
        padding: 'x'.repeat(128 * 1024),
      },
    })).toBe(null);
  });

  it('interpolates position and angle over the shortest arc', () => {
    const normalized = normalizePbGhostRecord(record);
    const pose = interpolatePbGhostPose(normalized.samples, 25);
    expect(pose.x).toBe(2);
    expect(pose.y).toBe(3);
    expect(Math.abs(pose.angle)).toBeCloseTo(Math.PI, 2);
  });

  it('reconstructs fixed-rate timestamps, exact finish time and centimetre precision', () => {
    const normalized = normalizePbGhostRecord({
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 73,
        origin: [123, -568, 1234],
        deltas: [-23, 68, -234, 25, -25, 500],
      },
    });

    expect(normalized.samples.map((sample) => sample.timeMs)).toEqual([0, 50, 73]);
    expect(normalized.samples.at(-1)).toMatchObject({
      x: 1.25,
      y: -5.25,
      angle: 1.5,
    });
    expect(Math.abs(normalized.samples[0].x - 1.234)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(normalized.samples[0].y - (-5.678))).toBeLessThanOrEqual(0.005);
    expect(Math.abs(normalized.samples[0].angle - 1.234)).toBeLessThanOrEqual(0.001);
  });

  it('freezes prepared data and enabled state at the next attempt', () => {
    const ghost = new PbGhost({ enabled: true });
    ghost.prepare(record);
    expect(ghost.getPose(0.025)).toBe(null);
    expect(ghost.beginRun()).toBe(true);
    expect(ghost.getPose(0.025)).toMatchObject({ x: 2, y: 3 });

    ghost.prepare({
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [900, 900, 0],
        deltas: [100, 100, 0],
      },
    });
    expect(ghost.getPose(0.025)).toMatchObject({ x: 2, y: 3 });

    ghost.setEnabled(false);
    expect(ghost.getPose(0.025)).toBe(null);
    ghost.setEnabled(true);
    expect(ghost.getPose(0.025)).toBe(null);
    ghost.beginRun();
    expect(ghost.getPose(0.025)).toMatchObject({ x: 9.5, y: 9.5 });
  });

  it('uses a ghost prepared after GO only on the next attempt', () => {
    const ghost = new PbGhost();
    expect(ghost.beginRun()).toBe(false);

    ghost.prepare({
      bestTimeMs: 50,
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [100, 0, 0],
      },
    });
    expect(ghost.getPose(0.025)).toBe(null);
    expect(ghost.beginRun()).toBe(true);
    expect(ghost.getPose(0.025)).toMatchObject({ x: 0.5 });
  });

  it('locks an opponent ghost across late PB updates and ignores the PB setting', () => {
    const ghost = new PbGhost({ enabled: false });
    expect(ghost.prepareOpponent(record)).toBe(true);
    expect(ghost.prepare({
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [900, 900, 0],
        deltas: [100, 100, 0],
      },
    })).toBe(false);

    expect(ghost.beginRun()).toBe(true);
    expect(ghost.getPose(0.025)).toMatchObject({ x: 2, y: 3 });
    ghost.setEnabled(false);
    expect(ghost.getPose(0.025)).toMatchObject({ x: 2, y: 3 });
    expect(ghost.clearPrepared()).toBe(false);
    expect(ghost.clearOpponent()).toBe(true);
    expect(ghost.getPose(0.025)).toBe(null);
  });

  it('renders without mutating playback samples', () => {
    const ghost = new PbGhost();
    ghost.prepare(record);
    ghost.beginRun();
    const before = JSON.stringify(ghost.activeRecord.samples);
    const ctx = {
      globalAlpha: 1,
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
    };
    const carSprite = { id: 'selected-car' };

    expect(ghost.render(ctx, {
      raceTimeSec: 0.025,
      gridSize: 20,
      carSprite,
      drawWidth: 52,
      drawHeight: 52,
    })).toBe(true);
    expect(ctx.translate).toHaveBeenCalledWith(40, 60);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      carSprite,
      -26,
      -26,
      52,
      52,
    );
    expect(ctx.globalAlpha).toBeCloseTo(0.24);
    expect(JSON.stringify(ghost.activeRecord.samples)).toBe(before);
  });

  it('does not render without the selected car sprite', () => {
    const ghost = new PbGhost();
    ghost.prepare(record);
    ghost.beginRun();

    expect(ghost.render({ globalAlpha: 1 }, {
      raceTimeSec: 0.5,
      gridSize: 20,
      drawWidth: 52,
      drawHeight: 52,
    })).toBe(false);
  });
});
