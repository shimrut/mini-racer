import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTransferRunner } from "./transfer-runner-helper.js";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();

vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: redis,
}));

const {
  getGuestProgressSelection,
  getServerDailyGpChallenge,
  mergeGuestDailyProgress,
  resolveAccountTransferState,
  selectGuestProgress,
} = await import("../src/server/daily/daily-gp-store.ts");
const {
  getServerPlayerBootstrap,
} = await import("../src/server/player/player-account-store.ts");
const { toDailyCompetition } = await import("../src/server/competition/competition.ts");
const {
  recordCompletedRace,
  recordHeadToHeadWin,
  carUnlockHashKey,
} = await import("../src/server/player/car-unlock-store.ts");
const { upsertPlayerProfile } = await import("../src/server/competition/competition-identity.ts");
const { mintGuestPlayerToken } = await import("../src/server/player/player-token.ts");
const { campaignProgressKey } = await import("../src/server/campaign/campaign-progress-key.js");
const {
  guestProgressSelectionAccountPendingKey,
  guestProgressSelectionPendingKey,
} = await import("../src/server/player/guest-retirement.ts");

function selectionKey(guestPlayerId, redditPlayerId) {
  return `dailygp:guest-progress-selection:v1:${createHash("sha256")
    .update(`${guestPlayerId}:${redditPlayerId}`, "utf8")
    .digest("base64url")}`;
}

function playerField(playerId) {
  return createHash("sha256").update(playerId, "utf8").digest("base64url");
}

async function readRecord(guestPlayerId, redditPlayerId) {
  const raw = await redis.get(selectionKey(guestPlayerId, redditPlayerId));
  return raw ? JSON.parse(raw) : null;
}

function dailyEntry(playerId, challenge, bestTimeMs) {
  return JSON.stringify({
    playerId,
    trackKey: challenge.trackKey,
    bestTimeMs,
    completedLaps: challenge.objectiveParams.lapCount,
    checkpointTimesSec: [4.2, 9.8],
    validationMethod: "strict-replay",
    updatedAt: "2026-09-01T09:30:00.000Z",
  });
}

async function seedGuestWithDailyRow(guestPlayerId, redditPlayerId, { entry } = {}) {
  const challenge = await getServerDailyGpChallenge();
  const competition = toDailyCompetition(challenge);
  await recordCompletedRace(guestPlayerId);
  await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
    campaignId: "numbered-v1",
    startedAt: "2026-09-01T09:00:00.000Z",
    resultsByRaceId: {
      "numbered-v1-00": {
        raceId: "numbered-v1-00",
        trackKey: "numberZero",
        lapCount: 2,
        rulesRevision: 1,
        bestTimeMs: 12_000,
        medal: "gold",
        checkpointTimesSec: [4.2, 9.8],
        updatedAt: "2026-09-01T09:30:00.000Z",
      },
    },
    updatedAt: "2026-09-01T09:30:00.000Z",
  }));
  await redis.hSet(competition.entryHashKey, {
    [guestPlayerId]: entry ?? dailyEntry(guestPlayerId, challenge, 18_240),
  });
  await redis.zAdd(competition.leaderboardKey, { member: guestPlayerId, score: 18_240 });
  await getGuestProgressSelection({ guestPlayerId, redditPlayerId });
  return { challenge, competition };
}

describe("a frozen Daily day is judged before it is copied", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stops a Guest replacement when a frozen day's row cannot be read", async () => {
    const guestPlayerId = "guest:daily-damaged";
    const redditPlayerId = "reddit:daily-damaged";
    const { challenge, competition } = await seedGuestWithDailyRow(
      guestPlayerId,
      redditPlayerId,
      { entry: "{ not json" },
    );
    await redis.hSet(competition.entryHashKey, {
      [redditPlayerId]: dailyEntry(redditPlayerId, challenge, 21_000),
    });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBe("{ not json");
    expect(JSON.parse(await redis.hGet(competition.entryHashKey, redditPlayerId)))
      .toMatchObject({ bestTimeMs: 21_000 });
    const record = await readRecord(guestPlayerId, redditPlayerId);
    expect(record.completedDomains).not.toContain("daily");
  });

  it("stops when a frozen day's personal best cannot be read", async () => {
    const guestPlayerId = "guest:daily-pb-damaged";
    const redditPlayerId = "reddit:daily-pb-damaged";
    const challenge = await getServerDailyGpChallenge();
    const competition = toDailyCompetition(challenge);
    await recordCompletedRace(guestPlayerId);
    await redis.hSet(competition.pbHashKey, {
      [playerField(guestPlayerId)]: "{ not json",
    });
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    expect(await redis.hGet(competition.pbHashKey, playerField(guestPlayerId)))
      .toBe("{ not json");
  });

  it("copies a readable frozen day onto the account", async () => {
    const guestPlayerId = "guest:daily-good";
    const redditPlayerId = "reddit:daily-good";
    const { competition } = await seedGuestWithDailyRow(guestPlayerId, redditPlayerId);

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed" });

    expect(JSON.parse(await redis.hGet(competition.entryHashKey, redditPlayerId)))
      .toMatchObject({ playerId: redditPlayerId, bestTimeMs: 18_240 });
  });

  it("leaves a day with no rows alone instead of treating it as work done", async () => {
    const guestPlayerId = "guest:daily-empty";
    const redditPlayerId = "reddit:daily-empty";
    const challenge = await getServerDailyGpChallenge();
    const competition = toDailyCompetition(challenge);
    await recordCompletedRace(guestPlayerId);
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed" });

    expect(await redis.hGet(competition.entryHashKey, redditPlayerId)).toBeFalsy();
  });

  it("completes when a day expired before the transfer froze its inventory", async () => {
    const guestPlayerId = "guest:daily-expired-before";
    const redditPlayerId = "reddit:daily-expired-before";
    const { competition } = await seedGuestWithDailyRow(guestPlayerId, redditPlayerId);
    await redis.hDel(competition.entryHashKey, [guestPlayerId]);
    await redis.zRem(competition.leaderboardKey, [guestPlayerId]);

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed" });

    expect(await redis.hGet(competition.entryHashKey, redditPlayerId)).toBeFalsy();
  });

  it("does not let a row removed between the check and the copy pass as absent", async () => {
    const guestPlayerId = "guest:daily-vanishes";
    const redditPlayerId = "reddit:daily-vanishes";
    const { challenge, competition } = await seedGuestWithDailyRow(guestPlayerId, redditPlayerId);
    await redis.hSet(competition.entryHashKey, {
      [redditPlayerId]: dailyEntry(redditPlayerId, challenge, 21_000),
    });

    let reads = 0;
    const realHGet = redis.hGet.bind(redis);
    redis.hGet = async (key, field) => {
      if (key === competition.entryHashKey && field === guestPlayerId) {
        reads += 1;
        if (reads === 4) {
          await redis.hDel(competition.entryHashKey, [guestPlayerId]);
        }
      }
      return realHGet(key, field);
    };

    try {
      await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
        .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
    } finally {
      redis.hGet = realHGet;
    }

    expect(reads).toBeGreaterThanOrEqual(4);
    expect(JSON.parse(await redis.hGet(competition.entryHashKey, redditPlayerId)))
      .toMatchObject({ bestTimeMs: 21_000 });
  });

  it("stops when a frozen day's rows expire after the snapshot was captured", async () => {
    const guestPlayerId = "guest:daily-expired-after";
    const redditPlayerId = "reddit:daily-expired-after";
    const { challenge, competition } = await seedGuestWithDailyRow(guestPlayerId, redditPlayerId);
    await redis.hSet(competition.entryHashKey, {
      [redditPlayerId]: dailyEntry(redditPlayerId, challenge, 21_000),
    });
    // The inventory is saved with the first write after the marks.
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();
    const prepared = await readRecord(guestPlayerId, redditPlayerId);
    expect(prepared.sourceInventory).toBeTruthy();
    await redis.set(
      selectionKey(guestPlayerId, redditPlayerId),
      JSON.stringify({ ...prepared, phase: "copying" }),
    );

    await redis.hDel(competition.entryHashKey, [guestPlayerId]);
    await redis.zRem(competition.leaderboardKey, [guestPlayerId]);

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    expect(JSON.parse(await redis.hGet(competition.entryHashKey, redditPlayerId)))
      .toMatchObject({ bestTimeMs: 21_000 });
  });
});

describe("a transfer stopped for review survives a reload", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  async function stopOneForReview(guestPlayerId, redditPlayerId) {
    const seeded = await seedGuestWithDailyRow(
      guestPlayerId,
      redditPlayerId,
      { entry: "{ not json" },
    );
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
    return seeded;
  }

  it("writes the recovery phase, and keeps the choice, the checkpoints and both markers", async () => {
    const guestPlayerId = "guest:review-record";
    const redditPlayerId = "reddit:review-record";
    await stopOneForReview(guestPlayerId, redditPlayerId);

    const record = await readRecord(guestPlayerId, redditPlayerId);
    expect(record).toMatchObject({
      status: "recovery_required",
      phase: "recovery_required",
      // Keep guest is retired and runs as Merge.
      choice: "merge",
    });
    expect(record.completedDomains).toContain("campaign");
    expect(record.sourceInventory).toBeTruthy();
    expect(await redis.get(guestProgressSelectionPendingKey(guestPlayerId))).toBeTruthy();
    expect(await redis.get(guestProgressSelectionAccountPendingKey(redditPlayerId)))
      .toBe(guestPlayerId);
  });

  it("reports the same case, with its choice, on the account's next sign-in", async () => {
    const guestPlayerId = "guest:review-reload";
    const redditPlayerId = "reddit:review-reload";
    await stopOneForReview(guestPlayerId, redditPlayerId);

    await expect(resolveAccountTransferState(redditPlayerId)).resolves.toMatchObject({
      state: "recovery_required",
      choice: "merge",
    });
    await expect(getGuestProgressSelection({ guestPlayerId, redditPlayerId }))
      .resolves.toMatchObject({ required: true, state: "recovery_required", choice: "merge" });
  });

  it("repeats no replacement and no cleanup when the case is read again", async () => {
    const guestPlayerId = "guest:review-idempotent";
    const redditPlayerId = "reddit:review-idempotent";
    const { competition } = await stopOneForReview(guestPlayerId, redditPlayerId);
    const guestCampaignBefore = await redis.get(campaignProgressKey(guestPlayerId));

    await resolveAccountTransferState(redditPlayerId);
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });
    await getServerPlayerBootstrap({ redditUsername: "Review-Idempotent" });

    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBe(guestCampaignBefore);
    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBe("{ not json");
    expect(await redis.hGet(competition.entryHashKey, redditPlayerId)).toBeFalsy();
  });

  async function markAnInterruptedTransfer(guestPlayerId, redditPlayerId) {
    await seedGuestWithDailyRow(guestPlayerId, redditPlayerId);
    // The inventory is saved with the first write after the marks.
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();
    const prepared = await readRecord(guestPlayerId, redditPlayerId);
    expect(prepared.sourceInventory).toBeTruthy();
    await redis.set(selectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      ...prepared,
      phase: "recovery_required",
      status: "recovery_required",
    }));
    return prepared;
  }

  it("refuses an ordinary retry while the record carries the mark", async () => {
    const guestPlayerId = "guest:marked-refuses";
    const redditPlayerId = "reddit:marked-refuses";
    await markAnInterruptedTransfer(guestPlayerId, redditPlayerId);

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
    expect((await readRecord(guestPlayerId, redditPlayerId)).status).toBe("recovery_required");
  });

  it("resumes normally once a repair hands the case back", async () => {
    const guestPlayerId = "guest:marked-handed-back";
    const redditPlayerId = "reddit:marked-handed-back";
    const prepared = await markAnInterruptedTransfer(guestPlayerId, redditPlayerId);
    const { competition } = { competition: toDailyCompetition(await getServerDailyGpChallenge()) };

    await redis.set(selectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      ...prepared,
      phase: "copying",
      status: "pending",
    }));

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed" });
    expect(JSON.parse(await redis.hGet(competition.entryHashKey, redditPlayerId)))
      .toMatchObject({ playerId: redditPlayerId, bestTimeMs: 18_240 });
  });

  it("keeps a lost transaction race retryable instead of making it a repair case", async () => {
    const guestPlayerId = "guest:lost-race";
    const redditPlayerId = "reddit:lost-race";
    await seedGuestWithDailyRow(guestPlayerId, redditPlayerId);
    redis.failTransferRecordWriteAt = 2;

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();

    const record = await readRecord(guestPlayerId, redditPlayerId);
    expect(record.status).toBe("pending");
    expect(record.phase).not.toBe("recovery_required");
  });
});

describe("the bootstrap unlock backfill waits for an open transfer", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const completedRaceField = "race:completed";

  it("does not backfill while the account has a transfer open", async () => {
    const redditPlayerId = "reddit:backfill-blocked";
    await upsertPlayerProfile({
      playerId: redditPlayerId,
      leaderboardIdentity: "reddit",
      redditUsername: "Backfill-Blocked",
      hasAnyData: true,
    });
    await redis.set(
      guestProgressSelectionAccountPendingKey(redditPlayerId),
      "guest:mid-transfer",
    );

    await getServerPlayerBootstrap({ redditUsername: "Backfill-Blocked" });

    expect(await redis.hGet(carUnlockHashKey(redditPlayerId), completedRaceField))
      .toBeFalsy();
  });

  it("grants a Garage credit that a won challenge could not write", async () => {
    const redditPlayerId = "reddit:owed-credit";
    const winField = "win:challenge:challenge-owed";
    await upsertPlayerProfile({
      playerId: redditPlayerId,
      leaderboardIdentity: "reddit",
      redditUsername: "Owed-Credit",
      hasAnyData: true,
    });
    vi.spyOn(redis, "hSetNX").mockRejectedValueOnce(new Error("reward busy"));
    await expect(recordHeadToHeadWin(redditPlayerId, "challenge-owed"))
      .rejects.toThrow("reward busy");
    expect(await redis.hGet(carUnlockHashKey(redditPlayerId), winField)).toBeFalsy();

    await getServerPlayerBootstrap({ redditUsername: "Owed-Credit" });

    expect(await redis.hGet(carUnlockHashKey(redditPlayerId), winField)).toBe("1");
  });

  it("repairs the first-race reward for a player who has only raced Campaign", async () => {
    const redditPlayerId = "reddit:campaign-only";
    await upsertPlayerProfile({
      playerId: redditPlayerId,
      leaderboardIdentity: "reddit",
      redditUsername: "Campaign-Only",
      hasAnyData: false,
    });
    await redis.set(campaignProgressKey(redditPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-09-01T09:30:00.000Z",
        },
      },
    }));

    await getServerPlayerBootstrap({ redditUsername: "Campaign-Only" });

    expect(await redis.hGet(carUnlockHashKey(redditPlayerId), completedRaceField)).toBe("1");
  });

  it("backfills once no transfer is open", async () => {
    const redditPlayerId = "reddit:backfill-allowed";
    await upsertPlayerProfile({
      playerId: redditPlayerId,
      leaderboardIdentity: "reddit",
      redditUsername: "Backfill-Allowed",
      hasAnyData: true,
    });

    await getServerPlayerBootstrap({ redditUsername: "Backfill-Allowed" });

    expect(await redis.hGet(carUnlockHashKey(redditPlayerId), completedRaceField))
      .toBe("1");
  });

  async function pendingReadsDuring(guestPlayerId, run) {
    const pendingKey = guestProgressSelectionPendingKey(guestPlayerId);
    const reads = [];
    const get = redis.get.bind(redis);
    vi.spyOn(redis, "get").mockImplementation(async (key) => {
      if (key === pendingKey) reads.push(key);
      return get(key);
    });
    await run();
    return reads.length;
  }

  it("reads a guest transfer flag once when the token already answered it", async () => {
    const guestPlayerId = "guest:token-flag";
    await upsertPlayerProfile({
      playerId: guestPlayerId,
      leaderboardIdentity: "constructed",
      hasAnyData: true,
    });
    await redis.set(guestProgressSelectionPendingKey(guestPlayerId), "1");
    const guestToken = await mintGuestPlayerToken("token-flag");

    const reads = await pendingReadsDuring(guestPlayerId, () => getServerPlayerBootstrap({
      playerId: "token-flag",
      guestToken,
    }));

    expect(reads).toBe(1);
    expect(await redis.hGet(carUnlockHashKey(guestPlayerId), completedRaceField)).toBeFalsy();
  });

  it("still repairs a promoted guest whose transfer flag is clear", async () => {
    const guestPlayerId = "guest:promoted-clear-flag";
    await upsertPlayerProfile({
      playerId: guestPlayerId,
      leaderboardIdentity: "constructed",
      hasAnyData: true,
    });
    await redis.set(
      `miniracer:car-unlocks:promotion:v1:${createHash("sha256").update(guestPlayerId, "utf8").digest("base64url")}`,
      "reddit:keeper",
    );
    await redis.set(campaignProgressKey(guestPlayerId), "{}");
    const guestToken = await mintGuestPlayerToken("promoted-clear-flag");

    const reads = await pendingReadsDuring(guestPlayerId, () => getServerPlayerBootstrap({
      playerId: "promoted-clear-flag",
      guestToken,
    }));

    expect(reads).toBe(1);
    expect(await redis.hGet(carUnlockHashKey("reddit:keeper"), completedRaceField)).toBe("1");
  });

  it("reads the transfer flag once when claiming an id whose profile is gone", async () => {
    const guestPlayerId = "guest:claim-flag";
    await redis.set(guestProgressSelectionPendingKey(guestPlayerId), "1");
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": {
          raceId: "numbered-v1-00",
          trackKey: "numberZero",
          lapCount: 2,
          rulesRevision: 1,
          bestTimeMs: 12_000,
          medal: "gold",
          checkpointTimesSec: [4.2, 9.8],
          updatedAt: "2026-09-01T09:30:00.000Z",
        },
      },
    }));

    const reads = await pendingReadsDuring(guestPlayerId, () => getServerPlayerBootstrap({
      playerId: "claim-flag",
    }));

    expect(reads).toBe(1);
    expect(await redis.hGet(carUnlockHashKey(guestPlayerId), completedRaceField)).toBeFalsy();
  });

  it("reads the transfer flag once when adopting a guest", async () => {
    const guestPlayerId = "guest:adopt-flag";
    await upsertPlayerProfile({
      playerId: guestPlayerId,
      leaderboardIdentity: "constructed",
      hasAnyData: true,
    });
    await redis.set(guestProgressSelectionPendingKey(guestPlayerId), "1");

    const reads = await pendingReadsDuring(guestPlayerId, () => getServerPlayerBootstrap({
      playerId: "adopt-flag",
    }));

    expect(reads).toBe(1);
    expect(await redis.hGet(carUnlockHashKey(guestPlayerId), completedRaceField)).toBeFalsy();
  });
});

describe("a frozen Daily day cannot be skipped on a presence read", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function specFor(challenge) {
    return {
      id: challenge.id,
      trackKey: challenge.trackKey,
      lapCount: challenge.objectiveParams.lapCount,
      rulesRevision: challenge.rulesRevision,
      objectiveType: challenge.objectiveType,
    };
  }

  it("takes a recorded day to its locks even when nothing is there any more", async () => {
    const guestPlayerId = "guest:daily-vanished-before-presence";
    const redditPlayerId = "reddit:daily-vanished-before-presence";
    const challenge = await getServerDailyGpChallenge();
    const competition = toDailyCompetition(challenge);

    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBeFalsy();
    expect(await redis.hGet(competition.entryHashKey, redditPlayerId)).toBeFalsy();

    const verifyGuestSource = vi.fn();
    await mergeGuestDailyProgress({
      transactionRunner: await createTestTransferRunner(),
      guestPlayerId,
      redditPlayerId,
      classifySource: true,
      challengeIds: [challenge.id],
      challengeSpecs: [specFor(challenge)],
      verifyGuestSource,
      recordedDailyChallengeIds: new Set([challenge.id]),
    });

    expect(verifyGuestSource).toHaveBeenCalledWith(
      expect.objectContaining({ dailyDay: expect.objectContaining({ challengeId: challenge.id }) }),
    );
  });

  it("still skips a day the inventory did not record", async () => {
    const guestPlayerId = "guest:daily-never-raced";
    const redditPlayerId = "reddit:daily-never-raced";
    const challenge = await getServerDailyGpChallenge();

    const verifyGuestSource = vi.fn();
    await mergeGuestDailyProgress({
      transactionRunner: await createTestTransferRunner(),
      guestPlayerId,
      redditPlayerId,
      classifySource: true,
      challengeIds: [challenge.id],
      challengeSpecs: [specFor(challenge)],
      verifyGuestSource,
      recordedDailyChallengeIds: new Set(),
    });

    expect(verifyGuestSource).toHaveBeenCalledTimes(1);
    expect(verifyGuestSource).toHaveBeenCalledWith();
  });
});
