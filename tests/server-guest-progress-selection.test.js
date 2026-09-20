import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();

function guestProgressSelectionKey(guestPlayerId, redditPlayerId) {
  return `dailygp:guest-progress-selection:v1:${createHash("sha256")
    .update(`${guestPlayerId}:${redditPlayerId}`, "utf8")
    .digest("base64url")}`;
}

vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: redis,
}));

const {
  getGuestProgressSelection,
  getServerDailyGpChallenge,
  getServerDailyGpPlaylist,
  selectGuestProgress,
} = await import("../src/server/daily-gp-store.ts");
const { startServerCampaignRace } = await import("../src/server/campaign-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign-progress-key.js");
const { recordCompletedRace } = await import("../src/server/car-unlock-store.ts");
const { mintGuestPlayerToken } = await import("../src/server/player-token.ts");
const {
    guestProgressSelectionAccountPendingKey,
    guestProgressSelectionPendingKey,
    isPlayerProgressSelectionPending,
} = await import("../src/server/guest-retirement.ts");
const { resolveAuthorizedPlayerIdentity } = await import("../src/server/competition-identity.ts");
const { discardGuestCampaignProgress } = await import("../src/server/campaign-store.ts");
const { discardGuestDailyProgress } = await import("../src/server/daily-gp-store.ts");
const { toDailyCompetition } = await import("../src/server/competition.ts");
const { upsertPlayerTrackPersonalBest } = await import("../src/server/pb-ghost-store.ts");
const { TRACKS } = await import("../game/track/tracks.js");
const { CAMPAIGN_STAGES } = await import("../game/campaign/manifest.js");
const { toCampaignCompetition } = await import("../src/server/competition.ts");

afterEach(() => {
  vi.restoreAllMocks();
});

const REDIS_METHODS = [
  "get", "mGet", "set", "del", "incrBy", "expire", "expireTime",
  "hGet", "hDel", "hSet", "hSetNX", "hMGet", "hGetAll", "hScan",
  "zAdd", "zCard", "zRank", "zScore", "zRem", "zRange", "watch",
];

let redisCalls = 0;

function countRedisCalls() {
  redisCalls = 0;
  for (const method of REDIS_METHODS) {
    const original = RedisTestDouble.prototype[method];
    redis[method] = async function counted(...args) {
      redisCalls += 1;
      return original.apply(this, args);
    };
  }
}

function stopCountingRedisCalls() {
  for (const method of REDIS_METHODS) delete redis[method];
}

async function seedSevenDayPlaylist() {
  const realNow = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let dayOffset = 6; dayOffset >= 0; dayOffset -= 1) {
    vi.setSystemTime(new Date(realNow - (dayOffset * 86400000)));
    await getServerDailyGpChallenge();
  }
  vi.setSystemTime(new Date(realNow));
  vi.useRealTimers();
}

describe("guest progress selection", () => {
  beforeEach(() => {
    redis.reset();
    stopCountingRedisCalls();
  });

  it("reports exact current-playlist progress for a guest that owns runs", async () => {
    await seedSevenDayPlaylist();
    expect((await getServerDailyGpPlaylist()).length).toBe(7);
    // Every accepted run records this event, so it is the cheap proof the guest owns progress.
    await recordCompletedRace("guest:cheap-evidence");

    countRedisCalls();
    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:cheap-evidence",
      redditPlayerId: "reddit:cheap-evidence",
    });
    stopCountingRedisCalls();

    expect(selection.required).toBe(true);
    expect(selection.guestHasProgress).toBe(true);
    expect(selection.guestSummary.dailySavedResults).toBe(0);
    expect(selection.guestSummary.dailyPlaylistSize).toBe(7);
    // The summary reads the bounded seven-day playlist, not the retained history.
    expect(redisCalls).toBeLessThan(60);
  });

  it("confirms an empty-looking guest against the playlist before it can be retired", async () => {
    await seedSevenDayPlaylist();

    countRedisCalls();
    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:no-evidence",
      redditPlayerId: "reddit:no-evidence",
    });
    stopCountingRedisCalls();

    expect(selection.required).toBe(false);
    expect(selection.guestHasProgress).toBe(false);
    // Retiring the guest destroys its runs, so this answer is never given on cheap evidence alone.
    expect(redisCalls).toBeGreaterThan(14);
  });

  it("reports Campaign progress the guest never completed a race for", async () => {
    await seedSevenDayPlaylist();
    const guestToken = await mintGuestPlayerToken("campaign-only");
    await startServerCampaignRace({
      raceId: "numbered-v1-00",
      playerId: "campaign-only",
      guestToken,
    });

    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:campaign-only",
      redditPlayerId: "reddit:campaign-only",
    });

    expect(selection.required).toBe(true);
    expect(selection.guestSummary).toEqual({
      hasDailyResults: false,
      campaignResults: 0,
      campaignUnlockedTracks: 1,
      campaignTotalStages: 16,
      dailySavedResults: 0,
      dailyPlaylistSize: 7,
      carsUnlocked: 14,
      carsTotal: 23,
      unlocks: false,
    });
  });

  it("counts an account whose only record is a Daily result as having progress", async () => {
    await seedSevenDayPlaylist();
    const accountPlayerId = "reddit:selection-daily-only";
    // No profile flag and no Garage reward: both background writes of that run failed.
    const [challenge] = await getServerDailyGpPlaylist();
    const competition = toDailyCompetition(challenge);
    await redis.hSet(competition.entryHashKey, {
      [accountPlayerId]: JSON.stringify({
        playerId: accountPlayerId,
        trackKey: challenge.trackKey,
        bestTimeMs: 31_234,
        updatedAt: new Date().toISOString(),
        completedLaps: challenge.objectiveParams.lapCount,
        checkpointTimesSec: null,
        validationMethod: "strict-replay",
        strictReplayFailureReason: null,
      }),
    });
    await redis.zAdd(competition.leaderboardKey, { member: accountPlayerId, score: 31_234 });
    await recordCompletedRace("guest:selection-daily-only");

    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:selection-daily-only",
      redditPlayerId: accountPlayerId,
    });

    expect(selection.accountHasProgress).toBe(true);
    expect(selection.accountSummary).toMatchObject({ dailySavedResults: 1, hasDailyResults: true });
  });

  it("reports unlocked Campaign tracks separately from completed results", async () => {
    await seedSevenDayPlaylist();
    const accountPlayerId = "reddit:selection-unlocked-tracks";
    await redis.set(campaignProgressKey(accountPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-07-27T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-07-27T09:30:00.000Z",
        },
        "numbered-v1-01": {
          raceId: "numbered-v1-01",
          trackKey: "numberOne",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 13_000,
          medal: "silver",
          checkpointTimesSec: [4.4, 10.1],
          updatedAt: "2026-07-27T09:45:00.000Z",
        },
      },
      updatedAt: "2026-07-27T09:45:00.000Z",
    }));
    await recordCompletedRace("guest:selection-unlocked-tracks");

    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:selection-unlocked-tracks",
      redditPlayerId: accountPlayerId,
    });

    expect(selection.accountSummary.campaignResults).toBe(2);
    expect(selection.accountSummary.campaignUnlockedTracks).toBe(3);
    expect(selection.accountSummary.campaignTotalStages).toBe(16);
    expect(selection.accountSummary.dailySavedResults).toBe(0);
    expect(selection.accountSummary.dailyPlaylistSize).toBe(7);
    expect(selection.accountSummary.carsUnlocked).toBe(15);
    expect(selection.accountSummary.carsTotal).toBe(23);
  });

  it("repairs an account Campaign result before counting the selection summary", async () => {
    const accountPlayerId = "reddit:selection-repair";
    await redis.set(campaignProgressKey(accountPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-07-27T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-07-27T09:30:00.000Z",
        },
        "numbered-v1-01": {
          raceId: "numbered-v1-01",
          trackKey: "numberOne",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 13_000,
          medal: "silver",
          checkpointTimesSec: [4.4, 10.1],
          updatedAt: "2026-07-27T09:45:00.000Z",
        },
      },
      updatedAt: "2026-07-27T09:45:00.000Z",
    }));
    const missingResultEntryKey = "campaign:numbered-v1:leaderboard:numbered-v1-02:entries";
    redis.hashes.set(missingResultEntryKey, new Map([[
      accountPlayerId,
      JSON.stringify({
        playerId: accountPlayerId,
        trackKey: "numberTwo",
        bestTimeMs: 12_345,
        updatedAt: "2026-07-27T10:00:00.000Z",
        completedLaps: 1,
        checkpointTimesSec: [4.2, 9.8],
        validationMethod: "strict-replay",
      }),
    ]]));
    await recordCompletedRace("guest:selection-repair");

    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:selection-repair",
      redditPlayerId: accountPlayerId,
    });

    expect(selection.accountSummary.campaignResults).toBe(3);
    expect(selection.accountSummary.campaignUnlockedTracks).toBeGreaterThanOrEqual(3);
  });

  it("repairs an account with only retained Campaign entries before counting", async () => {
    const accountPlayerId = "reddit:selection-entry-only";
    const entryKey = "campaign:numbered-v1:leaderboard:numbered-v1-02:entries";
    redis.hashes.set(entryKey, new Map([[
      accountPlayerId,
      JSON.stringify({
        playerId: accountPlayerId,
        trackKey: "numberTwo",
        bestTimeMs: 12_345,
        updatedAt: "2026-07-27T10:00:00.000Z",
        completedLaps: 1,
        checkpointTimesSec: [4.2, 9.8],
        validationMethod: "strict-replay",
      }),
    ]]));
    await recordCompletedRace(accountPlayerId);

    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:selection-entry-only",
      redditPlayerId: accountPlayerId,
    });

    expect(selection.accountSummary.campaignResults).toBe(1);
    expect(selection.accountSummary.campaignUnlockedTracks).toBe(1);
  });

  it("persists a completed choice without an expiring transfer record", async () => {
    await seedSevenDayPlaylist();
    await recordCompletedRace("guest:durable-choice");

    await expect(selectGuestProgress({
      guestPlayerId: "guest:durable-choice",
      redditPlayerId: "reddit:durable-choice",
      choice: "account",
    })).resolves.toMatchObject({ status: "completed", choice: "account" });

    const transferKeys = [...redis.strings.keys()].filter((key) => (
      key.includes("guest-progress-selection:v1:") && !key.endsWith(":lock")
    ));
    expect(transferKeys).toHaveLength(1);
    expect(redis.expiresAtSeconds.has(transferKeys[0])).toBe(false);
    expect([...redis.strings.keys()].some((key) => key.includes("account-pending"))).toBe(false);
  });

  it("keeps a completed account choice successful when lock cleanup fails", async () => {
    await seedSevenDayPlaylist();
    await recordCompletedRace("guest:release-failure");
    vi.spyOn(console, "error").mockImplementation(() => {});
    redis.failLockRelease = true;

    await expect(selectGuestProgress({
      guestPlayerId: "guest:release-failure",
      redditPlayerId: "reddit:release-failure",
      choice: "account",
    })).resolves.toMatchObject({ status: "completed", choice: "account" });

    expect([...redis.strings.keys()].some((key) => key.includes("account-pending"))).toBe(false);
  });

  it("classifies an occupied selection lock as retryable", async () => {
    const accountPendingKey = guestProgressSelectionAccountPendingKey("reddit:busy-selection");
    await redis.set(`${accountPendingKey}:lock`, "another-selection");

    await expect(selectGuestProgress({
      guestPlayerId: "guest:busy-selection",
      redditPlayerId: "reddit:busy-selection",
      choice: "account",
    })).rejects.toMatchObject({
      statusCode: 503,
      reason: "progress_selection_retryable",
    });
  });

  it("resumes after a domain completes but its checkpoint write fails", async () => {
    await seedSevenDayPlaylist();
    await recordCompletedRace("guest:checkpoint-retry");
    vi.spyOn(console, "error").mockImplementation(() => {});
    redis.failTransferRecordWriteAt = 2;

    await expect(selectGuestProgress({
      guestPlayerId: "guest:checkpoint-retry",
      redditPlayerId: "reddit:checkpoint-retry",
      choice: "account",
    })).rejects.toThrow("simulated transfer checkpoint failure");

    await expect(selectGuestProgress({
      guestPlayerId: "guest:checkpoint-retry",
      redditPlayerId: "reddit:checkpoint-retry",
      choice: "account",
    })).resolves.toMatchObject({ status: "completed", choice: "account" });
  });

  it("rejects inconsistent pending checkpoints before touching account progress", async () => {
    const guestPlayerId = "guest:inconsistent-checkpoint";
    const redditPlayerId = "reddit:inconsistent-checkpoint";
    const accountProgress = {
      campaignId: "numbered-v1",
      startedAt: "2026-07-27T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-07-27T09:30:00.000Z",
        },
      },
      updatedAt: "2026-07-27T09:30:00.000Z",
    };
    const accountProgressKey = campaignProgressKey(redditPlayerId);
    await redis.set(accountProgressKey, JSON.stringify(accountProgress));
    await redis.set(guestProgressSelectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      version: 2,
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
      status: "pending",
      updatedAt: "2026-07-27T09:30:00.000Z",
      completedDomains: [],
      cleanedDomains: ["campaign"],
      dailyChallengeIds: ["2026-07-27"],
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: "guest_progress_recovery_required",
    });
    expect(await redis.get(accountProgressKey)).toBe(JSON.stringify(accountProgress));
  });

  it("rejects a missing frozen Daily challenge before replacing Campaign progress", async () => {
    const guestPlayerId = "guest:missing-daily-history";
    const redditPlayerId = "reddit:missing-daily-history";
    const accountProgress = {
      campaignId: "numbered-v1",
      startedAt: "2026-07-27T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-07-27T09:30:00.000Z",
        },
      },
      updatedAt: "2026-07-27T09:30:00.000Z",
    };
    const accountProgressKey = campaignProgressKey(redditPlayerId);
    await redis.set(accountProgressKey, JSON.stringify(accountProgress));
    await redis.set(guestProgressSelectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      version: 2,
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
      status: "pending",
      updatedAt: "2026-07-27T09:30:00.000Z",
      completedDomains: [],
      cleanedDomains: [],
      dailyChallengeIds: ["daily-gp:missing-history"],
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: "guest_progress_recovery_required",
    });
    expect(await redis.get(accountProgressKey)).toBe(JSON.stringify(accountProgress));
  });

  it("completes a normal guest replacement with the frozen Daily window", async () => {
    await seedSevenDayPlaylist();
    const guestId = "normal-guest-transfer";
    const guestPlayerId = `guest:${guestId}`;
    const redditPlayerId = "reddit:normal-guest-transfer";
    const guestToken = await mintGuestPlayerToken(guestId);
    await startServerCampaignRace({
      raceId: "numbered-v1-00",
      playerId: guestId,
      guestToken,
    });
    await recordCompletedRace(guestPlayerId);
    await redis.set(campaignProgressKey(redditPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-07-27T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-07-27T09:30:00.000Z",
        },
      },
      updatedAt: "2026-07-27T09:30:00.000Z",
    }));

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).resolves.toMatchObject({ status: "completed", choice: "guest" });

    const accountProgress = JSON.parse(await redis.get(campaignProgressKey(redditPlayerId)));
    expect(accountProgress.resultsByRaceId).toEqual({});
    expect(accountProgress.startedAt).toBeTruthy();
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeUndefined();
  });

  it("fences guest replacement before account writes when the coordinator changes hands", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:stale-coordinator";
    const redditPlayerId = "reddit:stale-coordinator";
    await recordCompletedRace(guestPlayerId);
    const accountProgressKey = campaignProgressKey(redditPlayerId);
    const accountProgress = {
      campaignId: "numbered-v1",
      startedAt: "2026-07-27T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-07-27T09:30:00.000Z",
        },
      },
      updatedAt: "2026-07-27T09:30:00.000Z",
    };
    await redis.set(accountProgressKey, JSON.stringify(accountProgress));
    const accountSelectionLock = `${guestProgressSelectionAccountPendingKey(redditPlayerId)}:lock`;
    vi.spyOn(console, "error").mockImplementation(() => {});
    redis.setBeforeExec((keys) => {
      if (keys.some((key) => key.includes(":submit-lock:"))) {
        void redis.set(accountSelectionLock, "successor-owner");
        redis.setBeforeExec(null);
      }
    });

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({
      statusCode: 503,
      reason: "progress_selection_retryable",
    });
    expect(await redis.get(accountProgressKey)).toBe(JSON.stringify(accountProgress));
  });

  it("blocks both identities while a transfer marker is present", async () => {
    const guestToken = await mintGuestPlayerToken("pending-identity");
    await redis.set(guestProgressSelectionPendingKey("guest:pending-identity"), "1");
    expect((await resolveAuthorizedPlayerIdentity({
      playerId: "pending-identity",
      guestToken,
    })).guestStatus).toBe("guest_promotion_pending");

    await redis.set(
      guestProgressSelectionAccountPendingKey("reddit:pending-identity"),
      "guest:pending-identity",
    );
    expect(await isPlayerProgressSelectionPending("reddit:pending-identity")).toBe(true);
  });
});

// Ceilings, not targets, with headroom over what this transfer measures today (343 calls, 270
// sequential steps, a 19-call transaction window). Before this was cut, the same transfer took
// 489 calls in 420 steps and held one transaction open across 68 of them. Raise these only with
// a reason, and never quietly.
const BUDGET_RPCS = 360;
const BUDGET_SEQUENTIAL_STEPS = 300;
const BUDGET_LARGEST_WINDOW = 24;

describe("guest transfer cost and recovery", () => {
  beforeEach(() => {
    redis.reset();
    stopCountingRedisCalls();
  });

  function dailyPbField(playerId) {
    return createHash("sha256").update(playerId, "utf8").digest("base64url");
  }

  function campaignCompetitionFor(stage, playerId) {
    return toCampaignCompetition("numbered-v1", stage, { playerId });
  }

  async function seedCampaignStage(stage, guestPlayerId) {
    const competition = campaignCompetitionFor(stage, guestPlayerId);
    await redis.hSet(competition.entryHashKey, {
      [guestPlayerId]: JSON.stringify({
        playerId: guestPlayerId,
        displayName: "Guest racer",
        bestTimeMs: 31234,
        trackKey: stage.trackKey,
        completedLaps: stage.lapCount,
        validationMethod: "strict-replay",
        updatedAt: new Date().toISOString(),
      }),
    });
    await redis.zAdd(competition.leaderboardKey, { member: guestPlayerId, score: 31234 });
  }

  it("clears a Daily day the guest holds only a personal best on", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:pb-only";
    const [challenge] = await getServerDailyGpPlaylist();
    const competition = toDailyCompetition(challenge);
    const track = TRACKS[challenge.trackKey];
    // A PB write and a leaderboard write succeed independently, so this shape is reachable.
    await upsertPlayerTrackPersonalBest({
      playerId: guestPlayerId,
      competition,
      track,
      bestTimeMs: 41234,
      checkpointTimesSec: null,
      ghost: null,
    });
    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBeFalsy();

    await expect(discardGuestDailyProgress({
      guestPlayerId,
      challengeIds: [challenge.id],
    })).resolves.toBe(true);

    expect(await redis.hGet(competition.pbHashKey, dailyPbField(guestPlayerId))).toBeFalsy();
  });

  it("resumes a Campaign discard that died partway, without re-bumping cleared stages", async () => {
    const guestPlayerId = "guest:half-discarded";
    const [firstStage, secondStage] = CAMPAIGN_STAGES;
    await seedCampaignStage(firstStage, guestPlayerId);
    await seedCampaignStage(secondStage, guestPlayerId);
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T00:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const bumped = [];
    const realIncrBy = RedisTestDouble.prototype.incrBy;
    redis.incrBy = async function counted(key, value) {
      if (String(key).includes("standings-revision")) bumped.push(key);
      return realIncrBy.call(this, key, value);
    };

    // The request dies on the first write after a stage has been cleared.
    let killed = false;
    redis.beforeExec = () => {
      if (bumped.length === 0 || killed) return;
      killed = true;
      throw new Error("request killed mid-discard");
    };
    await expect(discardGuestCampaignProgress({ guestPlayerId }))
      .rejects.toThrow("request killed mid-discard");
    redis.beforeExec = null;

    const firstAttemptBumps = [...bumped];
    expect(firstAttemptBumps).toHaveLength(1);
    // The progress record is deleted last, so the retry still knows the discard is unfinished.
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeTruthy();

    bumped.length = 0;
    await expect(discardGuestCampaignProgress({ guestPlayerId })).resolves.toBe(true);

    expect(bumped).toHaveLength(1);
    expect(bumped[0]).not.toBe(firstAttemptBumps[0]);
    for (const stage of [firstStage, secondStage]) {
      const competition = campaignCompetitionFor(stage, guestPlayerId);
      expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBeFalsy();
    }
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeFalsy();
    delete redis.incrBy;
  });

  it("stops a Campaign discard whose lock was taken over, and leaves that lock alone", async () => {
    const guestPlayerId = "guest:stolen-lock";
    const [firstStage, secondStage] = CAMPAIGN_STAGES;
    await seedCampaignStage(firstStage, guestPlayerId);
    await seedCampaignStage(secondStage, guestPlayerId);
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T00:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    let cleared = 0;
    const realIncrBy = RedisTestDouble.prototype.incrBy;
    redis.incrBy = async function counted(key, value) {
      if (String(key).includes("standings-revision")) cleared += 1;
      return realIncrBy.call(this, key, value);
    };
    // A successor takes one of the group's locks once the first stage is done.
    let stolenKey = null;
    redis.beforeExec = (keys) => {
      if (cleared === 0 || stolenKey) return;
      stolenKey = keys.find((key) => key.includes("submit-lock"));
      if (stolenKey) redis.strings.set(stolenKey, "successor-owner");
    };

    await expect(discardGuestCampaignProgress({ guestPlayerId }))
      .rejects.toMatchObject({ statusCode: 503, reason: "progress_selection_retryable" });

    redis.beforeExec = null;
    // Cleanup must never delete a lock somebody else now owns.
    expect(redis.strings.get(stolenKey)).toBe("successor-owner");
    // The unfinished discard is still visible to the retry.
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeTruthy();
    delete redis.incrBy;
  });

  it("clears rows a parsed read would have called empty", async () => {
    const guestPlayerId = "guest:unparseable";
    const [rankOnlyStage, unparseableStage, pbOnlyStage, emptyStage] = CAMPAIGN_STAGES;
    const rankOnly = campaignCompetitionFor(rankOnlyStage, guestPlayerId);
    const unparseable = campaignCompetitionFor(unparseableStage, guestPlayerId);
    const pbOnly = campaignCompetitionFor(pbOnlyStage, guestPlayerId);
    const emptyField = campaignCompetitionFor(emptyStage, guestPlayerId);

    // A ranking whose entry never landed.
    await redis.zAdd(rankOnly.leaderboardKey, { member: guestPlayerId, score: 31234 });
    // An entry this build can no longer parse.
    await redis.hSet(unparseable.entryHashKey, { [guestPlayerId]: "{ not json" });
    // A personal best from a superseded track revision.
    await redis.hSet(pbOnly.pbHashKey, {
      [dailyPbField(guestPlayerId)]: JSON.stringify({
        trackKey: pbOnlyStage.trackKey,
        trackFingerprint: "stale-fingerprint",
        simulationRevision: 0,
        bestTimeMs: 31234,
      }),
    });
    // A field that exists but stores nothing is still a row.
    await redis.hSet(emptyField.entryHashKey, { [guestPlayerId]: "" });
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T00:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));

    await expect(discardGuestCampaignProgress({ guestPlayerId })).resolves.toBe(true);

    // Nothing may outlive the progress record that would have prompted a retry.
    expect(await redis.zScore(rankOnly.leaderboardKey, guestPlayerId)).toBeFalsy();
    expect(await redis.hGet(emptyField.entryHashKey, guestPlayerId)).toBeUndefined();
    expect(await redis.hGet(unparseable.entryHashKey, guestPlayerId)).toBeFalsy();
    expect(await redis.hGet(pbOnly.pbHashKey, dailyPbField(guestPlayerId))).toBeFalsy();
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeFalsy();
  });

  it("skips stages the guest never raced", async () => {
    const guestPlayerId = "guest:one-stage";
    await seedCampaignStage(CAMPAIGN_STAGES[0], guestPlayerId);
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T00:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));
    const bumped = [];
    const realIncrBy = RedisTestDouble.prototype.incrBy;
    redis.incrBy = async function counted(key, value) {
      if (String(key).includes("standings-revision")) bumped.push(key);
      return realIncrBy.call(this, key, value);
    };

    await expect(discardGuestCampaignProgress({ guestPlayerId })).resolves.toBe(true);

    // One raced stage, one bump: the other fifteen boards never changed.
    expect(bumped).toHaveLength(1);
    delete redis.incrBy;
  });

  /**
   * Every Devvit redis call is one round trip, including the commands queued inside a
   * transaction. The double replays queued commands through the base client at exec(), so the
   * replay is excluded to keep one call counted once.
   */
  function measureRedis() {
    const measurement = { rpcs: 0, steps: 0, windows: [] };
    let inFlight = 0;
    // The double answers mGet by delegating to get, and replays queued commands through the
    // base client at exec(). Both are internal to the double; on Devvit each is one call.
    let delegating = false;
    let replaying = false;
    const baseWatch = RedisTestDouble.prototype.watch;
    const start = () => {
      measurement.rpcs += 1;
      if (inFlight === 0) measurement.steps += 1;
      inFlight += 1;
    };
    for (const method of REDIS_METHODS) {
      const original = RedisTestDouble.prototype[method];
      redis[method] = async function counted(...args) {
        if (replaying || delegating) return original.apply(this, args);
        start();
        try {
          if (method === "mGet") {
            delegating = true;
            try {
              return await original.apply(this, args);
            } finally {
              delegating = false;
            }
          }
          if (method !== "watch") return await original.apply(this, args);
          const transaction = await baseWatch.apply(this, args);
          let queued = null;
          return new Proxy(transaction, {
            get(target, prop) {
              const value = target[prop];
              if (typeof value !== "function") return value;
              return async (...queuedArgs) => {
                start();
                if (prop === "multi") queued = 1;
                else if (prop !== "exec" && queued !== null) queued += 1;
                try {
                  if (prop !== "exec") return await value.apply(target, queuedArgs);
                  if (queued !== null) measurement.windows.push(queued + 1);
                  queued = null;
                  replaying = true;
                  try {
                    return await value.apply(target, queuedArgs);
                  } finally {
                    replaying = false;
                  }
                } finally {
                  inFlight -= 1;
                }
              };
            },
          });
        } finally {
          inFlight -= 1;
        }
      };
    }
    return measurement;
  }

  it("keeps one transfer inside its round-trip budget", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:budget";
    const redditPlayerId = "reddit:budget";
    await seedCampaignStage(CAMPAIGN_STAGES[0], guestPlayerId);
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T00:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));
    for (const challenge of await getServerDailyGpPlaylist()) {
      const competition = toDailyCompetition(challenge);
      await redis.hSet(competition.entryHashKey, {
        [guestPlayerId]: JSON.stringify({
          playerId: guestPlayerId,
          displayName: "Guest racer",
          bestTimeMs: 41234,
          trackKey: challenge.trackKey,
          updatedAt: new Date().toISOString(),
        }),
      });
      await redis.zAdd(competition.leaderboardKey, { member: guestPlayerId, score: 41234 });
    }

    const measurement = measureRedis();
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });
    stopCountingRedisCalls();

    const largestWindow = Math.max(...measurement.windows);
    if (process.env.REPORT_TRANSFER_COST) {
      console.log("transfer cost", { ...measurement, windows: undefined, largestWindow });
    }
    // A single transaction held open across a whole domain is what a slow store times out on,
    // and the sequential steps are what elapsed time is actually made of.
    expect(largestWindow).toBeLessThanOrEqual(BUDGET_LARGEST_WINDOW);
    expect(measurement.steps).toBeLessThanOrEqual(BUDGET_SEQUENTIAL_STEPS);
    expect(measurement.rpcs).toBeLessThanOrEqual(BUDGET_RPCS);
  });

  it("reports a thrown transaction conflict as retryable, not as a server error", async () => {
    await seedSevenDayPlaylist();
    await recordCompletedRace("guest:thrown-conflict");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Reddit throws this instead of returning an empty EXEC.
    redis.throwTransactionConflictAt = 2;

    await expect(selectGuestProgress({
      guestPlayerId: "guest:thrown-conflict",
      redditPlayerId: "reddit:thrown-conflict",
      choice: "account",
    })).rejects.toMatchObject({
      statusCode: 503,
      reason: "progress_selection_retryable",
    });
  });
});
