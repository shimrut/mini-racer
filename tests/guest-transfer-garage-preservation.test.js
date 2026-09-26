import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();
vi.mock("@devvit/redis", () => ({ redis, redisCompressed: redis }));

const { getGuestProgressSelection, selectGuestProgress } =
  await import("../src/server/daily/daily-gp-store.ts");
const {
  carUnlockHashKey,
  recordCompletedRace,
  recordHeadToHeadPost,
  recordHeadToHeadWin,
  settleOwedRewards,
} = await import("../src/server/player/car-unlock-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign/campaign-progress-key.js");


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

async function interruptAfterPreparation(guestPlayerId, redditPlayerId) {
  redis.failTransferRecordWriteAt = 3;
  await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
    .rejects.toThrow();
  redis.failTransferRecordWriteAt = null;
  const record = JSON.parse(await redis.get(selectionKey(guestPlayerId, redditPlayerId)));
  expect(record.phase).toBe("copying");
}

describe("Garage rewards earned during a transfer survive it", () => {
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
    await recordHeadToHeadPost(redditPlayerId, "numberZero");
    await seedGuest(guestPlayerId, redditPlayerId);
    await interruptAfterPreparation(guestPlayerId, redditPlayerId);

    await recordHeadToHeadPost(redditPlayerId, "numberZero");
    await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect((await redis.hGetAll(carUnlockHashKey(redditPlayerId)))["post:track:numberZero"])
      .toBe("1");
  });

  it("keeps a reward the account earns while a transfer waits to be retried", async () => {
    const guestPlayerId = "guest:frozen-baseline";
    const redditPlayerId = "reddit:frozen-baseline";
    await seedGuest(guestPlayerId, redditPlayerId);
    redis.failTransferRecordWriteAt = 2;
    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toThrow();
    redis.failTransferRecordWriteAt = null;

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

describe("an interrupted transfer keeps the account's rewards", () => {
  beforeEach(() => { redis.reset(); vi.restoreAllMocks(); vi.spyOn(console,"error").mockImplementation(()=>{}); });

  it("keeps a reward the account earns after the transfer stopped partway", async () => {
    const g = "guest:old-record", r = "reddit:old-record";
    await recordCompletedRace(g);
    await redis.set(campaignProgressKey(g), JSON.stringify({
      campaignId: "numbered-v1", startedAt: "2026-09-01T09:00:00.000Z",
      resultsByRaceId: { "numbered-v1-00": RESULT }, updatedAt: "2026-09-01T09:30:00.000Z" }));
    await getGuestProgressSelection({ guestPlayerId: g, redditPlayerId: r });
    redis.failTransferRecordWriteAt = 3;
    await expect(selectGuestProgress({ guestPlayerId: g, redditPlayerId: r, choice: "guest" })).rejects.toThrow();
    redis.failTransferRecordWriteAt = null;
    await recordHeadToHeadPost(r, "numberZero");

    await selectGuestProgress({ guestPlayerId: g, redditPlayerId: r, choice: "guest" });
    expect((await redis.hGetAll(carUnlockHashKey(r)))["post:track:numberZero"]).toBe("1");
  });
});

describe("the transfer's logging names no player", () => {
  const GUEST = "guest:quiet";
  const ACCOUNT = "reddit:quiet";

  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  function loggedArguments() {
    return [...console.error.mock.calls, ...console.log.mock.calls]
      .flat()
      .map((argument) => (typeof argument === "string" ? argument : JSON.stringify(argument) ?? ""));
  }

  it("keeps both identities out of a completed transfer's logging", async () => {
    await seedGuest(GUEST, ACCOUNT);
    await selectGuestProgress({ guestPlayerId: GUEST, redditPlayerId: ACCOUNT, choice: "guest" });

    for (const argument of loggedArguments()) {
      expect(argument).not.toMatch(/reddit:/);
      expect(argument).not.toMatch(/guest:/);
    }
  });
});
