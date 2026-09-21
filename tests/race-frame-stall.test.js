import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SIMULATED_FRAME_DT,
  RANKED_RUN_STALL_MESSAGE,
  raceEngineMethods,
} from '../game/race/engine-methods.js';

function createLoopEngine(overrides = {}) {
  return {
    status: 'playing',
    lastTime: 1000,
    FIXED_DT: 1 / 60,
    accumulator: 0,
    runHadTimingAnomaly: false,
    rankedSubmissionBlockedReason: null,
    frameTimeHistory: [],
    frameTimeHistoryIndex: 0,
    frameTimeTotal: 0,
    frameSkip: 0,
    particles: [],
    _needsRender: false,
    _frameRequestId: 1,
    prevPos: { x: 0, y: 0 },
    prevAngle: 0,
    pos: { x: 0, y: 0 },
    angle: 0,
    cachedSpeed: 0,
    velocity: { x: 0, y: 0 },
    hud: { syncHud: vi.fn() },
    shouldAnimateFrame: () => false,
    requestFrame: vi.fn(),
    update: vi.fn(),
    render: vi.fn(),
    ...overrides,
  };
}

describe('race frame hitch ranking', () => {
  it('fully simulates a phone hitch under the catch-up cap and still ranks', () => {
    const engine = createLoopEngine();

    raceEngineMethods.loop.call(engine, 1080);

    expect(engine.update).toHaveBeenCalledTimes(4);
    expect(engine.runHadTimingAnomaly).toBe(false);
    expect(engine.rankedSubmissionBlockedReason).toBeNull();
  });

  it('simulates the full catch-up cap without blocking rank', () => {
    const engine = createLoopEngine();

    raceEngineMethods.loop.call(engine, 1000 + MAX_SIMULATED_FRAME_DT * 1000);

    expect(engine.update).toHaveBeenCalledTimes(6);
    expect(engine.runHadTimingAnomaly).toBe(false);
    expect(engine.rankedSubmissionBlockedReason).toBeNull();
  });

  it('refuses ranking when a hitch is longer than the game will simulate', () => {
    const engine = createLoopEngine();

    raceEngineMethods.loop.call(engine, 1000 + MAX_SIMULATED_FRAME_DT * 1000 + 1);

    expect(engine.update).toHaveBeenCalledTimes(6);
    expect(engine.runHadTimingAnomaly).toBe(true);
    expect(engine.rankedSubmissionBlockedReason).toBe(RANKED_RUN_STALL_MESSAGE);
  });

  it('dumps leftover ticks after the catch-up cap without treating that as a stall', () => {
    const engine = createLoopEngine({
      accumulator: 0.09,
    });

    raceEngineMethods.loop.call(engine, 1000 + MAX_SIMULATED_FRAME_DT * 1000);

    expect(engine.update).toHaveBeenCalledTimes(6);
    expect(engine.accumulator).toBe(0);
    expect(engine.runHadTimingAnomaly).toBe(false);
  });
});
