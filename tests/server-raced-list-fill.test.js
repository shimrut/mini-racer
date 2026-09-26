import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();

vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: redis,
}));

const { runRacedListFill, isRacedListFillReady } = await import("../src/server/player/raced-list-fill.ts");
const {
  DAILY_GUEST_EXPIRY_KEY,
  DAILY_GUEST_ROW_KEEP_SECONDS,
  racedListKey,
} = await import("../src/server/player/raced-list.ts");
const { CAMPAIGN_LIVE_STAGES } = await import("../game/campaign/manifest.js");
const { toCampaignCompetition } = await import("../src/server/competition/competition.ts");

const HISTORY_KEY = "dailygp:challenges";
const NOW_MS = Date.parse("2026-09-26T12:00:00.000Z");

function codedName(playerId) {
  return createHash("sha256").update(playerId, "utf8").digest("base64url");
}

async function storeDay(day) {
  await redis.hSet(HISTORY_KEY, { [day]: "{}" });
}

async function runUntilReady(rowsPerRun) {
  let runs = 0;
  for (;;) {
    runs += 1;
    const result = await runRacedListFill(NOW_MS, rowsPerRun);
    if (result.status === "ready") return runs;
    if (runs > 500) throw new Error("fill did not finish");
  }
}

describe("raced list fill", () => {
  beforeEach(() => {
    redis.reset();
  });

  it("lists every stored row, including rank-only, PB-only and damaged rows", async () => {
    const day = "daily-gp-2026-01-01";
    await storeDay(day);
    await redis.hSet(`dailygp:leaderboard:${day}:entries`, { "guest:damaged": "{not json" });
    await redis.zAdd(`dailygp:leaderboard:${day}`, { member: "reddit:rank-only", score: 30000 });
    await redis.hSet(`dailygp:challenge-pbs:${day}`, { [codedName("reddit:pb-only")]: "{}" });
    const stage = CAMPAIGN_LIVE_STAGES[CAMPAIGN_LIVE_STAGES.length - 1];
    const campaign = toCampaignCompetition(stage.seriesId, stage);
    await redis.hSet(campaign.entryHashKey, { "reddit:campaign": "{}" });

    expect(await isRacedListFillReady()).toBe(false);
    await runUntilReady(1000);

    expect(await isRacedListFillReady()).toBe(true);
    expect(await redis.hGet(racedListKey("guest:damaged"), `daily:${day}`)).toBeTruthy();
    expect(await redis.hGet(racedListKey("reddit:rank-only"), `daily:${day}`)).toBeTruthy();
    expect(await redis.hGet(racedListKey("reddit:pb-only"), `daily:${day}`)).toBeTruthy();
    expect(await redis.hGet(racedListKey("reddit:campaign"), `campaign:${stage.raceId}`)).toBeTruthy();
  });

  it("puts a guest's old Daily rows into the guest clean-up a year from the fill", async () => {
    const day = "daily-gp-2026-01-02";
    await storeDay(day);
    await redis.hSet(`dailygp:leaderboard:${day}:entries`, { "guest:old": "{}", "reddit:account": "{}" });

    await runUntilReady(1000);

    expect(await redis.zScore(DAILY_GUEST_EXPIRY_KEY, "guest:old"))
      .toBe(NOW_MS + DAILY_GUEST_ROW_KEEP_SECONDS * 1000);
    expect(await redis.zScore(DAILY_GUEST_EXPIRY_KEY, "reddit:account")).toBeFalsy();
    expect(await redis.expireTime(racedListKey("guest:old"))).toBeGreaterThan(0);
    expect(await redis.expireTime(racedListKey("reddit:account"))).toBeLessThan(0);
  });

  it("stops after its budget and goes on from where it stopped", async () => {
    const days = ["daily-gp-2026-02-01", "daily-gp-2026-02-02"];
    for (const day of days) {
      await storeDay(day);
      for (let index = 0; index < 5; index += 1) {
        await redis.hSet(`dailygp:leaderboard:${day}:entries`, { [`reddit:racer-${index}`]: "{}" });
      }
    }

    const first = await runRacedListFill(NOW_MS, 3);
    expect(first.status).toBe("working");
    expect(await isRacedListFillReady()).toBe(false);

    expect(await runUntilReady(3)).toBeGreaterThan(1);
    for (const day of days) {
      for (let index = 0; index < 5; index += 1) {
        expect(await redis.hGet(racedListKey(`reddit:racer-${index}`), `daily:${day}`)).toBeTruthy();
      }
    }
  });

  it("does not run twice at the same time, and does nothing once ready", async () => {
    await storeDay("daily-gp-2026-03-01");
    await redis.set("miniracer:raced:v1:fill-lock", "another-run");
    expect((await runRacedListFill(NOW_MS)).status).toBe("busy");

    await redis.del("miniracer:raced:v1:fill-lock");
    await runUntilReady(1000);
    expect(await runRacedListFill(NOW_MS)).toEqual({ status: "ready", rows: 0 });
  });
});
