import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PbGhostService } from '../game/ghost/pb-ghost-service.js';

describe('PB ghost API service', () => {
  let originalWindow;
  let originalLocation;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalLocation = globalThis.location;
    globalThis.window = {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    };
    globalThis.location = { origin: 'https://example.test' };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.location = originalLocation;
  });

  it('returns summaries keyed by challenge id and caps requests at seven ids', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        trackPbs: {
          'daily-1': { trackKey: 'circuit', bestTimeMs: 1234 },
        },
      }),
    }));
    const service = new PbGhostService({
      routes: {
        playerTrackPbsUrl: '/api/player/track-pbs',
        playerPbGhostUrl: '/api/player/pb-ghost',
      },
      fetchImpl,
    });

    await expect(service.getSummaries([
      'daily-1', 'daily-2', 'daily-3', 'daily-4',
      'daily-5', 'daily-6', 'daily-7', 'daily-8',
    ])).resolves.toEqual({
      'daily-1': { trackKey: 'circuit', bestTimeMs: 1234 },
    });
    const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(requestUrl.searchParams.get('challengeIds').split(',')).toHaveLength(7);
    expect(requestUrl.searchParams.get('playerId')).toBeTruthy();
  });

  it('caches a full personal-best record until invalidated', async () => {
    const record = {
      bestTimeMs: 1500,
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [100, 100, 0],
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ personalBest: record }),
    }));
    const service = new PbGhostService({
      routes: {
        playerTrackPbsUrl: '/api/player/track-pbs',
        playerPbGhostUrl: '/api/player/pb-ghost',
      },
      fetchImpl,
    });

    await expect(service.getForChallenge('daily-1')).resolves.toEqual(record);
    await expect(service.getForChallenge('daily-1')).resolves.toEqual(record);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    service.invalidate('daily-1');
    await service.getForChallenge('daily-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps challenge requests independent while a canonical install supersedes an older request', async () => {
    const resolvers = new Map();
    const fetchImpl = vi.fn((url) => new Promise((resolve) => {
      resolvers.set(new URL(url).searchParams.get('challengeId'), resolve);
    }));
    const service = new PbGhostService({
      routes: {
        playerTrackPbsUrl: '/api/player/track-pbs',
        playerPbGhostUrl: '/api/player/pb-ghost',
      },
      fetchImpl,
    });

    const firstRequest = service.getForChallenge('daily-1');
    const secondRequest = service.getForChallenge('daily-2');
    resolvers.get('daily-2')({
      ok: true,
      json: async () => ({ personalBest: { bestTimeMs: 2200 } }),
    });
    await expect(secondRequest).resolves.toEqual({ bestTimeMs: 2200 });

    const canonical = {
      bestTimeMs: 1500,
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [100, 100, 0],
      },
    };
    service.installForChallenge('daily-1', canonical);
    resolvers.get('daily-1')({
      ok: true,
      json: async () => ({ personalBest: { bestTimeMs: 1800 } }),
    });
    await expect(firstRequest).resolves.toBe(null);
    await expect(service.getForChallenge('daily-1')).resolves.toBe(canonical);
  });
});
