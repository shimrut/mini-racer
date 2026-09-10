import { beforeEach, describe, expect, it, vi } from "vitest";
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
  getServerPlayerBootstrap,
  resolveAccountTransferState,
  selectGuestProgress,
} = await import("../src/server/daily-gp-store.ts");
const { toDailyCompetition } = await import("../src/server/competition.ts");
const { recordCompletedRace, carUnlockHashKey } = await import("../src/server/car-unlock-store.ts");
const { upsertPlayerProfile } = await import("../src/server/competition-identity.ts");
const { campaignProgressKey } = await import("../src/server/campaign-progress-key.js");
const {
  guestProgressSelectionAccountPendingKey,
  guestProgressSelectionPendingKey,
} = await import("../src/server/guest-retirement.ts");

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

/** A guest with Campaign progress, a Garage unlock, and one row on today's Daily. */
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
  // The inventory is frozen from whatever is there now, damaged rows included.
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

    // The damaged row is what a reviewer needs, so the copy leaves it alone.
    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBe("{ not json");
    // The account's own day is untouched: a row this build cannot read is not a licence to
    // empty the account's, which is exactly what reading it as absent used to do.
    expect(JSON.parse(await redis.hGet(competition.entryHashKey, redditPlayerId)))
      .toMatchObject({ bestTimeMs: 21_000 });
    // And nothing may claim the Daily domain was copied.
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
    // Preparation has not run yet, so this day never enters the frozen inventory. There is no
    // evidence to be missing, and nothing to review.
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

    // The guest's row for this day is read four times across one transfer: preparation freezes
    // the inventory, the whole-domain sweep checks it, the presence check decides the day is
    // worth locking, and then the copy classifies it. Take the row away immediately before that
    // fourth read, which is the one the copy works from.
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

    // The read sequence this test injects into must still exist.
    expect(reads).toBeGreaterThanOrEqual(4);
    // A row that went missing is not evidence the guest had nothing, so the account keeps its own
    // time instead of being emptied to match a source that is no longer there.
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
    // Interrupt the transfer just after preparation, so the inventory is frozen with this day
    // on it and no copy has run.
    redis.failTransferRecordWriteAt = 2;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();
    const prepared = await readRecord(guestPlayerId, redditPlayerId);
    expect(prepared.sourceInventory).toBeTruthy();
    // Preparation is safe to repeat and re-freezes the inventory, so move the record past it.
    // This is the state a transfer is in once it has started copying.
    await redis.set(
      selectionKey(guestPlayerId, redditPlayerId),
      JSON.stringify({ ...prepared, phase: "copying" }),
    );

    // The day expires while the transfer is interrupted.
    await redis.hDel(competition.entryHashKey, [guestPlayerId]);
    await redis.zRem(competition.leaderboardKey, [guestPlayerId]);

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    // The account keeps its own time. A source that is gone is not a reason to empty it.
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
      choice: "guest",
    });
    // Everything a reviewed repair reads must still be there.
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
      choice: "guest",
    });
    await expect(getGuestProgressSelection({ guestPlayerId, redditPlayerId }))
      .resolves.toMatchObject({ required: true, state: "recovery_required", choice: "guest" });
  });

  it("repeats no replacement and no cleanup when the case is read again", async () => {
    const guestPlayerId = "guest:review-idempotent";
    const redditPlayerId = "reddit:review-idempotent";
    const { competition } = await stopOneForReview(guestPlayerId, redditPlayerId);
    const guestCampaignBefore = await redis.get(campaignProgressKey(guestPlayerId));

    await resolveAccountTransferState(redditPlayerId);
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });
    await getServerPlayerBootstrap({ redditUsername: "Review-Idempotent" });

    // The guest source is still whole, and the account gained nothing from a re-read.
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBe(guestCampaignBefore);
    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBe("{ not json");
    expect(await redis.hGet(competition.entryHashKey, redditPlayerId)).toBeFalsy();
  });

  /** A healthy transfer, interrupted after preparation and then marked for review by hand. */
  async function markAnInterruptedTransfer(guestPlayerId, redditPlayerId) {
    await seedGuestWithDailyRow(guestPlayerId, redditPlayerId);
    redis.failTransferRecordWriteAt = 2;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();
    const prepared = await readRecord(guestPlayerId, redditPlayerId);
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

    // Nothing is wrong with the source. The mark alone decides this, which is what stops a case
    // retrying in the background instead of waiting for a person.
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
    expect((await readRecord(guestPlayerId, redditPlayerId)).status).toBe("recovery_required");
  });

  it("resumes normally once a repair hands the case back", async () => {
    const guestPlayerId = "guest:marked-handed-back";
    const redditPlayerId = "reddit:marked-handed-back";
    const prepared = await markAnInterruptedTransfer(guestPlayerId, redditPlayerId);
    const { competition } = { competition: toDailyCompetition(await getServerDailyGpChallenge()) };

    // The repair described in the runbook: the mark comes off, and everything a resume needs
    // stays exactly as it was.
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
    // A record write that does not land. Nothing here says the data needs a person.
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
});
