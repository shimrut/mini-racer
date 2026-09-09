import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();
vi.mock("@devvit/redis", () => ({ redis, redisCompressed: redis }));

const { getGuestProgressSelection, selectGuestProgress } =
  await import("../src/server/daily-gp-store.ts");
const { recordCompletedRace } = await import("../src/server/car-unlock-store.ts");
const { campaignProgressKey } = await import("../src/server/campaign-progress-key.js");
const { cleanupExpiredCampaignGuests, CAMPAIGN_GUEST_EXPIRY_KEY } =
  await import("../src/server/campaign-store.ts");
const { classifyStoredPbRecordValue } = await import("../src/server/pb-ghost-store.ts");
const { classifyStoredCampaignProgress } =
  await import("../src/server/guest-transfer-source-classification.ts");
const { toCampaignCompetition } = await import("../src/server/competition.ts");


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

const EARNED_RESULT = {
  raceId: "numbered-v1-00",
  trackKey: "numberZero",
  lapCount: 2,
  rulesRevision: 1,
  bestTimeMs: 12_000,
  medal: "gold",
  checkpointTimesSec: [4.2, 9.8],
  updatedAt: "2026-09-01T09:30:00.000Z",
};

function campaignProgress(result, overrides = {}) {
  return JSON.stringify({
    campaignId: "numbered-v1",
    startedAt: "2026-09-01T09:00:00.000Z",
    resultsByRaceId: result ? { "numbered-v1-00": result } : {},
    updatedAt: "2026-09-01T09:30:00.000Z",
    ...overrides,
  });
}

/** An account that already earned something, so a wrong replacement is visible. */
async function seedAccountWithEarnedResult(redditPlayerId) {
  await redis.set(campaignProgressKey(redditPlayerId), campaignProgress(EARNED_RESULT));
}

async function seedGuest(guestPlayerId, redditPlayerId, rawProgress) {
  await recordCompletedRace(guestPlayerId);
  await redis.set(campaignProgressKey(guestPlayerId), rawProgress);
  await getGuestProgressSelection({ guestPlayerId, redditPlayerId });
}

describe("a malformed Campaign source cannot replace an account", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  for (const [name, rawProgress] of [
    ["damaged JSON", '{"campaignId":"numbered-v1","resultsByRaceId":{ TRUNCATED'],
    ["another campaign's progress", campaignProgress(EARNED_RESULT, { campaignId: "other-v9" })],
    ["a result with no usable time", campaignProgress({ ...EARNED_RESULT, bestTimeMs: "fast" })],
    ["a result with no usable timestamp", campaignProgress({ ...EARNED_RESULT, updatedAt: 17 })],
    ["a result whose key names another race", campaignProgress({ ...EARNED_RESULT, raceId: "numbered-v1-07" })],
  ]) {
    it(`stops for review and keeps both sides: ${name}`, async () => {
      const guestPlayerId = `guest:malformed-${name.replace(/\W+/g, "-")}`;
      const redditPlayerId = `reddit:malformed-${name.replace(/\W+/g, "-")}`;
      await seedAccountWithEarnedResult(redditPlayerId);
      await seedGuest(guestPlayerId, redditPlayerId, rawProgress);

      await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
        .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

      // The account keeps the result it earned.
      const account = JSON.parse(await redis.get(campaignProgressKey(redditPlayerId)));
      expect(account.resultsByRaceId["numbered-v1-00"]).toMatchObject({ bestTimeMs: 12_000 });
      // The evidence a reviewer needs is still there.
      expect(await redis.get(campaignProgressKey(guestPlayerId))).toBe(rawProgress);
      // Nothing claims the domain was copied.
      const record = JSON.parse(await redis.get(selectionKey(guestPlayerId, redditPlayerId)));
      expect(record.completedDomains).not.toContain("campaign");
    });
  }

  it("treats a retired stage as a supported change, not as damage", async () => {
    const guestPlayerId = "guest:retired-stage";
    const redditPlayerId = "reddit:retired-stage";
    await seedGuest(guestPlayerId, redditPlayerId, JSON.stringify({
      campaignId: "numbered-v1",
      startedAt: "2026-09-01T09:00:00.000Z",
      resultsByRaceId: {
        "numbered-v1-00": EARNED_RESULT,
        "numbered-v1-retired": { ...EARNED_RESULT, raceId: "numbered-v1-retired" },
      },
      updatedAt: "2026-09-01T09:30:00.000Z",
    }));

    const result = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect(result.status).toBe("completed");
    const account = JSON.parse(await redis.get(campaignProgressKey(redditPlayerId)));
    expect(account.resultsByRaceId["numbered-v1-00"]).toMatchObject({ bestTimeMs: 12_000 });
  });

  it("still completes an ordinary Guest transfer", async () => {
    const guestPlayerId = "guest:clean";
    const redditPlayerId = "reddit:clean";
    await seedGuest(guestPlayerId, redditPlayerId, campaignProgress(EARNED_RESULT));

    const result = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" });

    expect(result.status).toBe("completed");
    const account = JSON.parse(await redis.get(campaignProgressKey(redditPlayerId)));
    expect(account.resultsByRaceId["numbered-v1-00"]).toMatchObject({ bestTimeMs: 12_000 });
    expect(await redis.get(campaignProgressKey(guestPlayerId))).toBeFalsy();
  });

  it("leaves an Account choice alone: it replaces nothing, so it needs no source validation", async () => {
    const guestPlayerId = "guest:account-choice";
    const redditPlayerId = "reddit:account-choice";
    await seedAccountWithEarnedResult(redditPlayerId);
    await seedGuest(guestPlayerId, redditPlayerId, '{"campaignId":"numbered-v1","resultsBy TRUNCATED');

    const result = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "account" });

    expect(result.status).toBe("completed");
    const account = JSON.parse(await redis.get(campaignProgressKey(redditPlayerId)));
    expect(account.resultsByRaceId["numbered-v1-00"]).toMatchObject({ bestTimeMs: 12_000 });
  });
});

describe("damage is never treated as absent or obsolete", () => {
  beforeEach(() => { redis.reset(); vi.restoreAllMocks(); vi.spyOn(console,"error").mockImplementation(()=>{}); });

  it("a null Campaign result is damage, not absence", () => {
    const c = classifyStoredCampaignProgress(JSON.stringify({
      campaignId: "numbered-v1", resultsByRaceId: { "numbered-v1-00": null },
    }));
    expect(c.state).toBe("malformed");
  });

  it("a null result stops the transfer and keeps both sides", async () => {
    const g = "guest:null-row", r = "reddit:null-row";
    await recordCompletedRace(g);
    await redis.set(campaignProgressKey(g), JSON.stringify({
      campaignId: "numbered-v1", resultsByRaceId: { "numbered-v1-00": null } }));
    await redis.set(campaignProgressKey(r), JSON.stringify({
      campaignId: "numbered-v1", resultsByRaceId: { "numbered-v1-00": RESULT } }));
    await getGuestProgressSelection({ guestPlayerId: g, redditPlayerId: r });
    await expect(selectGuestProgress({ guestPlayerId: g, redditPlayerId: r, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });
    expect(JSON.parse(await redis.get(campaignProgressKey(r))).resultsByRaceId["numbered-v1-00"])
      .toMatchObject({ bestTimeMs: 12000 });
    expect(await redis.get(campaignProgressKey(g))).toBeTruthy();
  });

  it("a PB with a wrong-typed revision is damage, not obsolete", () => {
    const stage = { raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1 };
    const comp = toCampaignCompetition("numbered-v1", stage, { playerId: "guest:x" });
    const c = classifyStoredPbRecordValue(JSON.stringify({
      schemaVersion: 2, trackKey: "numberZero", trackFingerprint: "zz",
      simulationRevision: 1, rulesRevision: "broken", lapCount: 2,
      bestTimeMs: 12000, updatedAt: "2026-09-01T09:30:00.000Z",
    }), comp, "zz", { rulesRevision: 1, lapCount: 2 });
    expect(c.state).toBe("malformed");
  });
});

describe("a source held for review is still enrolled for collection", () => {
  beforeEach(() => { redis.reset(); vi.restoreAllMocks(); vi.spyOn(console,"error").mockImplementation(()=>{}); });

  it("enrols a PB-only guest and lets a later sweep collect it", async () => {
    const g = "guest:pb-only", r = "reddit:pb-only";
    const stage = { raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1 };
    const comp = toCampaignCompetition("numbered-v1", stage, { playerId: g });
    const field = createHash("sha256").update(g, "utf8").digest("base64url");
    await recordCompletedRace(g);
    // A damaged PB alongside a readable row that dates the source. No progress write ever
    // enrolled this guest, because the row was seeded directly.
    await redis.hSet(comp.pbHashKey, { [field]: "{ not json" });
    await redis.set(campaignProgressKey(g), JSON.stringify({
      campaignId: "numbered-v1", startedAt: "2026-09-01T09:00:00.000Z",
      resultsByRaceId: { "numbered-v1-00": RESULT }, updatedAt: "2026-09-01T09:30:00.000Z" }));
    await getGuestProgressSelection({ guestPlayerId: g, redditPlayerId: r });

    await expect(selectGuestProgress({ guestPlayerId: g, redditPlayerId: r, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    // The source is kept for review...
    expect(await redis.hGet(comp.pbHashKey, field)).toBe("{ not json");
    // ...and it is now on the ledger, so it does not live for ever.
    const score = await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, g);
    expect(Number.isFinite(Number(score))).toBe(true);
    const collected = await cleanupExpiredCampaignGuests(Date.now() + 2 * 365 * 86400000);
    expect(collected).toBeGreaterThan(0);
    expect(await redis.hGet(comp.pbHashKey, field)).toBeFalsy();
  });

  it("does not invent a deadline when nothing in the source carries a timestamp", async () => {
    const g = "guest:no-timestamp", r = "reddit:no-timestamp";
    const stage = { raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1 };
    const comp = toCampaignCompetition("numbered-v1", stage, { playerId: g });
    const field = createHash("sha256").update(g, "utf8").digest("base64url");
    await recordCompletedRace(g);
    await redis.hSet(comp.pbHashKey, { [field]: "{ not json" });
    await getGuestProgressSelection({ guestPlayerId: g, redditPlayerId: r });

    await expect(selectGuestProgress({ guestPlayerId: g, redditPlayerId: r, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    // Choosing a deadline here would be inventing one, so it is reported instead.
    const score = await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, g);
    expect(Number.isFinite(Number(score))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("explicit decision"),
      g,
    );
  });
});

describe("a damaged leaderboard entry is damage, not obsolescence", () => {
  beforeEach(() => {
    redis.reset();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("classifies a wrong-typed lap count as malformed", async () => {
    const { classifyStoredLeaderboardEntry } =
      await import("../src/server/guest-transfer-source-classification.ts");

    const classification = classifyStoredLeaderboardEntry(
      JSON.stringify({
        playerId: "guest:x",
        bestTimeMs: 12_000,
        updatedAt: "2026-09-01T09:30:00.000Z",
        trackKey: "numberZero",
        completedLaps: "broken",
        validationMethod: "strict-replay",
      }),
      "guest:x",
      { trackKey: "numberZero", lapCount: 2 },
    );

    expect(classification.state).toBe("malformed");
  });

  it("stops rather than deleting the entry and emptying the account", async () => {
    const guestPlayerId = "guest:broken-entry";
    const redditPlayerId = "reddit:broken-entry";
    const competition = toCampaignCompetition(
      "numbered-v1",
      { raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1 },
      { playerId: guestPlayerId },
    );
    const damagedEntry = JSON.stringify({
      playerId: guestPlayerId,
      bestTimeMs: 12_000,
      updatedAt: "2026-09-01T09:30:00.000Z",
      trackKey: "numberZero",
      completedLaps: "broken",
      validationMethod: "strict-replay",
    });

    await seedAccountWithEarnedResult(redditPlayerId);
    await recordCompletedRace(guestPlayerId);
    await redis.hSet(competition.entryHashKey, { [guestPlayerId]: damagedEntry });
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    const account = JSON.parse(await redis.get(campaignProgressKey(redditPlayerId)));
    expect(account.resultsByRaceId["numbered-v1-00"]).toMatchObject({ bestTimeMs: 12_000 });
    expect(await redis.hGet(competition.entryHashKey, guestPlayerId)).toBe(damagedEntry);
  });

  it("dates a held source from a damaged record that still says when it was written", async () => {
    const guestPlayerId = "guest:damaged-but-dated";
    const redditPlayerId = "reddit:damaged-but-dated";
    const competition = toCampaignCompetition(
      "numbered-v1",
      { raceId: "numbered-v1-00", trackKey: "numberZero", lapCount: 2, rulesRevision: 1 },
      { playerId: guestPlayerId },
    );
    const field = createHash("sha256").update(guestPlayerId, "utf8").digest("base64url");

    await recordCompletedRace(guestPlayerId);
    // Damaged in its revision field, honest about its timestamp, and the only thing this guest
    // has. Nothing else can date the source.
    await redis.hSet(competition.pbHashKey, {
      [field]: JSON.stringify({
        schemaVersion: 2,
        trackKey: "numberZero",
        trackFingerprint: "zz",
        simulationRevision: 1,
        rulesRevision: "broken",
        lapCount: 2,
        bestTimeMs: 12_000,
        updatedAt: "2026-09-01T09:30:00.000Z",
      }),
    });
    await getGuestProgressSelection({ guestPlayerId, redditPlayerId });

    await expect(selectGuestProgress({ guestPlayerId, redditPlayerId, choice: "guest" }))
      .rejects.toMatchObject({ reason: "guest_progress_recovery_required" });

    const score = await redis.zScore(CAMPAIGN_GUEST_EXPIRY_KEY, guestPlayerId);
    expect(Number.isFinite(Number(score))).toBe(true);
    // One retention period after the record said it was written, not a fresh term from today.
    expect(Number(score)).toBe(Date.parse("2026-09-01T09:30:00.000Z") + 365 * 24 * 60 * 60 * 1000);
  });
});
