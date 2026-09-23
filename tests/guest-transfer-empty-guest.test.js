import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();
vi.mock("@devvit/redis", () => ({ redis, redisCompressed: redis }));

const {
  getGuestProgressSelection,
  getServerDailyGpChallenge,
  selectGuestProgress,
} = await import("../src/server/daily/daily-gp-store.ts");
const {
  getServerPlayerBootstrap,
} = await import("../src/server/player/player-account-store.ts");
const { recordCompletedRace, retireEmptyGuestIdentity } =
  await import("../src/server/player/car-unlock-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign/campaign-progress-key.js");
const { toDailyCompetition } = await import("../src/server/competition/competition.js");
const { mintGuestPlayerToken } = await import("../src/server/player/player-token.ts");
const {
  guestProgressSelectionPendingKey,
  guestProgressSelectionAccountPendingKey,
} = await import("../src/server/player/guest-retirement.ts");

function selectionKey(guestPlayerId, redditPlayerId) {
  return `dailygp:guest-progress-selection:v1:${createHash("sha256")
    .update(`${guestPlayerId}:${redditPlayerId}`, "utf8")
    .digest("base64url")}`;
}

const CAMPAIGN_RESULT = {
  raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1,
  bestTimeMs: 12_000, medal: "gold", checkpointTimesSec: [4.2, 9.8],
  updatedAt: "2026-09-01T09:30:00.000Z",
};

function progressWith(results) {
  return JSON.stringify({
    campaignId: "numbered-v1",
    startedAt: "2026-09-01T09:00:00.000Z",
    resultsByRaceId: results,
    updatedAt: "2026-09-01T09:30:00.000Z",
  });
}

async function seedVeteranAccount(redditPlayerId) {
  await recordCompletedRace(redditPlayerId);
  await redis.set(campaignProgressKey(redditPlayerId), progressWith({ "numbered-v1-00": CAMPAIGN_RESULT }));
  const competition = toDailyCompetition(await getServerDailyGpChallenge());
  await redis.hSet(competition.entryHashKey, { [redditPlayerId]: "account-daily-row" });
  return competition;
}

async function expectAccountUntouched(redditPlayerId, competition) {
  expect(JSON.parse(await redis.get(campaignProgressKey(redditPlayerId))).resultsByRaceId)
    .toHaveProperty("numbered-v1-00");
  expect(await redis.hGet(competition.entryHashKey, redditPlayerId)).toBe("account-daily-row");
}

async function expectNothingRecorded(guestPlayerId, redditPlayerId) {
  expect(await redis.get(selectionKey(guestPlayerId, redditPlayerId))).toBeUndefined();
  expect(await redis.get(guestProgressSelectionAccountPendingKey(redditPlayerId))).toBeUndefined();
}

describe("a new transfer from a guest with nothing to carry is refused", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("refuses a Guest choice for a guest that sign-in already retired as empty", async () => {
    const guestPlayerId = "guest:retired-empty";
    const redditPlayerId = "reddit:retired-empty";
    const competition = await seedVeteranAccount(redditPlayerId);
    expect((await getGuestProgressSelection({ guestPlayerId, redditPlayerId })).required).toBe(false);
    await retireEmptyGuestIdentity({ guestPlayerId, redditPlayerId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ statusCode: 409, reason: "guest_progress_transfer_not_needed" });

    await expectAccountUntouched(redditPlayerId, competition);
    await expectNothingRecorded(guestPlayerId, redditPlayerId);
  });

  for (const choice of ["guest", "account"]) {
    it(`refuses a${choice === "account" ? "n Account" : " Guest"} choice for an empty guest that was never retired`, async () => {
      const guestPlayerId = `guest:never-retired-${choice}`;
      const redditPlayerId = `reddit:never-retired-${choice}`;
      const competition = await seedVeteranAccount(redditPlayerId);
      await redis.set(campaignProgressKey(guestPlayerId), JSON.stringify({
        campaignId: "numbered-v1", startedAt: null, resultsByRaceId: {}, updatedAt: null,
      }));

      await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice }))
        .rejects.toMatchObject({ statusCode: 409, reason: "guest_progress_transfer_not_needed" });

      await expectAccountUntouched(redditPlayerId, competition);
      await expectNothingRecorded(guestPlayerId, redditPlayerId);
    });
  }

  it("sends a guest joined to another account to review before touching this one", async () => {
    const guestPlayerId = "guest:joined-elsewhere";
    const firstAccount = "reddit:first-owner";
    const secondAccount = "reddit:second-owner";
    await recordCompletedRace(guestPlayerId);
    await redis.set(campaignProgressKey(guestPlayerId), progressWith({ "numbered-v1-00": CAMPAIGN_RESULT }));
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId: firstAccount });
    await selectGuestProgress({ guestPlayerId, redditPlayerId: firstAccount, choice: "guest" });
    const competition = await seedVeteranAccount(secondAccount);

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId: secondAccount, choice: "guest" }))
      .rejects.toMatchObject({ statusCode: 409, reason: "guest_progress_recovery_required" });

    await expectAccountUntouched(secondAccount, competition);
    await expectNothingRecorded(guestPlayerId, secondAccount);
  });

  it("lets a guest whose only row cannot be read go on to the transfer's own checks", async () => {
    const guestPlayerId = "guest:unreadable";
    const redditPlayerId = "reddit:unreadable";
    await redis.set(campaignProgressKey(guestPlayerId), "{not json");

    const outcome = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" })
      .catch((error) => error);

    expect(outcome?.reason).not.toBe("guest_progress_transfer_not_needed");
  });

  it("still answers a repeated request for a transfer that completed and joined the guest", async () => {
    const guestPlayerId = "guest:replayed";
    const redditPlayerId = "reddit:replayed";
    await recordCompletedRace(guestPlayerId);
    await redis.set(campaignProgressKey(guestPlayerId), progressWith({ "numbered-v1-00": CAMPAIGN_RESULT }));
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });
    const first = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .resolves.toMatchObject({ status: "completed", transferId: first.transferId });
    await expect(selectGuestProgress({
      guestPlayerId, redditPlayerId, choice: "guest", resume: true, transferId: first.transferId,
    })).resolves.toMatchObject({ status: "completed", transferId: first.transferId });
  });
});

describe("sign-in tells the browser when an empty guest joined the account", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("says so on the sign-in that retires the guest, and on every later one", async () => {
    const guestToken = await mintGuestPlayerToken("empty-at-sign-in");

    const first = await getServerPlayerBootstrap({ redditUsername: "joiner", guestToken });
    const again = await getServerPlayerBootstrap({ redditUsername: "joiner", guestToken });

    for (const payload of [first, again]) {
      expect(payload.retireGuestIdentity).toBe(true);
      expect(payload.guestJoinedAccount).toBe(true);
      expect(payload.progressSelection).toBeUndefined();
    }
    expect(await redis.get(guestProgressSelectionPendingKey("guest:empty-at-sign-in"))).toBeUndefined();
  });

  it("does not say so for a guest that a transfer carried", async () => {
    const guestPlayerId = "guest:carried";
    const guestToken = await mintGuestPlayerToken("carried");
    await recordCompletedRace(guestPlayerId);
    await redis.set(campaignProgressKey(guestPlayerId), progressWith({ "numbered-v1-00": CAMPAIGN_RESULT }));
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId: "reddit:carrier" });
    await selectGuestProgress({ guestPlayerId, redditPlayerId: "reddit:carrier", choice: "guest" });

    const payload = await getServerPlayerBootstrap({ redditUsername: "carrier", guestToken });

    expect(payload.retireGuestIdentity).toBe(true);
    expect(payload.guestJoinedAccount).toBeUndefined();
  });

  it("does not say so for a guest joined to another account", async () => {
    const guestToken = await mintGuestPlayerToken("elsewhere");
    await retireEmptyGuestIdentity({ guestPlayerId: "guest:elsewhere", redditPlayerId: "reddit:someone-else" });

    const payload = await getServerPlayerBootstrap({ redditUsername: "not-them", guestToken });

    expect(payload.retireGuestIdentity).toBe(true);
    expect(payload.guestJoinedAccount).toBeUndefined();
  });
});
