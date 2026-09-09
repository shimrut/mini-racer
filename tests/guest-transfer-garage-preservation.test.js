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

function selectionKey(guestPlayerId, redditPlayerId) {
  return `dailygp:guest-progress-selection:v1:${createHash("sha256")
    .update(`${guestPlayerId}:${redditPlayerId}`, "utf8")
    .digest("base64url")}`;
}

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
