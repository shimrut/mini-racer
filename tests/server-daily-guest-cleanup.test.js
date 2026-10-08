import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";

const redis = new RedisTestDouble();

vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: redis,
}));

const { cleanupExpiredDailyGuests } = await import("../src/server/daily/daily-guest-cleanup.ts");
const {
  DAILY_GUEST_EXPIRY_KEY,
  DAILY_GUEST_ROW_KEEP_SECONDS,
  queueRacedBoard,
  racedListKey,
} = await import("../src/server/player/raced-list.ts");
const { guestProgressSelectionPendingKey } = await import("../src/server/player/guest-retirement.ts");

const YEAR_MS = DAILY_GUEST_ROW_KEEP_SECONDS * 1000;
const DAYS = ["daily-gp-2026-01-01", "daily-gp-2026-01-02"];

function pbField(playerId) {
  return createHash("sha256").update(playerId, "utf8").digest("base64url");
}

// Writes a guest's rows on each day the way a race save does, at `nowMs`.
async function raceDays(playerId, days, nowMs) {
  for (const day of days) {
    await redis.hSet(`dailygp:leaderboard:${day}:entries`, { [playerId]: "{}" });
    await redis.zAdd(`dailygp:leaderboard:${day}`, { member: playerId, score: 30000 });
    await redis.hSet(`dailygp:challenge-pbs:${day}`, { [pbField(playerId)]: "{}" });
    const transaction = await redis.watch();
    await queueRacedBoard(transaction, playerId, { mode: "daily", id: day }, nowMs);
    await transaction.exec();
  }
}

async function holdsRows(playerId, day) {
  return Boolean(
    await redis.hGet(`dailygp:leaderboard:${day}:entries`, playerId)
    || await redis.zScore(`dailygp:leaderboard:${day}`, playerId)
    || await redis.hGet(`dailygp:challenge-pbs:${day}`, pbField(playerId)),
  );
}

describe("Daily guest clean-up", () => {
  beforeEach(() => {
    redis.reset();
  });

  it("removes the Daily rows of a guest a year after their last Daily write", async () => {
    const guest = "guest:left-a-year-ago";
    const startMs = Date.parse("2026-01-02T00:00:00.000Z");
    await raceDays(guest, DAYS, startMs);

    expect(await cleanupExpiredDailyGuests(startMs + YEAR_MS - 1)).toBe(0);
    expect(await holdsRows(guest, DAYS[0])).toBe(true);

    expect(await cleanupExpiredDailyGuests(startMs + YEAR_MS)).toBe(1);
    for (const day of DAYS) expect(await holdsRows(guest, day)).toBe(false);
    expect(await redis.zScore(DAILY_GUEST_EXPIRY_KEY, guest)).toBeFalsy();
    expect(await redis.hKeys(racedListKey(guest))).toEqual([]);
  });

  it("keeps a guest who raced again, and an account's rows", async () => {
    const guest = "guest:came-back";
    const account = "reddit:stays";
    const startMs = Date.parse("2026-01-02T00:00:00.000Z");
    await raceDays(guest, [DAYS[0]], startMs);
    await raceDays(account, [DAYS[0]], startMs);
    await raceDays(guest, [DAYS[1]], startMs + YEAR_MS / 2);

    expect(await cleanupExpiredDailyGuests(startMs + YEAR_MS)).toBe(0);
    expect(await holdsRows(guest, DAYS[0])).toBe(true);
    expect(await holdsRows(account, DAYS[0])).toBe(true);
    expect(await redis.zScore(DAILY_GUEST_EXPIRY_KEY, account)).toBeFalsy();
  });

  it("stops when the guest races during the clean-up", async () => {
    const guest = "guest:raced-mid-cleanup";
    const startMs = Date.parse("2026-01-02T00:00:00.000Z");
    await raceDays(guest, DAYS, startMs);
    const cleanupMs = startMs + YEAR_MS;
    redis.setBeforeExec(() => {
      redis.setBeforeExec(null);
      void redis.zAdd(DAILY_GUEST_EXPIRY_KEY, { member: guest, score: cleanupMs + YEAR_MS });
      // Real Redis marks a watched key as changed on ZADD; the test double does not.
      redis.touch(DAILY_GUEST_EXPIRY_KEY);
    });

    expect(await cleanupExpiredDailyGuests(cleanupMs)).toBe(0);
    for (const day of DAYS) expect(await holdsRows(guest, day)).toBe(true);
  });

  it("leaves a guest alone while a progress transfer owns them", async () => {
    const guest = "guest:transferring";
    const startMs = Date.parse("2026-01-02T00:00:00.000Z");
    await raceDays(guest, DAYS, startMs);
    await redis.set(guestProgressSelectionPendingKey(guest), "1");

    expect(await cleanupExpiredDailyGuests(startMs + YEAR_MS)).toBe(0);
    expect(await holdsRows(guest, DAYS[0])).toBe(true);
  });

  // A transfer copies rows it read after its mark, so a later delete could return as a stale copy.
  it("stops when a transfer marks the guest after the first check", async () => {
    const guest = "guest:marked-after-check";
    const startMs = Date.parse("2026-01-02T00:00:00.000Z");
    await raceDays(guest, DAYS, startMs);
    const hKeys = redis.hKeys.bind(redis);
    const spy = vi.spyOn(redis, "hKeys").mockImplementation(async (key) => {
      if (key === racedListKey(guest)) await redis.set(guestProgressSelectionPendingKey(guest), "1");
      return hKeys(key);
    });

    try {
      expect(await cleanupExpiredDailyGuests(startMs + YEAR_MS)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    for (const day of DAYS) expect(await holdsRows(guest, day)).toBe(true);
  });

  it("stops when a transfer marks the guest just before a delete commits", async () => {
    const guest = "guest:marked-before-commit";
    const startMs = Date.parse("2026-01-02T00:00:00.000Z");
    await raceDays(guest, DAYS, startMs);
    redis.setBeforeExec(() => {
      redis.setBeforeExec(null);
      void redis.set(guestProgressSelectionPendingKey(guest), "1");
    });

    expect(await cleanupExpiredDailyGuests(startMs + YEAR_MS)).toBe(0);
    for (const day of DAYS) expect(await holdsRows(guest, day)).toBe(true);
    expect(await redis.zScore(DAILY_GUEST_EXPIRY_KEY, guest)).toBeTruthy();
  });
});
