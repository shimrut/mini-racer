import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKS } from "../game/track/tracks.js";
import {
  createRedisChallengeEntryHashKey,
  createRedisChallengeLeaderboardKey,
  encodeDailyGpLeaderboardScore,
} from "../src/server/daily-gp-model.ts";

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

  async hScan(key, cursor, _pattern, count = 10) {
    this._isExpired(key);
    const entries = [...(this.hashes.get(key)?.entries() || [])];
    const start = Math.max(0, cursor);
    const end = Math.min(entries.length, start + count);
    return {
      cursor: end < entries.length ? end : 0,
      fieldValues: entries.slice(start, end).map(([field, value]) => ({ field, value })),
    };
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

  async zRange(key, start, stop) {
    this._isExpired(key);
    const ordered = [...(this.sortedSets.get(key)?.entries() || [])]
      .sort((a, b) => {
        if (a[1] === b[1]) return a[0].localeCompare(b[0]);
        return a[1] - b[1];
      });
    return ordered.slice(start, stop + 1).map(([member, score]) => ({ member, score }));
  }

  async watch() {
    const commands = [];
    return {
      multi: async () => {},
      unwatch: async () => {},
      del: async (...args) => {
        commands.push(() => this.del(...args));
      },
      hSet: async (...args) => {
        commands.push(() => this.hSet(...args));
      },
      zAdd: async (...args) => {
        commands.push(() => this.zAdd(...args));
      },
      incrBy: async (...args) => {
        commands.push(() => this.incrBy(...args));
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
  redisCompressed: redis,
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
  getServerDailyGpSnapshot,
  getServerDailyGpChallenge,
  getServerPlayerPbGhost,
  getServerPlayerBootstrap,
  getServerPlayerTrackPbSummaries,
  submitServerDailyGpRun,
  updateServerPlayerIdentity,
  updateServerPlayerPreferences,
} = await import("../src/server/daily-gp-store.ts");
const { mintGuestPlayerToken } = await import("../src/server/player-token.ts");
const { validateDailyGpReplayDetailed } = await import("../src/server/replay-validator.ts");

const validateDailyGpReplayDetailedMock = vi.mocked(validateDailyGpReplayDetailed);

const playerPreferences = {
  carSkin: "assets/cars/mr_mr_red.webp",
  trailId: "gold",
  musicEnabled: false,
  carAudioEnabled: true,
  crashAutoRestartEnabled: false,
  crashRestartDelaySec: 0.8,
  pbGhostEnabled: true,
};

function findPlayerProfileEntry(playerId) {
  for (const [key, value] of redis.strings.entries()) {
    if (!key.startsWith("dailygp:player-profile:")) continue;
    try {
      if (JSON.parse(value).playerId === playerId) return { key, value };
    } catch (_error) {
    }
  }
  return null;
}

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
      rulesRevision: challenge.rulesRevision,
      targetLapNumber: challenge.objectiveParams.lapCount,
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
    expect(result.body.reason).toBe("no_finish");
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

  it("creates a guest profile exactly once across concurrent bootstraps", async () => {
    const guestPlayerId = "guest-concurrent-bootstrap";
    const results = await Promise.all([
      getServerPlayerBootstrap({ playerId: guestPlayerId, redditUsername: null }),
      getServerPlayerBootstrap({ playerId: guestPlayerId, redditUsername: null }),
    ]);

    for (const result of results) {
      expect(result.playerId).toBe(`guest:${guestPlayerId}`);
      expect(result.guestToken).toBeTruthy();
    }
    expect(results[0].firstSeenAt).toBe(results[1].firstSeenAt);
  });

  it("re-authorizes an existing guest profile instead of stranding it", async () => {
    const guestPlayerId = "guest-existing-bootstrap";
    const bootstrap = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    await updateServerPlayerPreferences({
      playerId: guestPlayerId,
      guestToken: bootstrap.guestToken,
      playerPreferences,
    });
    const storedBefore = JSON.parse(
      findPlayerProfileEntry(`guest:${guestPlayerId}`).value,
    );

    const recovered = await getServerPlayerBootstrap({ playerId: guestPlayerId });

    expect(recovered.playerId).toBe(`guest:${guestPlayerId}`);
    expect(recovered.guestToken).toBeTruthy();

    const storedAfter = JSON.parse(
      findPlayerProfileEntry(`guest:${guestPlayerId}`).value,
    );
    expect(storedAfter.firstSeenAt).toBe(storedBefore.firstSeenAt);
    expect(storedAfter.preferences).toMatchObject({
      trailId: "gold",
      musicEnabled: false,
      crashRestartDelaySec: 0.8,
    });
  });

  it("re-issues a guest token that authorizes later writes", async () => {
    const guestPlayerId = "guest-reissued-token";
    await getServerPlayerBootstrap({ playerId: guestPlayerId });

    const recovered = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    const reissued = await updateServerPlayerPreferences({
      playerId: guestPlayerId,
      guestToken: recovered.guestToken,
      playerPreferences,
    });

    expect(reissued.playerId).toBe(`guest:${guestPlayerId}`);
    expect(reissued.playerPreferences).toMatchObject({ trailId: "gold" });
  });

  it("recreates an expired profile when the guest token still verifies", async () => {
    const guestPlayerId = "guest-expired-profile";
    const first = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    const stored = findPlayerProfileEntry(`guest:${guestPlayerId}`);
    await redis.del(stored.key);

    const recovered = await getServerPlayerBootstrap({
      playerId: guestPlayerId,
      guestToken: first.guestToken,
    });

    expect(recovered.playerId).toBe(`guest:${guestPlayerId}`);
    expect(recovered.guestToken).toBe(first.guestToken);
    expect(findPlayerProfileEntry(`guest:${guestPlayerId}`)).not.toBeNull();
  });

  it("protects an existing malformed guest profile from tokenless replacement", async () => {
    const guestPlayerId = "guest-malformed-profile";
    await getServerPlayerBootstrap({ playerId: guestPlayerId });
    const stored = findPlayerProfileEntry(`guest:${guestPlayerId}`);
    redis.strings.set(stored.key, "not-json");

    const unauthorized = await getServerPlayerBootstrap({ playerId: guestPlayerId });

    expect(unauthorized.playerId).toBeNull();
    expect(unauthorized.guestToken).toBeNull();
    expect(redis.strings.get(stored.key)).toBe("not-json");
  });

  it("requires the matching guest token for profile mutations", async () => {
    const guestPlayerId = "guest-protected-mutations";
    const bootstrap = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    const otherToken = await mintGuestPlayerToken("some-other-guest");

    const unsignedPreferences = await updateServerPlayerPreferences({
      playerId: guestPlayerId,
      playerPreferences,
    });
    const invalidPreferences = await updateServerPlayerPreferences({
      playerId: guestPlayerId,
      guestToken: "invalid-token",
      playerPreferences,
    });
    const mismatchedIdentity = await updateServerPlayerIdentity({
      playerId: guestPlayerId,
      guestToken: otherToken,
      leaderboardIdentity: "reddit",
    });
    const authorizedPreferences = await updateServerPlayerPreferences({
      playerId: guestPlayerId,
      guestToken: bootstrap.guestToken,
      playerPreferences,
    });

    expect(unsignedPreferences.playerId).toBeNull();
    expect(invalidPreferences.playerId).toBeNull();
    expect(mismatchedIdentity.playerId).toBeNull();
    expect(authorizedPreferences).toMatchObject({
      playerId: `guest:${guestPlayerId}`,
      guestToken: bootstrap.guestToken,
      playerPreferences,
    });
  });

  it("keeps snapshots public but personalizes them only with a valid guest token", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-snapshot-authorization";
    const canonicalPlayerId = `guest:${guestPlayerId}`;
    const bootstrap = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    const entry = {
      playerId: canonicalPlayerId,
      trackKey: challenge.trackKey,
      bestTimeMs: 12345,
      updatedAt: new Date().toISOString(),
      completedLaps: null,
      checkpointTimesSec: null,
      validationMethod: "strict-replay",
      strictReplayFailureReason: null,
    };
    await redis.hSet(createRedisChallengeEntryHashKey(challenge.id), {
      [canonicalPlayerId]: JSON.stringify(entry),
    });
    await redis.zAdd(createRedisChallengeLeaderboardKey(challenge.id), {
      member: canonicalPlayerId,
      score: encodeDailyGpLeaderboardScore(entry.bestTimeMs),
    });
    const storedBefore = findPlayerProfileEntry(canonicalPlayerId);

    const publicSnapshot = await getServerDailyGpSnapshot({
      challengeId: challenge.id,
      playerId: guestPlayerId,
    });
    const invalidSnapshot = await getServerDailyGpSnapshot({
      challengeId: challenge.id,
      playerId: guestPlayerId,
      guestToken: "invalid-token",
    });
    const storedAfterPublicReads = redis.strings.get(storedBefore.key);
    const privateSnapshot = await getServerDailyGpSnapshot({
      challengeId: challenge.id,
      playerId: guestPlayerId,
      guestToken: bootstrap.guestToken,
    });

    expect(publicSnapshot.topRows).toHaveLength(1);
    expect(publicSnapshot.topRows[0].isCurrentPlayer).toBe(false);
    expect(publicSnapshot.currentPlayerRow).toBeNull();
    expect(publicSnapshot.playerRank).toBeNull();
    expect(invalidSnapshot.currentPlayerRow).toBeNull();
    expect(storedAfterPublicReads).toBe(storedBefore.value);
    expect(privateSnapshot.currentPlayerRow).toMatchObject({
      bestTimeMs: 12345,
      isCurrentPlayer: true,
    });
    expect(privateSnapshot.playerRank).toBe(1);
  });

  it("lazily seeds a time-only track PB from a retained verified result", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-pb-migration";
    const canonicalPlayerId = `guest:${guestPlayerId}`;
    const bootstrap = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    await redis.hSet(createRedisChallengeEntryHashKey(challenge.id), {
      [canonicalPlayerId]: JSON.stringify({
        playerId: canonicalPlayerId,
        trackKey: challenge.trackKey,
        bestTimeMs: 4321,
        updatedAt: "2026-07-16T12:00:00.000Z",
        completedLaps: null,
        checkpointTimesSec: [1.2, 2.4],
        validationMethod: "strict-replay",
        strictReplayFailureReason: null,
      }),
    });

    const summaries = await getServerPlayerTrackPbSummaries({
      challengeIds: [challenge.id],
      playerId: guestPlayerId,
      guestToken: bootstrap.guestToken,
    });
    const full = await getServerPlayerPbGhost({
      challengeId: challenge.id,
      playerId: guestPlayerId,
      guestToken: bootstrap.guestToken,
    });

    expect(summaries.trackPbs[challenge.id]).toEqual({
      trackKey: challenge.trackKey,
      bestTimeMs: 4321,
      checkpointTimesSec: [1.2, 2.4],
      lapCompletionTimesSec: null,
      ghostAvailable: false,
    });
    expect(full.personalBest).toMatchObject({
      bestTimeMs: 4321,
      checkpointTimesSec: [1.2, 2.4],
      lapCompletionTimesSec: null,
      ghost: null,
    });
  });

  it("keeps the guest rate limit when the client rotates its signed player identity", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-rate-limit-check";
    const guestToken = await mintGuestPlayerToken(guestPlayerId);
    const requestRateLimitIdentity = "stable-reddit-request-identity";

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await submitServerDailyGpRun({
        playerId: guestPlayerId,
        guestToken,
        challengeId: challenge.id,
        trackKey: challenge.trackKey,
        replay: { targetLapNumber: 1, inputs: [] },
        requestRateLimitIdentity,
      });
      expect(result.status).toBe(422);
    }

    const rotatedGuestPlayerId = "rotated-guest-rate-limit-check";
    const rotatedGuestToken = await mintGuestPlayerToken(rotatedGuestPlayerId);
    const throttled = await submitServerDailyGpRun({
      playerId: rotatedGuestPlayerId,
      guestToken: rotatedGuestToken,
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      replay: { targetLapNumber: 1, inputs: [] },
      requestRateLimitIdentity,
    });

    expect(throttled.status).toBe(429);
    expect(throttled.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps signed-in Reddit submissions keyed to the account identity", async () => {
    const challenge = await getServerDailyGpChallenge();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await submitServerDailyGpRun({
        redditUsername: "StableRedditUser",
        challengeId: challenge.id,
        trackKey: challenge.trackKey,
        replay: { targetLapNumber: 1, inputs: [] },
        requestRateLimitIdentity: `changing-request-${attempt}`,
      });
      expect(result.status).toBe(422);
    }

    const throttled = await submitServerDailyGpRun({
      redditUsername: "StableRedditUser",
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      replay: { targetLapNumber: 1, inputs: [] },
      requestRateLimitIdentity: "another-changing-request",
    });

    expect(throttled.status).toBe(429);
  });

  it("falls back to the authorized guest identity when request context is unavailable", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-rate-limit-fallback";
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
    expect(first.body.improved).toBe(true);
    expect(first.body.bestTimeMs).toBe(3000);
    expect(first.body.trackBestTimeMs).toBe(3000);
    expect(first.body.trackPbImproved).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.improved).toBe(false);
    expect(second.body.bestTimeMs).toBe(3000);
    expect(second.body.trackBestTimeMs).toBe(3000);
    expect(second.body.trackPbImproved).toBe(false);
    expect(second.body.trackPbPersistenceStatus).toBe("unchanged");
    expect(second.body.trackPersonalBest).toEqual(first.body.trackPersonalBest);
    expect(second.body.validationMethod).toBe("strict-replay");
  });

  it("trims whitespace from a guest playerId when claiming a new profile", async () => {
    const bootstrap = await getServerPlayerBootstrap({ playerId: "  guest-with-space  " });

    expect(bootstrap.playerId).toBe("guest:guest-with-space");
  });

  it("does not seed a track PB from an unverified legacy leaderboard entry", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-legacy-unverified";
    const canonicalPlayerId = `guest:${guestPlayerId}`;
    const bootstrap = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    await redis.hSet(createRedisChallengeEntryHashKey(challenge.id), {
      [canonicalPlayerId]: JSON.stringify({
        playerId: canonicalPlayerId,
        trackKey: challenge.trackKey,
        bestTimeMs: 5000,
        updatedAt: "2026-07-16T12:00:00.000Z",
        completedLaps: null,
        checkpointTimesSec: null,
      }),
    });

    const summaries = await getServerPlayerTrackPbSummaries({
      challengeIds: [challenge.id],
      playerId: guestPlayerId,
      guestToken: bootstrap.guestToken,
    });
    const full = await getServerPlayerPbGhost({
      challengeId: challenge.id,
      playerId: guestPlayerId,
      guestToken: bootstrap.guestToken,
    });

    expect(summaries.trackPbs[challenge.id]).toBeNull();
    expect(full.personalBest).toBeNull();
  });

  it("trims a supplied request rate-limit identity before scoping the guest rate limit", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-rate-trim";
    const guestToken = await mintGuestPlayerToken(guestPlayerId);

    await submitServerDailyGpRun({
      playerId: guestPlayerId,
      guestToken,
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      requestRateLimitIdentity: "  padded-identity  ",
      replay: { targetLapNumber: 1, inputs: [] },
    });

    const rateLimitKey = `dailygp:submit-rate-limit:${challenge.id}:request:padded-identity`;
    expect(redis.strings.has(rateLimitKey)).toBe(true);
  });

  it("ignores a request rate-limit identity that is only whitespace", async () => {
    const challenge = await getServerDailyGpChallenge();
    const guestPlayerId = "guest-blank-rate-identity";
    const guestToken = await mintGuestPlayerToken(guestPlayerId);

    await submitServerDailyGpRun({
      playerId: guestPlayerId,
      guestToken,
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      requestRateLimitIdentity: "   ",
      replay: { targetLapNumber: 1, inputs: [] },
    });

    const fallbackKey = `dailygp:submit-rate-limit:${challenge.id}:guest:${guestPlayerId}`;
    expect(redis.strings.has(fallbackKey)).toBe(true);
  });

  it("returns nearby leaderboard rows when the signed-in player is off the requested page", async () => {
    const challenge = await getServerDailyGpChallenge();
    const members = Array.from({ length: 20 }, (_, index) => {
      const playerId = `reddit:page-rank-${index + 1}`;
      return {
        playerId,
        bestTimeMs: 15000 + index,
      };
    });
    for (const [index, entry] of members.entries()) {
      await redis.hSet(createRedisChallengeEntryHashKey(challenge.id), {
        [entry.playerId]: JSON.stringify({
          ...entry,
          trackKey: challenge.trackKey,
          updatedAt: "2026-07-16T12:00:00.000Z",
          completedLaps: null,
          checkpointTimesSec: null,
          validationMethod: "strict-replay",
          strictReplayFailureReason: null,
        }),
      });
      await redis.zAdd(createRedisChallengeLeaderboardKey(challenge.id), {
        member: entry.playerId,
        score: encodeDailyGpLeaderboardScore(entry.bestTimeMs),
      });
    }

    const snapshot = await getServerDailyGpSnapshot({
      challengeId: challenge.id,
      redditUsername: "Page-Rank-15",
      offset: 0,
      limit: 10,
    });

    expect(snapshot.topRows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(snapshot.currentPlayerRow).toMatchObject({
      rank: 15,
      isCurrentPlayer: true,
      bestTimeMs: 15014,
    });
    expect(snapshot.nearbyRows.map((row) => row.rank)).toEqual([13, 14, 15, 16, 17]);
    expect(snapshot.playerRank).toBe(15);
  });

  it("rejects preference updates when the payload is not an object", async () => {
    const result = await updateServerPlayerPreferences({
      redditUsername: "Prefs-Not-Object",
      playerPreferences: "not-an-object",
    });

    expect(result.playerPreferences).toBeNull();
    expect(result.playerId).toBe("reddit:prefs-not-object");
  });

  it("returns the default identity when identity updates are unauthorized", async () => {
    const result = await updateServerPlayerIdentity({
      playerId: "guest-without-token",
      leaderboardIdentity: "reddit",
    });

    expect(result).toEqual({
      playerId: null,
      guestToken: null,
      leaderboardIdentity: "constructed",
    });
  });

  it("returns an empty bootstrap payload when guest token verification fails", async () => {
    const payload = await getServerPlayerBootstrap({
      playerId: "guest-invalid-token",
      guestToken: "invalid-token",
    });

    expect(payload).toMatchObject({
      playerId: null,
      guestToken: null,
      playerPreferences: null,
      hasAnyData: false,
      isReturningPlayer: false,
      firstSeenAt: null,
      lastSeenAt: null,
    });
  });

  it("resolves today's playable challenge even when it has not been written to the ledger yet", async () => {
    const { getServerDailyGpPlayableChallenge } = await import("../src/server/daily-gp-store.ts");
    const challenge = await getServerDailyGpChallenge();
    const playable = await getServerDailyGpPlayableChallenge(challenge.id);

    expect(playable).toMatchObject({
      id: challenge.id,
      trackKey: challenge.trackKey,
    });
  });

  it("trims a padded guest token before authorizing preference updates", async () => {
    const guestPlayerId = "guest-token-trim";
    const bootstrap = await getServerPlayerBootstrap({ playerId: guestPlayerId });
    const paddedToken = `  ${bootstrap.guestToken}  `;

    const updated = await updateServerPlayerPreferences({
      playerId: guestPlayerId,
      guestToken: paddedToken,
      playerPreferences,
    });

    expect(updated).toMatchObject({
      playerId: `guest:${guestPlayerId}`,
      guestToken: bootstrap.guestToken,
      playerPreferences,
    });
  });

  it("keeps nearby rows empty when the current player sits on the last rank of the requested page", async () => {
    const challenge = await getServerDailyGpChallenge();
    const members = Array.from({ length: 12 }, (_, index) => ({
      member: `reddit:page-edge-${index + 1}`,
      score: 50000 + index,
    }));
    for (const member of members) {
      await redis.hSet(createRedisChallengeEntryHashKey(challenge.id), {
        [member.member]: JSON.stringify({
          playerId: member.member,
          trackKey: challenge.trackKey,
          bestTimeMs: member.score,
          updatedAt: "2026-07-16T12:00:00.000Z",
          completedLaps: null,
          checkpointTimesSec: null,
          validationMethod: "strict-replay",
          strictReplayFailureReason: null,
        }),
      });
      await redis.zAdd(createRedisChallengeLeaderboardKey(challenge.id), {
        member: member.member,
        score: encodeDailyGpLeaderboardScore(member.score),
      });
    }

    const snapshot = await getServerDailyGpSnapshot({
      challengeId: challenge.id,
      redditUsername: "Page-Edge-10",
      offset: 0,
      limit: 10,
    });

    expect(snapshot.currentPlayerRow).toMatchObject({
      rank: 10,
      isCurrentPlayer: true,
    });
    expect(snapshot.nearbyRows).toEqual([]);
    expect(snapshot.hasMore).toBe(true);
    expect(snapshot.nextOffset).toBe(10);
  });
});
