import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKS } from "../game/track/tracks.js";

class RedisTestDouble {
  constructor() {
    this.reset();
  }

  reset() {
    this.strings = new Map();
    this.hashes = new Map();
    this.sortedSets = new Map();
    this.expiresAtSeconds = new Map();
  }

  _nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  _isExpired(key) {
    const expiresAt = this.expiresAtSeconds.get(key);
    if (!Number.isFinite(expiresAt)) {
      return false;
    }
    if (expiresAt > this._nowSeconds()) {
      return false;
    }
    this.expiresAtSeconds.delete(key);
    this.strings.delete(key);
    this.hashes.delete(key);
    this.sortedSets.delete(key);
    return true;
  }

  async get(key) {
    this._isExpired(key);
    return this.strings.get(key);
  }

  async mGet(keys) {
    return Promise.all(keys.map((key) => this.get(key) ?? null));
  }

  async set(key, value, options = {}) {
    this._isExpired(key);
    if (options?.nx && this.strings.has(key)) {
      return "";
    }
    if (options?.xx && !this.strings.has(key)) {
      return "";
    }
    this.strings.set(key, value);
    if (options?.expiration instanceof Date) {
      this.expiresAtSeconds.set(key, Math.floor(options.expiration.getTime() / 1000));
    }
    return "OK";
  }

  async del(key) {
    this.strings.delete(key);
    this.hashes.delete(key);
    this.sortedSets.delete(key);
    this.expiresAtSeconds.delete(key);
  }

  async incrBy(key, value) {
    this._isExpired(key);
    const nextValue = Number(this.strings.get(key) || 0) + value;
    this.strings.set(key, String(nextValue));
    return nextValue;
  }

  async expire(key, seconds) {
    this.expiresAtSeconds.set(key, this._nowSeconds() + seconds);
  }

  async expireTime(key) {
    this._isExpired(key);
    return this.expiresAtSeconds.get(key) || -1;
  }

  async hGet(key, field) {
    this._isExpired(key);
    return this.hashes.get(key)?.get(field);
  }

  async hDel(key, fields) {
    this._isExpired(key);
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) {
      if (hash.delete(field)) removed += 1;
    }
    return removed;
  }

  async hSet(key, fieldValues) {
    this._isExpired(key);
    const hash = this.hashes.get(key) || new Map();
    this.hashes.set(key, hash);
    let added = 0;
    for (const [field, value] of Object.entries(fieldValues)) {
      if (!hash.has(field)) {
        added += 1;
      }
      hash.set(field, value);
    }
    return added;
  }

  async hSetNX(key, field, value) {
    this._isExpired(key);
    const hash = this.hashes.get(key) || new Map();
    if (hash.has(field)) {
      return 0;
    }
    this.hashes.set(key, hash);
    hash.set(field, value);
    return 1;
  }

  async hMGet(key, fields) {
    this._isExpired(key);
    const hash = this.hashes.get(key) || new Map();
    return fields.map((field) => hash.get(field) ?? null);
  }

  async hGetAll(key) {
    this._isExpired(key);
    return Object.fromEntries(this.hashes.get(key)?.entries() || []);
  }

  async zAdd(key, ...members) {
    this._isExpired(key);
    const set = this.sortedSets.get(key) || new Map();
    this.sortedSets.set(key, set);
    for (const member of members) {
      set.set(member.member, member.score);
    }
    return members.length;
  }

  async zCard(key) {
    this._isExpired(key);
    return this.sortedSets.get(key)?.size || 0;
  }

  async zRank(key, member) {
    this._isExpired(key);
    const set = this.sortedSets.get(key);
    if (!set || !set.has(member)) {
      return undefined;
    }
    const ordered = [...set.entries()].sort((a, b) => {
      if (a[1] === b[1]) {
        return a[0].localeCompare(b[0]);
      }
      return a[1] - b[1];
    });
    const index = ordered.findIndex(([candidate]) => candidate === member);
    return index >= 0 ? index : undefined;
  }

  async watch() {
    const commands = [];
    return {
      multi: async () => {},
      hSet: async (...args) => {
        commands.push(() => this.hSet(...args));
      },
      zAdd: async (...args) => {
        commands.push(() => this.zAdd(...args));
      },
      expire: async (...args) => {
        commands.push(() => this.expire(...args));
      },
      exec: async () => {
        const results = [];
        for (const command of commands) {
          results.push(await command());
        }
        return results;
      },
    };
  }
}

const redis = new RedisTestDouble();
let actualValidateDailyGpReplayDetailed = null;

vi.mock("@devvit/redis", () => ({
  redis,
}));

vi.mock("../src/server/replay-validator.ts", async () => {
  const actual = await vi.importActual("../src/server/replay-validator.ts");
  actualValidateDailyGpReplayDetailed = actual.validateDailyGpReplayDetailed;
  return {
    ...actual,
    validateDailyGpReplayDetailed: vi.fn(actual.validateDailyGpReplayDetailed),
  };
});

const {
  getServerDailyGpChallenge,
  getServerPlayerBootstrap,
  submitServerDailyGpRun,
} = await import("../src/server/daily-gp-store.ts");
const { mintGuestPlayerToken } = await import("../src/server/player-token.ts");
const { validateDailyGpReplayDetailed } = await import("../src/server/replay-validator.ts");

const validateDailyGpReplayDetailedMock = vi.mocked(validateDailyGpReplayDetailed);

describe("daily-gp-store submission hardening", () => {
  beforeEach(() => {
    redis.reset();
    validateDailyGpReplayDetailedMock.mockReset();
    validateDailyGpReplayDetailedMock.mockImplementation(actualValidateDailyGpReplayDetailed);
  });

  it("rejects non-finishing replays even if the old fallback would have accepted them", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-security-check";
    const guestToken = await mintGuestPlayerToken(guestPlayerId);
    const forgedReplay = {
      targetLapNumber: 1,
      inputs: [{ frames: 120, left: false, right: false, relaunchDelay: false }],
    };
    const fakeCheckpointTimes = Array.from(
      { length: TRACKS[challenge.trackKey].checkpoints.length },
      (_, index) => 0.25 + (index * 0.5),
    );

    const result = await submitServerDailyGpRun({
      playerId: guestPlayerId,
      guestToken,
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      replay: forgedReplay,
      bestTime: 2,
      checkpointTimesSec: fakeCheckpointTimes,
    });

    expect(result.status).toBe(422);
    expect(result.body.accepted).toBe(false);
    expect(result.body.reason).toBe("crashed");
  });

  it("returns a stable guest token during bootstrap", async () => {
    const guestPlayerId = "guest-bootstrap-check";
    const firstBootstrap = await getServerPlayerBootstrap({
      playerId: guestPlayerId,
      redditUsername: null,
    });
    const secondBootstrap = await getServerPlayerBootstrap({
      playerId: null,
      guestToken: firstBootstrap.guestToken,
      redditUsername: null,
    });

    expect(firstBootstrap.guestToken).toBeTruthy();
    expect(secondBootstrap.guestToken).toBe(firstBootstrap.guestToken);
    expect(secondBootstrap.playerId).toBe(firstBootstrap.playerId);
  });

  it("rate limits repeated guest submissions", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-rate-limit-check";
    const guestToken = await mintGuestPlayerToken(guestPlayerId);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await submitServerDailyGpRun({
        playerId: guestPlayerId,
        guestToken,
        challengeId: challenge.id,
        trackKey: challenge.trackKey,
        replay: { targetLapNumber: 1, inputs: [] },
      });
      expect(result.status).toBe(422);
    }

    const throttled = await submitServerDailyGpRun({
      playerId: guestPlayerId,
      guestToken,
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      replay: { targetLapNumber: 1, inputs: [] },
    });

    expect(throttled.status).toBe(429);
    expect(throttled.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps the faster stored time when a slower replay arrives later", async () => {
    validateDailyGpReplayDetailedMock
      .mockReturnValueOnce({
        ok: true,
        run: {
          bestTimeSec: 3,
          bestTimeMs: 3000,
          completedLaps: 1,
          checkpointTimesSec: [0.8, 1.6],
          method: "finish",
        },
      })
      .mockReturnValueOnce({
        ok: true,
        run: {
          bestTimeSec: 3.5,
          bestTimeMs: 3500,
          completedLaps: 1,
          checkpointTimesSec: [0.9, 1.8],
          method: "finish",
        },
      });

    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-fastest-time";
    const guestToken = await mintGuestPlayerToken(guestPlayerId);
    const replay = {
      targetLapNumber: 1,
      inputs: [{ frames: 180, left: false, right: false, relaunchDelay: false }],
    };

    const first = await submitServerDailyGpRun({
      playerId: guestPlayerId,
      guestToken,
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      replay,
    });
    const second = await submitServerDailyGpRun({
      playerId: guestPlayerId,
      guestToken,
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      replay,
    });

    expect(first.status).toBe(200);
    expect(first.body.bestTimeMs).toBe(3000);
    expect(second.status).toBe(200);
    expect(second.body.bestTimeMs).toBe(3000);
    expect(second.body.validationMethod).toBe("strict-replay");
  });
});
