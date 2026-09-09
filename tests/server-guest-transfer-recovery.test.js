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
  selectServerGuestProgress,
} = await import("../src/server/daily-gp-store.ts");
const { recordCompletedRace, carUnlockHashKey } = await import("../src/server/car-unlock-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign-progress-key.js");
const {
  guestProgressSelectionPendingKey,
  guestProgressSelectionAccountPendingKey,
  guestProgressTransferReceiptKey,
  guestProgressTransferIndexKey,
} = await import("../src/server/guest-retirement.ts");

function selectionKey(guestPlayerId, redditPlayerId) {
  return `dailygp:guest-progress-selection:v1:${createHash("sha256")
    .update(`${guestPlayerId}:${redditPlayerId}`, "utf8")
    .digest("base64url")}`;
}

function transferId(guestPlayerId, redditPlayerId) {
  return `guest-transfer:${createHash("sha256")
    .update(`${guestPlayerId}:${redditPlayerId}`, "utf8")
    .digest("base64url")}`;
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

/** Puts a guest in front of an account with progress worth transferring. */
async function seedTransferableGuest(guestPlayerId, redditPlayerId) {
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
  await getGuestProgressSelection({ guestPlayerId, redditPlayerId });
}

async function readRecord(guestPlayerId, redditPlayerId) {
  const raw = await redis.get(selectionKey(guestPlayerId, redditPlayerId));
  return raw ? JSON.parse(raw) : null;
}

describe("guest transfer record contract", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
  });

  it("writes a version-4 record that names its own transfer and phase", async () => {
    const guestPlayerId = "guest:v4-record";
    const redditPlayerId = "reddit:v4-record";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);

    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    const record = await readRecord(guestPlayerId, redditPlayerId);
    expect(record).toMatchObject({
      version: 4,
      transferId: transferId(guestPlayerId, redditPlayerId),
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
      status: "completed",
      phase: "completed",
    });
    expect(record.sourceInventory).toMatchObject({
      campaignProgress: expect.any(String),
      campaignStages: expect.any(Object),
      daily: expect.any(Object),
      unlocks: expect.any(String),
    });
    expect(typeof record.completedAt).toBe("string");
  });

  it("captures the source inventory before it permits any account replacement", async () => {
    const guestPlayerId = "guest:prepare-first";
    const redditPlayerId = "reddit:prepare-first";
    const accountKey = campaignProgressKey(redditPlayerId);
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    await redis.set(accountKey, JSON.stringify({ campaignId: "numbered-v1", resultsByRaceId: {} }));

    // Fail the write that follows preparation, so the transfer stops the moment it would copy.
    redis.failTransferRecordWriteAt = 2;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();

    const record = await readRecord(guestPlayerId, redditPlayerId);
    expect(record.phase).toBe("preparing");
    expect(record.completedDomains).toEqual([]);
    expect(record.sourceInventory).toBeTruthy();
    // Preparation may repeat, so the account is untouched.
    expect(JSON.parse(await redis.get(accountKey)).resultsByRaceId).toEqual({});
  });

  it("keeps the completion receipt and the account index in step with the record", async () => {
    const guestPlayerId = "guest:receipt";
    const redditPlayerId = "reddit:receipt";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);

    const result = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });

    const receipt = JSON.parse(await redis.get(guestProgressTransferReceiptKey(result.transferId)));
    expect(receipt).toMatchObject({
      version: 4,
      transferId: result.transferId,
      guestPlayerId,
      redditPlayerId,
      choice: "account",
      completedAt: result.completedAt,
    });
    expect(JSON.parse(await redis.get(guestProgressTransferIndexKey(redditPlayerId))))
      .toEqual([result.transferId]);
  });
});

describe("guest transfer completion is answered, not re-run", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
  });

  it("returns the same completion evidence when a successful response was lost", async () => {
    const guestPlayerId = "guest:lost-response";
    const redditPlayerId = "reddit:lost-response";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);

    const first = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });

    // The browser never saw that answer, so it asks the server to finish the transfer again.
    const retried = await selectServerGuestProgress({
      redditUsername: "lost-response",
      action: "resume",
      transferId: first.transferId,
    });

    expect(retried.progressSelection).toMatchObject({
      state: "completed",
      choice: "account",
      transferId: first.transferId,
      sourceGuestPlayerId: guestPlayerId,
      completedAt: first.completedAt,
    });
  });

  it("answers a repeated resume after the pending markers are gone", async () => {
    const guestPlayerId = "guest:markers-gone";
    const redditPlayerId = "reddit:markers-gone";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    const first = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });

    expect(await redis.get(guestProgressSelectionAccountPendingKey(redditPlayerId))).toBeUndefined();
    expect(await redis.get(guestProgressSelectionPendingKey(guestPlayerId))).toBeUndefined();

    const state = await resolveAccountTransferState(redditPlayerId, {
      transferId: first.transferId,
    });
    expect(state).toMatchObject({ state: "completed", completedAt: first.completedAt });
  });

  it("does not let a later transfer hide an earlier completion", async () => {
    const redditPlayerId = "reddit:two-transfers";
    await seedTransferableGuest("guest:first-device", redditPlayerId);
    const first = await selectGuestProgress({
      guestPlayerId: "guest:first-device",
      redditPlayerId,
      choice: "account",
    });
    await seedTransferableGuest("guest:second-device", redditPlayerId);
    const second = await selectGuestProgress({
      guestPlayerId: "guest:second-device",
      redditPlayerId,
      choice: "account",
    });
    expect(second.transferId).not.toBe(first.transferId);

    // The newest transfer is what an unqualified question returns.
    await expect(resolveAccountTransferState(redditPlayerId))
      .resolves.toMatchObject({ transferId: second.transferId, state: "completed" });
    // The first device still gets its own answer.
    await expect(resolveAccountTransferState(redditPlayerId, { transferId: first.transferId }))
      .resolves.toMatchObject({ transferId: first.transferId, state: "completed" });
  });

  it("refuses a transfer id that belongs to another account", async () => {
    await seedTransferableGuest("guest:owner", "reddit:owner");
    const owned = await selectGuestProgress({
      guestPlayerId: "guest:owner",
      redditPlayerId: "reddit:owner",
      choice: "account",
    });

    await expect(resolveAccountTransferState("reddit:stranger", {
      transferId: owned.transferId,
    })).resolves.toBeNull();
  });

  it("clears only its own stale markers from a completed record", async () => {
    const guestPlayerId = "guest:stale-markers";
    const redditPlayerId = "reddit:stale-markers";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    const first = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });

    await redis.set(guestProgressSelectionPendingKey(guestPlayerId), "1");
    await redis.set(guestProgressSelectionAccountPendingKey(redditPlayerId), guestPlayerId);

    await expect(resolveAccountTransferState(redditPlayerId))
      .resolves.toMatchObject({ state: "completed", transferId: first.transferId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" }))
      .resolves.toMatchObject({ status: "completed", completedAt: first.completedAt });
    expect(await redis.get(guestProgressSelectionAccountPendingKey(redditPlayerId))).toBeUndefined();
  });
});

describe("guest transfer source integrity", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stops a Garage replacement when the source changed after preparation", async () => {
    const guestPlayerId = "guest:changed-unlocks";
    const redditPlayerId = "reddit:changed-unlocks";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    // Prepare, then stop before copying.
    redis.failTransferRecordWriteAt = 2;
    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();
    expect((await readRecord(guestPlayerId, redditPlayerId)).phase).toBe("preparing");

    // A record already past preparation must not re-read its evidence.
    const record = await readRecord(guestPlayerId, redditPlayerId);
    await redis.set(selectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      ...record,
      phase: "copying",
    }));
    await redis.hSet(carUnlockHashKey(guestPlayerId), { "car-added-later": "1" });

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: "guest_progress_recovery_required",
    });
  });

  it("stops a Campaign replacement when the source row disappeared after preparation", async () => {
    const guestPlayerId = "guest:lost-campaign";
    const redditPlayerId = "reddit:lost-campaign";
    const accountKey = campaignProgressKey(redditPlayerId);
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    await redis.set(accountKey, JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T08:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T08:00:00.000Z",
    }));
    redis.failTransferRecordWriteAt = 2;
    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();
    const record = await readRecord(guestPlayerId, redditPlayerId);
    await redis.set(selectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      ...record,
      phase: "copying",
    }));

    // The guest's saved Campaign progress expired between preparation and the copy.
    await redis.del(campaignProgressKey(guestPlayerId));

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
    // The account keeps what it had.
    expect(JSON.parse(await redis.get(accountKey)).startedAt).toBe("2026-09-01T08:00:00.000Z");
  });

  it("treats a Garage promotion to another account as a conflict, not a retry", async () => {
    const guestPlayerId = "guest:promoted-elsewhere";
    const redditPlayerId = "reddit:promoted-elsewhere";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    await redis.set(
      `miniracer:car-unlocks:promotion:v1:${createHash("sha256").update(guestPlayerId, "utf8").digest("base64url")}`,
      "reddit:somebody-else",
    );

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: "guest_progress_recovery_required",
    });
  });
});

describe("guest transfer legacy records", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  async function writeLegacyRecord(guestPlayerId, redditPlayerId, overrides) {
    await redis.set(selectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      guestPlayerId,
      redditPlayerId,
      status: "pending",
      updatedAt: "2026-08-01T00:00:00.000Z",
      completedDomains: [],
      cleanedDomains: [],
      dailyChallengeIds: ["daily-gp-2026-08-01"],
      ...overrides,
    }));
    await redis.set(guestProgressSelectionPendingKey(guestPlayerId), "1");
    await redis.set(guestProgressSelectionAccountPendingKey(redditPlayerId), guestPlayerId);
  }

  it("keeps an older Guest-choice record without source evidence for review", async () => {
    await writeLegacyRecord("guest:legacy-guest", "reddit:legacy-guest", {
      version: 2,
      choice: "guest",
    });

    await expect(resolveAccountTransferState("reddit:legacy-guest"))
      .resolves.toMatchObject({ state: "recovery_required", choice: "guest" });
  });

  it("lets a recognized older Account-choice record resume its discard", async () => {
    await writeLegacyRecord("guest:legacy-account", "reddit:legacy-account", {
      version: 2,
      choice: "account",
    });

    await expect(resolveAccountTransferState("reddit:legacy-account"))
      .resolves.toMatchObject({ state: "resume_required", choice: "account" });
  });

  it("keeps a record whose checkpoints are out of order for review", async () => {
    await writeLegacyRecord("guest:bad-checkpoints", "reddit:bad-checkpoints", {
      version: 4,
      transferId: transferId("guest:bad-checkpoints", "reddit:bad-checkpoints"),
      phase: "copying",
      choice: "guest",
      completedDomains: ["daily", "campaign"],
    });

    await expect(resolveAccountTransferState("reddit:bad-checkpoints"))
      .resolves.toMatchObject({ state: "recovery_required" });
  });

  it("keeps an unreadable record for review instead of guessing", async () => {
    const guestPlayerId = "guest:unreadable";
    const redditPlayerId = "reddit:unreadable";
    await redis.set(selectionKey(guestPlayerId, redditPlayerId), "{not json");
    await redis.set(guestProgressSelectionAccountPendingKey(redditPlayerId), guestPlayerId);

    await expect(resolveAccountTransferState(redditPlayerId))
      .resolves.toMatchObject({ state: "recovery_required" });
  });

  it("refuses to resume a record that needs review", async () => {
    await writeLegacyRecord("guest:no-resume", "reddit:no-resume", {
      version: 2,
      choice: "guest",
    });

    await expect(selectServerGuestProgress({
      redditUsername: "no-resume",
      action: "resume",
      transferId: transferId("guest:no-resume", "reddit:no-resume"),
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: "guest_progress_recovery_required",
    });
  });
});

describe("bootstrap reports the account's transfer before anything else", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("blocks a signed-in bootstrap whose recorded transfer was interrupted, with no guest token", async () => {
    const guestPlayerId = "guest:other-device";
    const redditPlayerId = "reddit:other-device";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    // The choice was recorded on the first device, then the request was cut off mid-copy.
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();

    const payload = await getServerPlayerBootstrap({ redditUsername: "other-device" });

    expect(payload.progressSelection).toMatchObject({
      state: "resume_required",
      choice: "guest",
      sourceGuestPlayerId: guestPlayerId,
      transferId: transferId(guestPlayerId, redditPlayerId),
    });
    expect(payload.hasAnyData).toBe(false);
    expect(payload.retireGuestIdentity).toBe(false);
  });

  it("still shows the ordinary chooser when a marker has no recorded choice", async () => {
    const guestPlayerId = "guest:never-chose";
    const redditPlayerId = "reddit:never-chose";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);

    await expect(resolveAccountTransferState(redditPlayerId))
      .resolves.toMatchObject({ state: "choice_required", sourceGuestPlayerId: guestPlayerId });
    // Nothing was replaced, so a sign-in without the guest token is not held for review.
    const payload = await getServerPlayerBootstrap({ redditUsername: "never-chose" });
    expect(payload.progressSelection).toBeUndefined();
  });

  it("leaves an unaffected signed-in player alone", async () => {
    const payload = await getServerPlayerBootstrap({ redditUsername: "no-transfer-here" });

    expect(payload.progressSelection).toBeUndefined();
    expect(payload.playerId).toBe("reddit:no-transfer-here");
  });

  it("reports a completed transfer so the browser can reconcile its queue", async () => {
    const guestPlayerId = "guest:reconcile";
    const redditPlayerId = "reddit:reconcile";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    const done = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });

    const payload = await getServerPlayerBootstrap({ redditUsername: "reconcile" });

    expect(payload.progressSelection).toMatchObject({
      state: "completed",
      transferId: done.transferId,
      sourceGuestPlayerId: guestPlayerId,
      choice: "account",
    });
  });
});

describe("guest transfer Daily cleanup does not need history", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
  });

  it("finishes a Guest transfer using only the frozen Daily specs", async () => {
    await seedSevenDayPlaylist();
    const guestPlayerId = "guest:frozen-specs";
    const redditPlayerId = "reddit:frozen-specs";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);

    const result = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });
    expect(result.status).toBe("completed");

    const record = await readRecord(guestPlayerId, redditPlayerId);
    expect(record.dailyChallengeSpecs).toHaveLength(record.dailyChallengeIds.length);
    for (const spec of record.dailyChallengeSpecs) {
      expect(spec).toMatchObject({
        id: expect.any(String),
        trackKey: expect.any(String),
        rulesRevision: expect.any(Number),
      });
    }
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeUndefined();
  });
});
