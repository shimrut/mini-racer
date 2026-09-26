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
  resolveAccountTransferState,
  selectGuestProgress,
} = await import("../src/server/daily/daily-gp-store.ts");
const {
  getServerPlayerBootstrap,
  selectServerGuestProgress,
} = await import("../src/server/player/player-account-store.ts");
const { recordCompletedRace, carUnlockHashKey } = await import("../src/server/player/car-unlock-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign/campaign-progress-key.js");
const {
  guestProgressSelectionPendingKey,
  guestProgressSelectionAccountPendingKey,
  guestProgressTransferReceiptKey,
  guestProgressTransferIndexKey,
} = await import("../src/server/player/guest-retirement.ts");

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

    // The first write sets the marks; the second saves the inventory, which is
    // captured only after the marks. No account write comes before it.
    redis.failTransferRecordWriteAt = 2;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();

    const marked = await readRecord(guestPlayerId, redditPlayerId);
    expect(marked.phase).toBe("preparing");
    expect(marked.completedDomains).toEqual([]);
    expect(marked.sourceInventory).toBeUndefined();
    expect(JSON.parse(await redis.get(accountKey)).resultsByRaceId).toEqual({});

    // The retry sets the marks again, then saves the inventory before it
    // copies anything; the write after the Campaign copy fails.
    redis.failTransferRecordWriteAt = redis.transferRecordWriteCount + 3;
    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();

    const prepared = await readRecord(guestPlayerId, redditPlayerId);
    expect(prepared.phase).toBe("copying");
    expect(prepared.completedDomains).toEqual([]);
    expect(prepared.sourceInventory).toBeTruthy();
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

    await expect(resolveAccountTransferState(redditPlayerId))
      .resolves.toMatchObject({ transferId: second.transferId, state: "completed" });
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
    redis.failTransferRecordWriteAt = 2;
    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();
    expect((await readRecord(guestPlayerId, redditPlayerId)).phase).toBe("preparing");

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

    await redis.del(campaignProgressKey(guestPlayerId));

    await expect(selectGuestProgress({
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
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

  it("does not claim the account until a choice is recorded", async () => {
    const guestPlayerId = "guest:never-chose";
    const redditPlayerId = "reddit:never-chose";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);

    expect(await redis.get(guestProgressSelectionAccountPendingKey(redditPlayerId)))
      .toBeUndefined();
    await expect(resolveAccountTransferState(redditPlayerId)).resolves.toBeNull();
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

describe("guest transfer resumes from any interrupted checkpoint", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  for (const failAt of [1, 2, 3, 4, 5, 6, 7]) {
    for (const choice of ["guest", "account"]) {
      it(`finishes a ${choice} choice after checkpoint ${failAt} was interrupted`, async () => {
        const guestPlayerId = `guest:interrupt-${choice}-${failAt}`;
        const redditPlayerId = `reddit:interrupt-${choice}-${failAt}`;
        await seedTransferableGuest(guestPlayerId, redditPlayerId);

        redis.failTransferRecordWriteAt = failAt;
        let interrupted = false;
        try {
          await selectGuestProgress({ guestPlayerId, redditPlayerId, choice });
        } catch {
          interrupted = true;
        }
        redis.failTransferRecordWriteAt = null;

        const result = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice });
        expect(result.status).toBe("completed");
        expect(result.choice).toBe(choice);

        const record = await readRecord(guestPlayerId, redditPlayerId);
        expect(record.status).toBe("completed");
        expect(record.phase).toBe("completed");
        expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeUndefined();
        const receipt = JSON.parse(await redis.get(guestProgressTransferReceiptKey(result.transferId)));
        expect(receipt.choice).toBe(choice);
        expect(JSON.parse(await redis.get(guestProgressTransferIndexKey(redditPlayerId))))
          .toEqual([result.transferId]);
        expect(typeof interrupted).toBe("boolean");
      });
    }
  }
});

describe("guest transfer normal sources", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("completes when the guest has only Garage unlocks", async () => {
    const guestPlayerId = "guest:garage-only";
    const redditPlayerId = "reddit:garage-only";
    await recordCompletedRace(guestPlayerId);
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed" });
    expect(await redis.hGetAll(carUnlockHashKey(guestPlayerId))).toEqual({});
  });

  it("completes when the guest has only Campaign progress", async () => {
    const guestPlayerId = "guest:campaign-only";
    const redditPlayerId = "reddit:campaign-only";
    await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T09:00:00.000Z",
      resultsByRaceId: {},
      updatedAt: "2026-09-01T09:00:00.000Z",
    }));
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed" });
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeUndefined();
  });

  it("leaves a guest with nothing to transfer alone", async () => {
    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:nothing-here",
      redditPlayerId: "reddit:nothing-here",
    });

    expect(selection.required).toBe(false);
    expect(selection.guestHasProgress).toBe(false);
    expect(await resolveAccountTransferState("reddit:nothing-here")).toBeNull();
  });
});

describe("guest transfer ownership conflicts", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("refuses a second guest's transfer while the first is still pending", async () => {
    const redditPlayerId = "reddit:one-at-a-time";
    await seedTransferableGuest("guest:first-in", redditPlayerId);
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({
      guestPlayerId: "guest:first-in",
      redditPlayerId,
      choice: "guest",
    })).rejects.toThrow();

    await expect(selectGuestProgress({
      guestPlayerId: "guest:second-in",
      redditPlayerId,
      choice: "guest",
    })).rejects.toMatchObject({ statusCode: 409, reason: "progress_transfer_pending" });
  });

  it("refuses a different choice once one is recorded", async () => {
    const guestPlayerId = "guest:one-choice";
    const redditPlayerId = "reddit:one-choice";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("guest transfer does not strand the account or the next guest", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("still offers a second guest its own chooser after an earlier transfer completed", async () => {
    const redditPlayerId = "reddit:second-guest";
    await seedTransferableGuest("guest:first-guest", redditPlayerId);
    await selectGuestProgress({
      guestPlayerId: "guest:first-guest",
      redditPlayerId,
      choice: "account",
    });

    await seedTransferableGuest("guest:second-guest", redditPlayerId);
    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:second-guest",
      redditPlayerId,
    });

    expect(selection.required).toBe(true);
    expect(selection.sourceGuestPlayerId).toBe("guest:second-guest");
    await expect(selectGuestProgress({
      guestPlayerId: "guest:second-guest",
      redditPlayerId,
      choice: "guest",
    })).resolves.toMatchObject({ status: "completed", sourceGuestPlayerId: "guest:second-guest" });
  });

  it("stops volunteering an old completion once it is no longer news", async () => {
    const guestPlayerId = "guest:old-news";
    const redditPlayerId = "reddit:old-news";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    const done = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });

    await expect(resolveAccountTransferState(redditPlayerId))
      .resolves.toMatchObject({ state: "completed" });

    const receiptKey = guestProgressTransferReceiptKey(done.transferId);
    const receipt = JSON.parse(await redis.get(receiptKey));
    await redis.set(receiptKey, JSON.stringify({
      ...receipt,
      completedAt: new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString(),
    }));

    await expect(resolveAccountTransferState(redditPlayerId)).resolves.toBeNull();
    await expect(resolveAccountTransferState(redditPlayerId, { transferId: done.transferId }))
      .resolves.toMatchObject({ state: "completed" });
  });

  it("finishes the proven cleanup of an older record instead of sending it to review", async () => {
    const guestPlayerId = "guest:proven-cleanup";
    const redditPlayerId = "reddit:proven-cleanup";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    const challenge = await getServerDailyGpChallenge();
    await redis.set(selectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      version: 2,
      guestPlayerId,
      redditPlayerId,
      choice: "guest",
      status: "pending",
      updatedAt: "2026-08-01T00:00:00.000Z",
      completedDomains: ["campaign", "daily", "unlocks"],
      cleanedDomains: [],
      dailyChallengeIds: [challenge.id],
    }));
    await redis.set(guestProgressSelectionAccountPendingKey(redditPlayerId), guestPlayerId);

    await expect(resolveAccountTransferState(redditPlayerId))
      .resolves.toMatchObject({ state: "resume_required", choice: "guest" });
  });

  it("does not strand a transfer when the Campaign stage list gains a stage", async () => {
    const guestPlayerId = "guest:new-stage";
    const redditPlayerId = "reddit:new-stage";
    await seedTransferableGuest(guestPlayerId, redditPlayerId);
    // The inventory is saved with the first write after the marks.
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();
    const record = await readRecord(guestPlayerId, redditPlayerId);

    const trimmed = { ...record.sourceInventory.campaignStages };
    const [firstStage] = Object.keys(trimmed);
    delete trimmed[firstStage];
    await redis.set(selectionKey(guestPlayerId, redditPlayerId), JSON.stringify({
      ...record,
      phase: "copying",
      sourceInventory: { ...record.sourceInventory, campaignStages: trimmed },
    }));

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed" });
  });
});
