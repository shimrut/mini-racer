import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();
vi.mock("@devvit/redis", () => ({ redis, redisCompressed: redis }));

const { getGuestProgressSelection, selectGuestProgress } =
  await import("../src/server/daily-gp-store.ts");
const {
  carUnlockHashKey,
  recordCompletedRace,
  recordHeadToHeadPost,
  recordHeadToHeadWin,
} = await import("../src/server/car-unlock-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign-progress-key.js");

const accountHash = (playerId) => createHash("sha256").update(playerId, "utf8").digest("base64url");
const baselineKey = (playerId) => `miniracer:car-unlocks:transfer-baseline:v1:${accountHash(playerId)}`;
const journalKey = (playerId) => `miniracer:car-unlocks:transfer-journal:v1:${accountHash(playerId)}`;

function selectionKey(guestPlayerId, redditPlayerId) {
  return `dailygp:guest-progress-selection:v1:${createHash("sha256")
    .update(`${guestPlayerId}:${redditPlayerId}`, "utf8")
    .digest("base64url")}`;
}

const RESULT = {
  raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1,
  bestTimeMs: 12_000, medal: "gold", checkpointTimesSec: [4.2, 9.8],
  updatedAt: "2026-09-01T09:30:00.000Z",
};

async function seedGuest(guestPlayerId, redditPlayerId) {
  await recordCompletedRace(guestPlayerId);
  await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
    campaignId: "numbered-v1",
    startedAt: "2026-09-01T09:00:00.000Z",
    resultsByRaceId: {
      "numbered-v1-00": {
        raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1,
        bestTimeMs: 12_000, medal: "gold", checkpointTimesSec: [4.2, 9.8],
        updatedAt: "2026-09-01T09:30:00.000Z",
      },
    },
    updatedAt: "2026-09-01T09:30:00.000Z",
  }));
  await getGuestProgressSelection({ guestPlayerId, redditPlayerId });
}

/** Stops the transfer after preparation froze the baseline, leaving it open in `copying`. */
async function interruptAfterPreparation(guestPlayerId, redditPlayerId) {
  redis.failTransferRecordWriteAt = 3;
  await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
    .rejects.toThrow();
  redis.failTransferRecordWriteAt = null;
  const record = JSON.parse(await redis.get(selectionKey(guestPlayerId, redditPlayerId)));
  expect(record.phase).toBe("copying");
}

describe("Garage rewards earned during a transfer survive replacement", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("keeps a reward the account earned for the first time after the choice", async () => {
    const guestPlayerId = "guest:new-reward";
    const redditPlayerId = "reddit:new-reward";
    await seedGuest(guestPlayerId, redditPlayerId);
    await interruptAfterPreparation(guestPlayerId, redditPlayerId);

    await recordHeadToHeadPost(redditPlayerId, "numberZero");
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect((await redis.hGetAll(carUnlockHashKey(redditPlayerId)))["post:track:numberZero"])
      .toBe("1");
  });

  it("keeps a reward earned again whose ordinary write was a no-op", async () => {
    const guestPlayerId = "guest:repeat-reward";
    const redditPlayerId = "reddit:repeat-reward";
    // Held before the choice, so the baseline names it and replacement would remove it.
    await recordHeadToHeadPost(redditPlayerId, "numberZero");
    await seedGuest(guestPlayerId, redditPlayerId);
    await interruptAfterPreparation(guestPlayerId, redditPlayerId);

    // Earned again. The field is already "1", so the hash does not change and only the
    // journal records that it happened.
    await recordHeadToHeadPost(redditPlayerId, "numberZero");
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect((await redis.hGetAll(carUnlockHashKey(redditPlayerId)))["post:track:numberZero"])
      .toBe("1");
  });

  it("keeps a reward accepted past its event cap", async () => {
    const guestPlayerId = "guest:capped-reward";
    const redditPlayerId = "reddit:capped-reward";
    for (const trackKey of ["numberZero", "numberOne", "numberTwo", "numberThree", "numberFour"]) {
      await recordHeadToHeadPost(redditPlayerId, trackKey);
    }
    await seedGuest(guestPlayerId, redditPlayerId);
    await interruptAfterPreparation(guestPlayerId, redditPlayerId);

    // A sixth post is accepted, but the cap stops the hash write.
    await recordHeadToHeadPost(redditPlayerId, "numberFive");
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect((await redis.hGetAll(carUnlockHashKey(redditPlayerId)))["post:track:numberFive"])
      .toBe("1");
  });

  it("still discards a pre-choice reward that was not earned again", async () => {
    const guestPlayerId = "guest:discarded";
    const redditPlayerId = "reddit:discarded";
    await recordHeadToHeadPost(redditPlayerId, "numberZero");
    await seedGuest(guestPlayerId, redditPlayerId);

    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    const after = await redis.hGetAll(carUnlockHashKey(redditPlayerId));
    expect(after["post:track:numberZero"]).toBeUndefined();
    expect(after["race:completed"]).toBe("1");
  });

  it("does not recapture the baseline when preparation runs again", async () => {
    const guestPlayerId = "guest:frozen-baseline";
    const redditPlayerId = "reddit:frozen-baseline";
    await seedGuest(guestPlayerId, redditPlayerId);
    // Stop inside preparation, so the next attempt re-enters it.
    redis.failTransferRecordWriteAt = 2;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();
    redis.failTransferRecordWriteAt = null;

    // A reward lands before the retry. A recaptured baseline would swallow it.
    await recordHeadToHeadWin(redditPlayerId, "challenge-1");
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect((await redis.hGetAll(carUnlockHashKey(redditPlayerId)))["win:challenge:challenge-1"])
      .toBe("1");
  });
});

describe("a legitimate late guest event does not strand the transfer", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("completes after the guest gains one more valid event", async () => {
    const guestPlayerId = "guest:late-event";
    const redditPlayerId = "reddit:late-event";
    await seedGuest(guestPlayerId, redditPlayerId);
    await interruptAfterPreparation(guestPlayerId, redditPlayerId);

    await recordHeadToHeadPost(guestPlayerId, "numberZero");
    const result = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect(result.status).toBe("completed");
    // The addition came across with the rest.
    expect((await redis.hGetAll(carUnlockHashKey(redditPlayerId)))["post:track:numberZero"])
      .toBe("1");
  });

  it("still stops when a recorded guest field disappears", async () => {
    const guestPlayerId = "guest:lost-event";
    const redditPlayerId = "reddit:lost-event";
    await seedGuest(guestPlayerId, redditPlayerId);
    await interruptAfterPreparation(guestPlayerId, redditPlayerId);

    await redis.del(carUnlockHashKey(guestPlayerId));

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
  });

  it("still stops when an addition is not an ordinary Garage event", async () => {
    const guestPlayerId = "guest:bad-event";
    const redditPlayerId = "reddit:bad-event";
    await seedGuest(guestPlayerId, redditPlayerId);
    await interruptAfterPreparation(guestPlayerId, redditPlayerId);

    await redis.hSet(carUnlockHashKey(guestPlayerId), { "car:granted:gold": "1" });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
  });
});

describe("an older interrupted transfer gets no invented baseline", () => {
  beforeEach(() => { redis.reset(); vi.restoreAllMocks(); vi.spyOn(console,"error").mockImplementation(()=>{}); });

  it("keeps an interruption reward on an older record with no baseline", async () => {
    const g = "guest:old-record", r = "reddit:old-record";
    await recordCompletedRace(g);
    await redis.set(campaignProgressKey(g), JSON.stringify({
      campaignId: "numbered-v1", startedAt: "2026-09-01T09:00:00.000Z",
      resultsByRaceId: { "numbered-v1-00": RESULT }, updatedAt: "2026-09-01T09:30:00.000Z" }));
    await getGuestProgressSelection({ guestPlayerId: g, redditPlayerId: r });
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({ guestPlayerId: g, redditPlayerId: r, choice: "guest" })).rejects.toThrow();
    redis.failTransferRecordWriteAt = null;
    // Simulate a record written before baselines existed.
    await redis.del(`miniracer:car-unlocks:transfer-baseline:v1:${createHash("sha256").update(r,"utf8").digest("base64url")}`);
    await recordHeadToHeadPost(r, "numberZero");

    await selectGuestProgress({ guestPlayerId: g, redditPlayerId: r, choice: "guest" });
    expect((await redis.hGetAll(carUnlockHashKey(r)))["post:track:numberZero"]).toBe("1");
  });
});

describe("a Garage evidence cleanup that fails cannot spoil the next transfer", () => {
  const GUEST = "guest:evidence";
  const ACCOUNT = "reddit:evidence";
  const NEXT_GUEST = "guest:evidence-second";

  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("completes the transfer and reports the refused delete rather than failing", async () => {
    await seedGuest(GUEST, ACCOUNT);
    await recordCompletedRace(ACCOUNT);

    redis.failDelKeys = new Set(["transfer-baseline"]);
    const result = await selectGuestProgress({
      guestPlayerId: GUEST, redditPlayerId: ACCOUNT, choice: "guest",
    });

    // A cleanup is housekeeping. It must never turn a committed transfer into a failure.
    expect(result.status).toBe("completed");
    expect(await redis.get(baselineKey(ACCOUNT))).not.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("attempts the journal delete even when the baseline delete is refused", async () => {
    await seedGuest(GUEST, ACCOUNT);
    await recordCompletedRace(ACCOUNT);
    // The journal only records while a baseline is open, so the reward has to be earned after
    // preparation froze one. Without this the journal is empty and proves nothing.
    await interruptAfterPreparation(GUEST, ACCOUNT);
    await recordHeadToHeadWin(ACCOUNT, "duringTransfer");
    expect(Object.keys(await redis.hGetAll(journalKey(ACCOUNT)))).toContain("win:challenge:duringTransfer");

    redis.failDelKeys = new Set(["transfer-baseline"]);
    await selectGuestProgress({ guestPlayerId: GUEST, redditPlayerId: ACCOUNT, choice: "guest" });

    // Awaited in sequence, a refused baseline delete skipped its partner and left both keys.
    expect(await redis.hGetAll(journalKey(ACCOUNT))).toEqual({});
  });

  it("does not replace the next transfer against a baseline frozen for the last one", async () => {
    await seedGuest(GUEST, ACCOUNT);
    await recordHeadToHeadPost(ACCOUNT, "givenUpTrack");

    // The first transfer's cleanup is refused, so its baseline outlives it.
    redis.failDelKeys = new Set(["transfer-baseline"]);
    await selectGuestProgress({ guestPlayerId: GUEST, redditPlayerId: ACCOUNT, choice: "guest" });
    const leaked = JSON.parse(await redis.get(baselineKey(ACCOUNT)));

    // A second guest, a second Guest choice. Its baseline must describe the Garage as it stands
    // now, not the one the first transfer froze. The delete stays refused so it survives to be read.
    await seedGuest(NEXT_GUEST, ACCOUNT);
    await recordHeadToHeadWin(ACCOUNT, "earnedBeforeSecondChoice");
    const beforeSecondChoice = await redis.hGetAll(carUnlockHashKey(ACCOUNT));

    await selectGuestProgress({ guestPlayerId: NEXT_GUEST, redditPlayerId: ACCOUNT, choice: "guest" });

    const captured = JSON.parse(await redis.get(baselineKey(ACCOUNT)));
    expect(captured.transferId).not.toBe(leaked.transferId);
    expect(captured.fields).toEqual(beforeSecondChoice);
    expect(Object.keys(captured.fields)).toContain("win:challenge:earnedBeforeSecondChoice");
  });
});
