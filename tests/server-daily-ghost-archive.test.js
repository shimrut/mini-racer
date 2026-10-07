import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { RedisTestDouble } from "./redis-test-double.js";
import { createBlobTestStore } from "./helpers/blob-test-store.js";

const redis = new RedisTestDouble();

vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: redis,
}));

const archive = await import("../src/server/daily/daily-ghost-archive.ts");
const {
  decodeRedisCompressedValue,
  encodeRedisCompressedValue,
} = await import("../src/server/redis/redis-compressed-value.ts");
const {
  guestProgressSelectionAccountPendingKey,
  guestProgressSelectionPendingKey,
} = await import("../src/server/player/guest-retirement.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY = "2026-09-20";
const DAY_ID = `daily-gp-${DAY}`;
// The day is playable for 7 days; its ghosts may move 6 hours into day 8.
const DAY_8 = Date.parse(`${DAY}T00:00:00.000Z`) + 7 * DAY_MS;
const MOVE_AT = DAY_8 + 6 * HOUR_MS;

function pbKey(challengeId = DAY_ID) {
  return `dailygp:challenge-pbs:${challengeId}`;
}

function revisionKey(challengeId = DAY_ID) {
  return `dailygp:leaderboard:${challengeId}:standings-revision`;
}

function field(playerId) {
  return createHash("sha256").update(playerId, "utf8").digest("base64url");
}

async function storeDay(date) {
  const startsAt = Date.parse(`${date}T00:00:00.000Z`);
  const id = `daily-gp-${date}`;
  await redis.hSet("dailygp:challenges", {
    [id]: JSON.stringify({
      id,
      challengeDate: date,
      trackKey: "circuit",
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(startsAt + DAY_MS).toISOString(),
      availableUntil: new Date(startsAt + 7 * DAY_MS).toISOString(),
    }),
  });
  return id;
}

// A stored run with a valid ghost of 101 samples.
function fullRunText(bestTimeMs, seed = 0) {
  // Varied steps, so the ghost compresses about as much as a real one.
  let state = 12345 + seed * 7919;
  const deltas = Array.from({ length: 300 }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (state % 401) - 200;
  });
  return JSON.stringify({
    schemaVersion: 2,
    trackKey: "circuit",
    trackFingerprint: "f".repeat(43),
    simulationRevision: 1,
    rulesRevision: 1,
    lapCount: 1,
    bestTimeMs,
    checkpointTimesSec: [10.5, 21.25],
    lapCompletionTimesSec: null,
    ghost: {
      schemaVersion: 2,
      sampleIntervalMs: 50,
      finishTimeMs: 5000,
      origin: [1000, 2000, 50 + seed],
      deltas,
    },
    updatedAt: "2026-09-21T12:00:00.000Z",
  });
}

function noGhostRunText(bestTimeMs) {
  return JSON.stringify({ ...JSON.parse(fullRunText(bestTimeMs)), ghost: null });
}

async function seedRun(playerId, text, challengeId = DAY_ID) {
  await redis.hSet(pbKey(challengeId), { [field(playerId)]: encodeRedisCompressedValue(text) });
}

async function runText(playerId, challengeId = DAY_ID) {
  const raw = await redis.hGet(pbKey(challengeId), field(playerId));
  return raw ? decodeRedisCompressedValue(raw) : null;
}

async function runValue(playerId, challengeId = DAY_ID) {
  const text = await runText(playerId, challengeId);
  return text ? JSON.parse(text) : null;
}

async function dayRecord(challengeId = DAY_ID) {
  const raw = await redis.hGet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, challengeId);
  return raw ? JSON.parse(raw) : null;
}

async function totals() {
  return JSON.parse((await redis.get(archive.DAILY_GHOST_ARCHIVE_TOTALS_KEY)) ?? "{}");
}

async function heldNames(challengeId = DAY_ID) {
  return Object.fromEntries((await redis.hScan(archive.dailyGhostArchiveHeldKey(challengeId), 0, undefined, 1000))
    .fieldValues.map(({ field: name, value }) => [name, value]));
}

function createClock(startMs) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    advance(ms) {
      nowMs += ms;
    },
  };
}

function runArchive(clock, blobs, options = {}) {
  return archive.runDailyGhostArchive({
    mode: "move",
    dayLimit: null,
    store: blobs.store,
    clock,
    maxCallsPerSecond: 1000,
    ...options,
  });
}

function blobText(blobs, key) {
  return gunzipSync(blobs.objects.get(key).bytes).toString("utf8");
}

describe("moving old Daily ghosts to blob storage", () => {
  let blobs;
  let clock;

  beforeEach(async () => {
    redis.reset();
    clock = createClock(MOVE_AT);
    blobs = createBlobTestStore({ now: () => clock.now() });
    await storeDay(DAY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves every full ghost of an old day and keeps every other field in Redis", async () => {
    const players = ["guest:a", "guest:b", "reddit:c", "reddit:d"];
    const texts = players.map((player, index) => fullRunText(30000 + index, index));
    for (const [index, player] of players.entries()) await seedRun(player, texts[index]);
    await seedRun("reddit:seeded", noGhostRunText(31000));
    await redis.hSet(pbKey(), { [field("guest:damaged")]: "{ not json" });

    const report = await runArchive(clock, blobs);

    expect(report).toMatchObject({ status: "worked", moved: 4, failed: 0, held: 0, passesEnded: 1 });
    for (const [index, player] of players.entries()) {
      const stub = await runValue(player);
      const original = JSON.parse(texts[index]);
      expect(stub.ghost).toBeNull();
      expect({ ...stub, ghost: original.ghost, ghostArchive: undefined }).toEqual({ ...original, ghostArchive: undefined });
      expect(stub.ghostArchive).toMatchObject({ v: 1 });
      expect(stub.ghostArchive.key.startsWith(`daily-ghosts/v1/${DAY_ID}/${field(player)}-`)).toBe(true);
      expect(blobText(blobs, stub.ghostArchive.key)).toBe(texts[index]);
      expect(createHash("sha256").update(texts[index]).digest("hex")).toBe(stub.ghostArchive.sha256);
    }
    expect(await runText("reddit:seeded")).toBe(noGhostRunText(31000));
    expect(await redis.hGet(pbKey(), field("guest:damaged"))).toBe("{ not json");
    expect(await dayRecord()).toMatchObject({ state: "done", active: false, moved: 4, pass: 1 });
    expect(await totals()).toMatchObject({ moved: 4 });
    expect((await totals()).freed).toBeGreaterThan(0);
  });

  it("does not touch a playable day, nor day 8 before 06:00 UTC", async () => {
    await seedRun("guest:a", fullRunText(30000));
    const playable = await storeDay("2026-09-25");
    await seedRun("guest:a", fullRunText(30000), playable);

    clock = createClock(MOVE_AT - 1);
    await runArchive(clock, blobs);
    expect((await runValue("guest:a")).ghost).not.toBeNull();
    expect(blobs.keys()).toEqual([]);

    clock.advance(1);
    await runArchive(clock, blobs);
    expect((await runValue("guest:a")).ghost).toBeNull();
    expect((await runValue("guest:a", playable)).ghost).not.toBeNull();
    expect(await dayRecord(playable)).toBeNull();
  });

  for (const [fault, code] of [
    [{ put: "fail" }, "failed:upload"],
    [{ get: "corrupt" }, "failed:confirm_mismatch"],
    [{ get: "fail" }, "failed:confirm_read"],
  ]) {
    it(`keeps the Redis copy when the blob copy cannot be confirmed (${code})`, async () => {
      const text = fullRunText(30000);
      await seedRun("guest:a", text);
      Object.assign(blobs.faults, fault);

      const report = await runArchive(clock, blobs);

      expect(report.failed).toBe(1);
      expect(await runText("guest:a")).toBe(text);
      expect(await heldNames()).toEqual({ [field("guest:a")]: code });
      // A failed run waits in the held list; it does not hold the day open.
      expect(await dayRecord()).toMatchObject({ state: "done", hasHeld: true, failedThisPass: 1 });

      blobs.faults.put = null;
      blobs.faults.get = null;
      clock.advance(HOUR_MS);
      await runArchive(clock, blobs);
      expect((await runValue("guest:a")).ghost).toBeNull();
      expect(await heldNames()).toEqual({});
    });
  }

  it("leaves Redis, counts and progress unchanged when the commit keeps failing, and reuses the object name later", async () => {
    const text = fullRunText(30000);
    await seedRun("guest:a", text);
    // Every commit of a slice meets a changed ghost hash.
    redis.setBeforeExec((keys) => {
      if (keys.includes(pbKey())) redis.touch(pbKey());
    });

    await runArchive(clock, blobs);

    expect(await runText("guest:a")).toBe(text);
    expect(blobs.keys()).toHaveLength(1);
    const stuck = await dayRecord();
    expect(stuck).toMatchObject({ state: "moving", active: true, moved: 0 });
    expect((await totals()).moved ?? 0).toBe(0);
    expect(Object.keys((await redis.hScan(archive.dailyGhostArchivePageKey(DAY_ID), 0, undefined, 100)).fieldValues))
      .toHaveLength(1);

    redis.setBeforeExec(null);
    clock.advance(60_000);
    await runArchive(clock, blobs);

    expect((await runValue("guest:a")).ghost).toBeNull();
    expect(blobs.keys()).toHaveLength(1);
    expect(blobs.count("put")).toBe(2);
  });

  it("leaves a run that changed before the commit full, and passes the day again", async () => {
    const text = fullRunText(30000);
    const replaced = fullRunText(29000, 3);
    await seedRun("guest:a", text);
    // A sign-in writes the run between the copy and the commit.
    redis.setBeforeExec((keys) => {
      if (!keys.includes(pbKey())) return;
      redis.setBeforeExec(null);
      void redis.hSet(pbKey(), { [field("guest:a")]: encodeRedisCompressedValue(replaced) });
      void redis.incrBy(revisionKey(), 1);
      redis.touch(pbKey());
    });

    await runArchive(clock, blobs);

    expect(await runText("guest:a")).toBe(replaced);
    expect(await dayRecord()).toMatchObject({ state: "waiting", active: false });

    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    const stub = await runValue("guest:a");
    expect(stub.ghost).toBeNull();
    expect(blobText(blobs, stub.ghostArchive.key)).toBe(replaced);
    expect(await dayRecord()).toMatchObject({ state: "done", pass: 2 });
  });

  it("holds a run while a sign-in owns its player, and moves it after the sign-in ends", async () => {
    const text = fullRunText(30000);
    await seedRun("guest:a", text);
    await seedRun("reddit:b", fullRunText(31000, 1));
    await redis.set(guestProgressSelectionPendingKey("guest:a"), "1");

    const report = await runArchive(clock, blobs);

    expect(report).toMatchObject({ moved: 1, held: 1 });
    expect(await runText("guest:a")).toBe(text);
    expect(await heldNames()).toEqual({ [field("guest:a")]: "signin" });
    expect(await dayRecord()).toMatchObject({ state: "done", hasHeld: true });

    // The mark stays: the hourly upkeep keeps the name and starts no pass.
    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    expect(await runText("guest:a")).toBe(text);
    expect(await dayRecord()).toMatchObject({ state: "done", pass: 1 });

    await redis.del(guestProgressSelectionPendingKey("guest:a"));
    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    expect((await runValue("guest:a")).ghost).toBeNull();
    expect(await heldNames()).toEqual({});
  });

  it("holds a run whose account has a sign-in in progress", async () => {
    const text = fullRunText(30000);
    await seedRun("reddit:b", text);
    await redis.set(guestProgressSelectionAccountPendingKey("reddit:b"), "guest:x");

    await runArchive(clock, blobs);

    expect(await runText("reddit:b")).toBe(text);
    expect(await heldNames()).toEqual({ [field("reddit:b")]: "signin" });
  });

  it("passes the day again when a sign-in copies a later guest ghost into an account already passed", async () => {
    // 210 runs: the account is in the first scan page, the guest in the second.
    await seedRun("reddit:a", noGhostRunText(33000));
    for (let index = 0; index < 204; index += 1) await seedRun(`guest:filler-${index}`, fullRunText(40000 + index, index));
    const guestText = fullRunText(29000, 9);
    await seedRun("guest:g", guestText);
    for (let index = 0; index < 5; index += 1) await seedRun(`guest:tail-${index}`, fullRunText(41000 + index, index));
    const hScan = redis.hScan.bind(redis);
    let copied = false;
    vi.spyOn(redis, "hScan").mockImplementation(async (key, cursor, pattern, count) => {
      if (key === pbKey() && cursor !== 0 && !copied) {
        copied = true;
        // The transfer copies the guest's run to the account, then deletes the guest.
        const raw = await redis.hGet(pbKey(), field("guest:g"));
        await redis.hSet(pbKey(), { [field("reddit:a")]: raw });
        await redis.hDel(pbKey(), [field("guest:g")]);
        await redis.incrBy(revisionKey(), 2);
      }
      return hScan(key, cursor, pattern, count);
    });

    for (let request = 0; request < 5 && (await dayRecord())?.state !== "waiting"; request += 1) {
      await runArchive(clock, blobs);
      clock.advance(60_000);
    }

    expect(copied).toBe(true);
    expect(await runText("reddit:a")).toBe(guestText);
    expect(await dayRecord()).toMatchObject({ state: "waiting" });

    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    const stub = await runValue("reddit:a");
    expect(stub.ghost).toBeNull();
    expect(blobText(blobs, stub.ghostArchive.key)).toBe(guestText);
    expect(await dayRecord()).toMatchObject({ state: "done", pass: 2 });
  });

  it("starts no more days than the limit across requests, and a waiting day does not block the next", async () => {
    const second = await storeDay("2026-09-21");
    await seedRun("guest:a", fullRunText(30000));
    await seedRun("guest:a", fullRunText(30000), second);
    clock.advance(DAY_MS);

    await runArchive(clock, blobs, { dayLimit: 1 });
    await runArchive(clock, blobs, { dayLimit: 1 });
    expect(await dayRecord()).toMatchObject({ state: "done" });
    expect(await dayRecord(second)).toBeNull();

    // The first day waits for another pass; the second day still moves.
    await redis.incrBy(revisionKey(), 1);
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), state: "waiting", nextPassAt: clock.now() + HOUR_MS }),
    });
    await runArchive(clock, blobs, { dayLimit: 2 });
    expect((await runValue("guest:a", second)).ghost).toBeNull();
    expect(await dayRecord()).toMatchObject({ state: "waiting" });
  });

  it("reopens a done day when its revision changes, and every done day when the epoch rises", async () => {
    await seedRun("guest:a", fullRunText(30000));
    await runArchive(clock, blobs);
    expect(await dayRecord()).toMatchObject({ state: "done", pass: 1 });

    await redis.incrBy(revisionKey(), 1);
    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    expect(await dayRecord()).toMatchObject({ state: "done", pass: 2 });

    clock.advance(60_000);
    await runArchive(clock, blobs, { epoch: 2 });
    expect(await dayRecord()).toMatchObject({ state: "done", pass: 3 });
  });

  it("leaves a ghost in Redis when its stub would take as much room", async () => {
    const tiny = JSON.stringify({
      ...JSON.parse(fullRunText(30000)),
      ghost: { schemaVersion: 2, sampleIntervalMs: 50, finishTimeMs: 50, origin: [1, 2, 3], deltas: [4, 5, 6] },
    });
    await seedRun("guest:tiny", tiny);
    await seedRun("guest:a", fullRunText(30000));

    await runArchive(clock, blobs);

    expect(await runText("guest:tiny")).toBe(tiny);
    expect((await runValue("guest:a")).ghost).toBeNull();
    expect(await dayRecord()).toMatchObject({ state: "done", moved: 1 });
  });

  it("does nothing while off", async () => {
    const text = fullRunText(30000);
    await seedRun("guest:a", text);
    expect(await runArchive(clock, blobs, { mode: "off" })).toMatchObject({ status: "off" });
    expect(await runText("guest:a")).toBe(text);
    expect(await dayRecord()).toBeNull();
  });

  it("never runs past 27 s when every blob call stalls, and keeps unstarted names", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MOVE_AT);
    for (let index = 0; index < 30; index += 1) await seedRun(`guest:${index}`, fullRunText(30000 + index, index));
    blobs = createBlobTestStore();
    blobs.faults.put = "stall";
    const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

    let finished = false;
    const done = archive.runDailyGhostArchive({
      mode: "move", dayLimit: null, store: blobs.store, clock: realClock,
    }).then((report) => {
      finished = true;
      return report;
    });
    for (let step = 0; step < 400 && !finished; step += 1) await vi.advanceTimersByTimeAsync(100);
    await done;

    expect(Date.now() - MOVE_AT).toBeLessThanOrEqual(27_000);
    expect(blobs.count("put")).toBeGreaterThan(0);
    expect((await runValue("guest:0")).ghost).not.toBeNull();
    const page = (await redis.hScan(archive.dailyGhostArchivePageKey(DAY_ID), 0, undefined, 100)).fieldValues;
    const held = await heldNames();
    // Timed-out uploads wait in the held list; names never started stay in the page.
    expect(page.length + Object.keys(held).length).toBe(30);
    expect(page.length).toBeGreaterThan(0);
  });
});
