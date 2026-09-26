import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTransferRunner } from "./transfer-runner-helper.js";
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
} = await import("../src/server/daily/daily-gp-store.ts");
const { startServerCampaignRace } = await import("../src/server/campaign/campaign-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign/campaign-progress-key.js");
const { recordCompletedRace } = await import("../src/server/player/car-unlock-store.ts");
const { mintGuestPlayerToken } = await import("../src/server/player/player-token.ts");
const {
    guestProgressSelectionAccountPendingKey,
    guestProgressSelectionPendingKey,
    isPlayerProgressSelectionPending,
} = await import("../src/server/player/guest-retirement.ts");
const { resolveAuthorizedPlayerIdentity } = await import("../src/server/competition/competition-identity.ts");
const { discardGuestCampaignProgress } = await import("../src/server/campaign/campaign-store.ts");
const { discardGuestDailyProgress } = await import("../src/server/daily/daily-gp-store.ts");
const { toDailyCompetition } = await import("../src/server/competition/competition.ts");
const { upsertPlayerTrackPersonalBest } = await import("../src/server/competition/pb-ghost-store.ts");
const { TRACKS } = await import("../game/track/tracks.js");
const {
  CAMPAIGN_LIVE_STAGES,
  CAMPAIGN_NUMBERS_SERIES_ID,
  CAMPAIGN_SERIES,
  getCampaignSeriesStages,
} = await import("../game/campaign/manifest.js");
const NUMBERS_STAGES = getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID);
// The first stage of every other series is open to every player.
const OTHER_SERIES_FIRST_STAGES = CAMPAIGN_SERIES.length - 1;
const { toCampaignCompetition } = await import("../src/server/competition/competition.ts");
const { competitionSubmissionLockKey } = await import("../src/server/competition/competition-submit.ts");
const { repairCampaignStandingsFromEntries } = await import("../src/server/campaign/campaign-store.ts");

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
      campaignUnlockedTracks: 1 + OTHER_SERIES_FIRST_STAGES,
      campaignTotalStages: CAMPAIGN_LIVE_STAGES.length,
      dailySavedResults: 0,
      dailyPlaylistSize: 7,
      carsUnlocked: 43,
      carsTotal: 52,
      unlocks: false,
    });
  });

  it("counts an account whose only record is a Daily result as having progress", async () => {
    await seedSevenDayPlaylist();
    const accountPlayerId = "reddit:selection-daily-only";
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
    expect(selection.accountSummary.campaignUnlockedTracks).toBe(3 + OTHER_SERIES_FIRST_STAGES);
    expect(selection.accountSummary.campaignTotalStages).toBe(CAMPAIGN_LIVE_STAGES.length);
    expect(selection.accountSummary.dailySavedResults).toBe(0);
    expect(selection.accountSummary.dailyPlaylistSize).toBe(7);
    expect(selection.accountSummary.carsUnlocked).toBe(44);
    expect(selection.accountSummary.carsTotal).toBe(52);
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
    expect(selection.accountSummary.campaignUnlockedTracks).toBe(1 + OTHER_SERIES_FIRST_STAGES);
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
    // The first Campaign write fenced by the account's progress lock.
    redis.setBeforeExec((keys) => {
      if (keys.some((key) => key.includes(":progress-lock:"))) {
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

// Campaign transfer writes hold at most this many stages in one transaction.
const STAGES_PER_TRANSFER_WRITE = 5;

const BUDGET_RPCS = 360;
const BUDGET_SEQUENTIAL_STEPS = 300;
const BUDGET_LARGEST_WINDOW = 24;
// The same fixture when the guest progress is kept (measured 905 / 387).
const BUDGET_GUEST_KEPT_RPCS = 950;
const BUDGET_GUEST_KEPT_SEQUENTIAL_STEPS = 420;

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

  it("waits for a race save that took its stage lock before the transfer marks", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:saving";
    const redditPlayerId = "reddit:saving";
    const [stage] = NUMBERS_STAGES;
    await seedCampaignStage(stage, guestPlayerId);
    const competition = campaignCompetitionFor(stage, guestPlayerId);
    const saveLockKey = competitionSubmissionLockKey(competition, guestPlayerId);
    await redis.set(saveLockKey, "save-in-flight");

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ statusCode: 503, reason: "progress_selection_retryable" });
    expect(await redis.hGet(competition.entryHashKey, redditPlayerId)).toBeFalsy();
    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBeTruthy();

    await redis.del(saveLockKey);
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect(JSON.parse(await redis.hGet(competition.entryHashKey, redditPlayerId)).bestTimeMs).toBe(31234);
    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBeFalsy();
  });

  it("clears every account row on stages the guest never raced when the guest progress is kept", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:replaces-account";
    const redditPlayerId = "reddit:replaced-account";
    const [guestStage, goodStage, damagedStage, pbOnlyStage, rankOnlyStage, emptyStage] = NUMBERS_STAGES;
    await seedCampaignStage(guestStage, guestPlayerId);
    const boardOf = (stage) => campaignCompetitionFor(stage, redditPlayerId);
    await redis.hSet(boardOf(goodStage).entryHashKey, {
      [redditPlayerId]: JSON.stringify({
        playerId: redditPlayerId,
        displayName: "Account racer",
        bestTimeMs: 29000,
        trackKey: goodStage.trackKey,
        completedLaps: goodStage.lapCount,
        validationMethod: "strict-replay",
        updatedAt: new Date().toISOString(),
      }),
    });
    await redis.zAdd(boardOf(goodStage).leaderboardKey, { member: redditPlayerId, score: 29000 });
    await redis.hSet(boardOf(damagedStage).entryHashKey, { [redditPlayerId]: "{not json" });
    await redis.hSet(boardOf(pbOnlyStage).pbHashKey, { [dailyPbField(redditPlayerId)]: "{not json" });
    await redis.zAdd(boardOf(rankOnlyStage).leaderboardKey, { member: redditPlayerId, score: 30000 });
    const bumped = [];
    const realIncrBy = RedisTestDouble.prototype.incrBy;
    redis.incrBy = async function counted(key, value) {
      if (String(key).includes("standings-revision")) bumped.push(key);
      return realIncrBy.call(this, key, value);
    };

    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });
    delete redis.incrBy;

    for (const stage of [goodStage, damagedStage, pbOnlyStage, rankOnlyStage]) {
      const board = boardOf(stage);
      expect(await redis.hGet(board.entryHashKey, redditPlayerId)).toBeFalsy();
      expect(await redis.hGet(board.pbHashKey, dailyPbField(redditPlayerId))).toBeFalsy();
      expect(await redis.zScore(board.leaderboardKey, redditPlayerId)).toBeFalsy();
    }
    expect(JSON.parse(await redis.hGet(boardOf(guestStage).entryHashKey, redditPlayerId)).bestTimeMs).toBe(31234);
    expect(await redis.hGet(boardOf(guestStage).entryHashKey, guestPlayerId)).toBeFalsy();
    expect(bumped.some((key) => key.includes(`:${emptyStage.raceId}:`))).toBe(false);
  });

  it("does not repair Campaign standings while a transfer owns the player", async () => {
    const redditPlayerId = "reddit:repair-during-transfer";
    const [stage] = NUMBERS_STAGES;
    const competition = campaignCompetitionFor(stage, redditPlayerId);
    await redis.hSet(competition.entryHashKey, {
      [redditPlayerId]: JSON.stringify({
        playerId: redditPlayerId,
        displayName: "Account racer",
        bestTimeMs: 31234,
        trackKey: stage.trackKey,
        completedLaps: stage.lapCount,
        validationMethod: "strict-replay",
        updatedAt: new Date().toISOString(),
      }),
    });
    await redis.set(guestProgressSelectionAccountPendingKey(redditPlayerId), "guest:repair-during-transfer");

    await repairCampaignStandingsFromEntries(redditPlayerId, stage.seriesId);

    expect(await redis.zScore(competition.leaderboardKey, redditPlayerId)).toBeFalsy();

    await redis.del(guestProgressSelectionAccountPendingKey(redditPlayerId));
    await repairCampaignStandingsFromEntries(redditPlayerId, stage.seriesId);

    expect(await redis.zScore(competition.leaderboardKey, redditPlayerId)).toBeTruthy();
  });

  it("clears a Daily day the guest holds only a personal best on", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:pb-only";
    const [challenge] = await getServerDailyGpPlaylist();
    const competition = toDailyCompetition(challenge);
    const track = TRACKS[challenge.trackKey];
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
      transactionRunner: await createTestTransferRunner(),
      guestPlayerId,
      challengeIds: [challenge.id],
    })).resolves.toBe(true);

    expect(await redis.hGet(competition.pbHashKey, dailyPbField(guestPlayerId))).toBeFalsy();
  });

  it("resumes a Campaign discard that died partway, without re-bumping cleared stages", async () => {
    const guestPlayerId = "guest:half-discarded";
    // One more stage than a single grouped write holds.
    const racedStages = NUMBERS_STAGES.slice(0, STAGES_PER_TRANSFER_WRITE + 1);
    for (const stage of racedStages) await seedCampaignStage(stage, guestPlayerId);
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
    expect(firstAttemptBumps).toHaveLength(STAGES_PER_TRANSFER_WRITE);
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeTruthy();

    bumped.length = 0;
    await expect(discardGuestCampaignProgress({ guestPlayerId })).resolves.toBe(true);

    expect(bumped).toHaveLength(1);
    expect(firstAttemptBumps).not.toContain(bumped[0]);
    for (const stage of racedStages) {
      const competition = campaignCompetitionFor(stage, guestPlayerId);
      expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBeFalsy();
    }
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeFalsy();
    delete redis.incrBy;
  });

  it("stops a Campaign discard whose lock was taken over, and leaves that lock alone", async () => {
    const guestPlayerId = "guest:stolen-lock";
    const [firstStage, secondStage] = NUMBERS_STAGES;
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
    let stolenKey = null;
    redis.beforeExec = (keys) => {
      if (cleared === 0 || stolenKey) return;
      stolenKey = keys.find((key) => key.includes("progress-lock"));
      if (stolenKey) redis.strings.set(stolenKey, "successor-owner");
    };

    await expect(discardGuestCampaignProgress({ guestPlayerId }))
      .rejects.toMatchObject({ statusCode: 503, reason: "progress_selection_retryable" });

    redis.beforeExec = null;
    expect(redis.strings.get(stolenKey)).toBe("successor-owner");
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeTruthy();
    delete redis.incrBy;
  });

  it("clears rows a parsed read would have called empty", async () => {
    const guestPlayerId = "guest:unparseable";
    const [rankOnlyStage, unparseableStage, pbOnlyStage, emptyStage] = NUMBERS_STAGES;
    const rankOnly = campaignCompetitionFor(rankOnlyStage, guestPlayerId);
    const unparseable = campaignCompetitionFor(unparseableStage, guestPlayerId);
    const pbOnly = campaignCompetitionFor(pbOnlyStage, guestPlayerId);
    const emptyField = campaignCompetitionFor(emptyStage, guestPlayerId);

    await redis.zAdd(rankOnly.leaderboardKey, { member: guestPlayerId, score: 31234 });
    await redis.hSet(unparseable.entryHashKey, { [guestPlayerId]: "{ not json" });
    await redis.hSet(pbOnly.pbHashKey, {
      [dailyPbField(guestPlayerId)]: JSON.stringify({
        trackKey: pbOnlyStage.trackKey,
        trackFingerprint: "stale-fingerprint",
        simulationRevision: 0,
        bestTimeMs: 31234,
      }),
    });
    await redis.hSet(emptyField.entryHashKey, { [guestPlayerId]: "" });
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T00:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));

    await expect(discardGuestCampaignProgress({ guestPlayerId })).resolves.toBe(true);

    expect(await redis.zScore(rankOnly.leaderboardKey, guestPlayerId)).toBeFalsy();
    expect(await redis.hGet(emptyField.entryHashKey, guestPlayerId)).toBeUndefined();
    expect(await redis.hGet(unparseable.entryHashKey, guestPlayerId)).toBeFalsy();
    expect(await redis.hGet(pbOnly.pbHashKey, dailyPbField(guestPlayerId))).toBeFalsy();
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeFalsy();
  });

  it("skips stages the guest never raced", async () => {
    const guestPlayerId = "guest:one-stage";
    await seedCampaignStage(NUMBERS_STAGES[0], guestPlayerId);
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

    expect(bumped).toHaveLength(1);
    delete redis.incrBy;
  });

  function measureRedis() {
    const measurement = { rpcs: 0, steps: 0, windows: [] };
    let inFlight = 0;
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

  // Records every call that names one stage, as "method" or "tx.method".
  function recordStageCalls(raceId) {
    const calls = [];
    const namesStage = (args) => args.flat().some((arg) => (
      typeof arg === "string" && new RegExp(`(^|:)${raceId}(:|$)`).test(arg)
    ));
    let delegating = false;
    let replaying = false;
    const baseWatch = RedisTestDouble.prototype.watch;
    for (const method of REDIS_METHODS) {
      const original = RedisTestDouble.prototype[method];
      redis[method] = async function recorded(...args) {
        if (replaying || delegating) return original.apply(this, args);
        if (namesStage(args)) calls.push(method);
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
        return new Proxy(transaction, {
          get(target, prop) {
            const value = target[prop];
            if (typeof value !== "function") return value;
            return async (...queuedArgs) => {
              if (namesStage(queuedArgs)) calls.push(`tx.${String(prop)}`);
              if (prop !== "exec") return await value.apply(target, queuedArgs);
              replaying = true;
              try {
                return await value.apply(target, queuedArgs);
              } finally {
                replaying = false;
              }
            };
          },
        });
      };
    }
    return calls;
  }

  // Reads of a stage nobody raced, in the cost fixture: each read of the guest
  // (3 calls) and of the account (3 calls). The one lock check (mGet) names
  // every stage. A planned list of raced stages removes these reads.
  const UNRACED_STAGE_READS = { account: 6, guest: 15 };

  for (const choice of ["account", "guest"]) {
    it(`only reads a stage nobody raced, when the ${choice} progress is kept`, async () => {
      await seedSevenDayPlaylist();
      const guestPlayerId = `guest:unraced-${choice}`;
      const redditPlayerId = `reddit:unraced-${choice}`;
      await seedCampaignStage(NUMBERS_STAGES[0], guestPlayerId);
      const unraced = CAMPAIGN_LIVE_STAGES[CAMPAIGN_LIVE_STAGES.length - 1];

      const calls = recordStageCalls(unraced.raceId);
      await selectGuestProgress({ guestPlayerId, redditPlayerId, choice });
      stopCountingRedisCalls();

      const reads = calls.filter((call) => call === "hGet" || call === "zScore");
      expect(calls.filter((call) => call === "mGet")).toHaveLength(1);
      expect(calls.filter((call) => !["hGet", "zScore", "mGet"].includes(call))).toEqual([]);
      expect(reads.length).toBeLessThanOrEqual(UNRACED_STAGE_READS[choice]);
    });
  }

  it("keeps one transfer inside its round-trip budget", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:budget";
    const redditPlayerId = "reddit:budget";
    await seedCampaignStage(NUMBERS_STAGES[0], guestPlayerId);
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
    expect(largestWindow).toBeLessThanOrEqual(BUDGET_LARGEST_WINDOW);
    expect(measurement.steps).toBeLessThanOrEqual(BUDGET_SEQUENTIAL_STEPS);
    expect(measurement.rpcs).toBeLessThanOrEqual(BUDGET_RPCS);
  });

  it("keeps a transfer that moves the guest progress inside its round-trip budget", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:budget-moved";
    const redditPlayerId = "reddit:budget-moved";
    await seedCampaignStage(NUMBERS_STAGES[0], guestPlayerId);
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
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });
    stopCountingRedisCalls();

    const largestWindow = Math.max(...measurement.windows);
    if (process.env.REPORT_TRANSFER_COST) {
      console.log("transfer cost (guest kept)", { ...measurement, windows: undefined, largestWindow });
    }
    expect(largestWindow).toBeLessThanOrEqual(BUDGET_LARGEST_WINDOW);
    expect(measurement.steps).toBeLessThanOrEqual(BUDGET_GUEST_KEPT_SEQUENTIAL_STEPS);
    expect(measurement.rpcs).toBeLessThanOrEqual(BUDGET_GUEST_KEPT_RPCS);
  });

  it("reports a thrown transaction conflict as retryable, not as a server error", async () => {
    await seedSevenDayPlaylist();
    await recordCompletedRace("guest:thrown-conflict");
    vi.spyOn(console, "error").mockImplementation(() => {});
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
