import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();

vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: redis,
}));

const {
  runRacedListFill,
  isRacedListFillReady,
  readRacedListFillStatus,
} = await import("../src/server/player/raced-list-fill.ts");
const {
  DAILY_GUEST_EXPIRY_KEY,
  DAILY_GUEST_ROW_KEEP_SECONDS,
  racedListKey,
} = await import("../src/server/player/raced-list.ts");
const { CAMPAIGN_LIVE_STAGES } = await import("../game/campaign/manifest.js");
const { toCampaignCompetition } = await import("../src/server/competition/competition.ts");

const HISTORY_KEY = "dailygp:challenges";
const NOW_MS = Date.parse("2026-09-26T12:00:00.000Z");
// The walk starts 10 minutes after the first run.
const START_MS = NOW_MS + 10 * 60 * 1000;

function codedName(playerId) {
  return createHash("sha256").update(playerId, "utf8").digest("base64url");
}

async function storeDay(day) {
  await redis.hSet(HISTORY_KEY, { [day]: "{}" });
}

async function runUntilReady(rowsPerRun) {
  await runRacedListFill(NOW_MS, rowsPerRun);
  let runs = 0;
  for (;;) {
    runs += 1;
    const result = await runRacedListFill(START_MS, rowsPerRun);
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
      .toBe(START_MS + DAILY_GUEST_ROW_KEEP_SECONDS * 1000);
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

    await runRacedListFill(NOW_MS, 3);
    const first = await runRacedListFill(START_MS, 3);
    // The budget is checked after each page, so a run ends after the page
    // that reached it.
    expect(first).toEqual({ status: "working", rows: 5 });
    expect(await isRacedListFillReady()).toBe(false);

    await runUntilReady(3);
    for (const day of days) {
      for (let index = 0; index < 5; index += 1) {
        expect(await redis.hGet(racedListKey(`reddit:racer-${index}`), `daily:${day}`)).toBeTruthy();
      }
    }
  });

  it("waits 10 minutes after its first run before it walks any board", async () => {
    const day = "daily-gp-2026-04-01";
    await storeDay(day);
    await redis.hSet(`dailygp:leaderboard:${day}:entries`, { "reddit:early": "{}" });

    expect(await runRacedListFill(NOW_MS)).toEqual({ status: "working", rows: 0 });
    expect(await runRacedListFill(START_MS - 1)).toEqual({ status: "working", rows: 0 });
    expect(await redis.hGet(racedListKey("reddit:early"), `daily:${day}`)).toBeFalsy();

    expect((await runRacedListFill(START_MS)).status).toBe("ready");
    expect(await redis.hGet(racedListKey("reddit:early"), `daily:${day}`)).toBeTruthy();
  });

  it("reports its progress, and logs one line when it is done", async () => {
    const days = ["daily-gp-2026-05-01", "daily-gp-2026-05-02"];
    for (const day of days) {
      await storeDay(day);
      await redis.hSet(`dailygp:leaderboard:${day}:entries`, { "reddit:progress": "{}" });
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await readRacedListFillStatus()).toEqual({ state: "waiting" });
    await runRacedListFill(NOW_MS);
    expect(await readRacedListFillStatus()).toEqual({ state: "waiting" });
    await runRacedListFill(START_MS, 1);
    const working = await readRacedListFillStatus();
    expect(working.state).toBe("working");
    expect(working.boards).toBe(CAMPAIGN_LIVE_STAGES.length + days.length);

    while ((await runRacedListFill(START_MS)).status !== "ready");
    expect(await readRacedListFillStatus()).toEqual({
      state: "done",
      completedAt: new Date(START_MS).toISOString(),
      boards: CAMPAIGN_LIVE_STAGES.length + days.length,
    });
    expect(log.mock.calls.filter(([message]) => message === "Raced list fill ready:")).toHaveLength(1);
    log.mockRestore();
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
