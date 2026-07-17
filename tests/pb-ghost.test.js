import { describe, expect, it, vi } from 'vitest';
import {
  PbGhost,
  interpolatePbGhostPose,
  normalizePbGhostRecord,
} from '../game/ghost/pb-ghost.js';

const record = {
  bestTimeMs: 2000,
  ghost: {
    samples: [
      [0, 1000, 2000, 3100],
      [1000, 3000, 4000, -3100],
      [2000, 5000, 6000, -3000],
    ],
  },
};

describe('PB ghost playback', () => {
  it('normalizes compact server samples', () => {
    expect(normalizePbGhostRecord(record)).toMatchObject({
      bestTimeMs: 2000,
      finishTimeMs: 2000,
      samples: [
        { timeMs: 0, x: 1, y: 2, angle: 3.1 },
        { timeMs: 1000, x: 3, y: 4, angle: -3.1 },
        { timeMs: 2000, x: 5, y: 6, angle: -3 },
      ],
    });
  });

  it('rejects malformed and non-monotonic traces', () => {
    expect(normalizePbGhostRecord(null)).toBe(null);
    expect(normalizePbGhostRecord({ ghost: { samples: [[0, 0, 0, 0]] } })).toBe(null);
    expect(normalizePbGhostRecord({
      ghost: { samples: [[0, 0, 0, 0], [0, 1, 1, 1]] },
    })).toBe(null);
  });

  it('interpolates position and angle over the shortest arc', () => {
    const normalized = normalizePbGhostRecord(record);
    const pose = interpolatePbGhostPose(normalized.samples, 500);
    expect(pose.x).toBe(2);
    expect(pose.y).toBe(3);
    expect(Math.abs(pose.angle)).toBeCloseTo(Math.PI, 2);
  });

  it('freezes prepared data and enabled state at the next attempt', () => {
    const ghost = new PbGhost({ enabled: true });
    ghost.prepare(record);
    expect(ghost.getPose(0.5)).toBe(null);
    expect(ghost.beginRun()).toBe(true);
    expect(ghost.getPose(0.5)).toMatchObject({ x: 2, y: 3 });

    ghost.prepare({
      ghost: { samples: [[0, 9000, 9000, 0], [1000, 10000, 10000, 0]] },
    });
    expect(ghost.getPose(0.5)).toMatchObject({ x: 2, y: 3 });

    ghost.setEnabled(false);
    expect(ghost.getPose(0.5)).toBe(null);
    ghost.setEnabled(true);
    expect(ghost.getPose(0.5)).toBe(null);
    ghost.beginRun();
    expect(ghost.getPose(0.5)).toMatchObject({ x: 9.5, y: 9.5 });
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
      raceTimeSec: 0.5,
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
