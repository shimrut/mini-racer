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
const { packPbGhostTrace } = await import("../src/server/competition/pb-ghost-pack.ts");

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

  it("holds a run whose sign-in starts after the upload, before the commit", async () => {
    const text = fullRunText(30000);
    await seedRun("guest:a", text);
    redis.setBeforeExec((keys) => {
      if (!keys.includes(pbKey())) return;
      redis.setBeforeExec(null);
      void redis.set(guestProgressSelectionPendingKey("guest:a"), "1");
    });

    await runArchive(clock, blobs);

    expect(await runText("guest:a")).toBe(text);
    expect(await heldNames()).toEqual({ [field("guest:a")]: "signin" });
    expect(blobs.count("put")).toBe(1);
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

  it("reports its progress for the moderator page", async () => {
    await storeDay("2026-09-21");
    await seedRun("guest:a", fullRunText(30000));
    await seedRun("guest:b", fullRunText(31000, 1));
    await redis.set(guestProgressSelectionPendingKey("guest:b"), "1");
    clock.advance(DAY_MS);
    await archive.saveDailyGhostArchiveSetting("trial", "mod-name");
    await runArchive(clock, blobs, { mode: undefined, dayLimit: undefined });

    const status = await archive.readDailyGhostArchiveStatus(clock.now());

    expect(status).toMatchObject({
      choice: "trial",
      mode: "move",
      days: { done: 1, moving: 0, waiting: 0, restoring: 0, restored: 0 },
      // The second day is past its 8th-day start but was not started.
      waitingDays: 1,
      moved: 1,
      held: 1,
      blob: { objects: 1, measuredDays: 1 },
    });
    expect(status.freed).toBeGreaterThan(0);
    expect(status.blob.bytes).toBe(blobs.objects.get(blobs.keys()[0]).bytes.byteLength);
  });

  it("passes over old days without ghosts, so a one-day trial moves a day that has them", async () => {
    // Day 1 has no ghost hash, day 2 a ghostless best, days 3 and 4 real ghosts.
    const noRuns = DAY_ID;
    const noGhost = await storeDay("2026-09-21");
    const firstReal = await storeDay("2026-09-22");
    const secondReal = await storeDay("2026-09-23");
    await seedRun("reddit:seeded", noGhostRunText(31000), noGhost);
    await seedRun("guest:a", fullRunText(30000), firstReal);
    await seedRun("guest:a", fullRunText(30000), secondReal);
    clock.advance(3 * DAY_MS);

    await runArchive(clock, blobs, { dayLimit: 1 });
    clock.advance(60_000);
    await runArchive(clock, blobs, { dayLimit: 1 });

    expect(await dayRecord(noRuns)).toMatchObject({ state: "done", moved: 0 });
    expect(await dayRecord(noGhost)).toMatchObject({ state: "done", moved: 0 });
    expect(await dayRecord(firstReal)).toMatchObject({ state: "done", moved: 1 });
    expect((await runValue("guest:a", firstReal)).ghost).toBeNull();
    expect(await dayRecord(secondReal)).toBeNull();
    expect((await runValue("guest:a", secondReal)).ghost).not.toBeNull();
  });

  it("stops at a refused first request with every day as it was, and says why once an hour", async () => {
    const text = fullRunText(30000);
    await seedRun("guest:a", text);
    blobs.faults.list = "fail";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runArchive(clock, blobs)).toMatchObject({ status: "blob_refused", moved: 0 });
    clock.advance(60_000);
    expect(await runArchive(clock, blobs)).toMatchObject({ status: "blob_refused" });

    expect(await runText("guest:a")).toBe(text);
    expect(await dayRecord()).toBeNull();
    expect(await redis.get(archive.DAILY_GHOST_ARCHIVE_TOTALS_KEY)).toBeFalsy();
    expect(await heldNames()).toEqual({});
    expect(blobs.count("put")).toBe(0);
    const refusals = errors.mock.calls.filter(([text]) => String(text).includes("blob storage refused"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0][1]).toBe("blob list failed");
    expect((await archive.readDailyGhostArchiveStatus(clock.now())).blobError)
      .toMatchObject({ message: "blob list failed" });

    blobs.faults.list = null;
    clock.advance(60_000);
    await runArchive(clock, blobs);
    expect((await runValue("guest:a")).ghost).toBeNull();
    expect((await archive.readDailyGhostArchiveStatus(clock.now())).blobError).toBeNull();
  });

  it("logs what blob storage said when an upload fails", async () => {
    await seedRun("guest:a", fullRunText(30000));
    blobs.faults.put = "fail";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await runArchive(clock, blobs);

    expect(errors).toHaveBeenCalledWith("Daily ghost archive failed:", DAY_ID, "upload", "blob put failed");
  });

  it("moves a packed ghost like a plain one, and restores the same text", async () => {
    const plain = JSON.parse(fullRunText(30000, 4));
    const packedText = JSON.stringify({ ...plain, ghost: null, ghostPacked: packPbGhostTrace(plain.ghost) });
    await seedRun("guest:packed", packedText);

    await runArchive(clock, blobs);

    const stub = await runValue("guest:packed");
    expect(stub.ghost).toBeNull();
    expect(stub.ghostPacked).toBeUndefined();
    expect(blobText(blobs, stub.ghostArchive.key)).toBe(packedText);

    clock.advance(60_000);
    await runArchive(clock, blobs, { mode: "restore" });
    expect(await runText("guest:packed")).toBe(packedText);
  });

  it("does nothing while off", async () => {
    const text = fullRunText(30000);
    await seedRun("guest:a", text);
    expect(await runArchive(clock, blobs, { mode: "off" })).toMatchObject({ status: "off" });
    expect(await runText("guest:a")).toBe(text);
    expect(await dayRecord()).toBeNull();
  });

  it("follows the choice a moderator saved, and is off until one is saved", async () => {
    const second = await storeDay("2026-09-21");
    const text = fullRunText(30000);
    await seedRun("guest:a", text);
    await seedRun("guest:a", text, second);
    clock.advance(DAY_MS);
    const followChoice = () => runArchive(clock, blobs, { mode: undefined, dayLimit: undefined });

    expect(await archive.readDailyGhostArchiveSetting()).toMatchObject({ choice: "off" });
    expect(await followChoice()).toMatchObject({ status: "off" });
    expect(await runText("guest:a")).toBe(text);

    await archive.saveDailyGhostArchiveSetting("trial", "mod-name");
    clock.advance(60_000);
    await followChoice();
    clock.advance(60_000);
    await followChoice();
    expect((await runValue("guest:a")).ghost).toBeNull();
    expect((await runValue("guest:a", second)).ghost).not.toBeNull();

    await archive.saveDailyGhostArchiveSetting("all", "mod-name");
    clock.advance(60_000);
    await followChoice();
    expect((await runValue("guest:a", second)).ghost).toBeNull();

    await archive.saveDailyGhostArchiveSetting("restore", "mod-name");
    clock.advance(60_000);
    await followChoice();
    expect(await runText("guest:a")).toBe(text);
    expect(await runText("guest:a", second)).toBe(text);
    expect(await archive.readDailyGhostArchiveSetting()).toMatchObject({ choice: "restore", changedBy: "mod-name" });
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

describe("working the held list in turns", () => {
  let blobs;
  let clock;
  let players;

  beforeEach(async () => {
    redis.reset();
    clock = createClock(MOVE_AT);
    blobs = createBlobTestStore({ now: () => clock.now() });
    await storeDay(DAY);
    // 30 runs, all held for a sign-in on the first pass.
    players = Array.from({ length: 30 }, (_value, index) => `guest:${index}`);
    for (const [index, player] of players.entries()) {
      await seedRun(player, fullRunText(30000 + index, index));
      await redis.set(guestProgressSelectionPendingKey(player), "1");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function playerOf(name) {
    return players.find((player) => field(player) === name);
  }

  async function hourly(options = {}) {
    clock.advance(HOUR_MS);
    return runArchive(clock, blobs, options);
  }

  async function heldPosition() {
    const { heldCursor, heldAfter } = await dayRecord();
    return { heldCursor, heldAfter };
  }

  // The test double pages a hash in insertion order, 25 names to a page.
  function pages(order) {
    return [[...order.slice(0, 25)].sort(), [...order.slice(25)].sort()];
  }

  it("moves the names behind 25 stuck ones in a later hour", async () => {
    await runArchive(clock, blobs);
    const order = Object.keys(await heldNames());
    expect(order).toHaveLength(30);
    // The first 25 names in scan order keep a sign-in that never ends.
    const late = order.slice(25);
    for (const name of late) await redis.del(guestProgressSelectionPendingKey(playerOf(name)));

    for (let hour = 0; hour < 3; hour += 1) await hourly();

    for (const name of late) expect((await runValue(playerOf(name))).ghost).toBeNull();
    for (const name of order.slice(0, 25)) expect((await runValue(playerOf(name))).ghost).not.toBeNull();
    expect(Object.keys(await heldNames()).sort()).toEqual(order.slice(0, 25).sort());
  });

  it("goes on after the last name taken, starts each page and each round afresh", async () => {
    await runArchive(clock, blobs);
    const [first, second] = pages(Object.keys(await heldNames()));

    await hourly();
    expect(await heldPosition()).toEqual({ heldCursor: 0, heldAfter: first.at(-1) });
    // The next page is read from its first name.
    await hourly();
    expect(await heldPosition()).toEqual({ heldCursor: 25, heldAfter: second.at(-1) });
    // After the last page, the list starts again from the top.
    await hourly();
    expect(await heldPosition()).toEqual({ heldCursor: 0, heldAfter: first.at(-1) });
  });

  it("saves the position of a turn that only scanned", async () => {
    await runArchive(clock, blobs);
    const heldKey = archive.dailyGhostArchiveHeldKey(DAY_ID);
    const scan = redis.hScan.bind(redis);
    // Real Redis may answer a page with no names and a cursor to go on from.
    vi.spyOn(redis, "hScan").mockImplementation(async (key, cursor, pattern, count) => (
      key === heldKey && cursor < 40 ? { cursor: cursor + 10, fieldValues: [] } : scan(key, cursor, pattern, count)
    ));

    await hourly();

    expect(await heldPosition()).toEqual({ heldCursor: 40, heldAfter: null });
    expect(await redis.hLen(heldKey)).toBe(30);
  });

  it("keeps its place when held names are deleted between hours", async () => {
    await runArchive(clock, blobs);
    const [first] = pages(Object.keys(await heldNames()));
    await hourly();
    const { heldAfter } = await heldPosition();
    // Sign-ins end for some names, and their rows go: the names drop out.
    const gone = [first[3], heldAfter];
    for (const name of gone) {
      await redis.del(guestProgressSelectionPendingKey(playerOf(name)));
      await redis.hDel(pbKey(), [name]);
    }

    for (let hour = 0; hour < 3; hour += 1) await hourly();

    const held = Object.keys(await heldNames());
    expect(held).toHaveLength(28);
    for (const name of gone) expect(held).not.toContain(name);
  });
});

describe("sweeping blob copies that no stub points to", () => {
  let blobs;
  let clock;

  beforeEach(async () => {
    redis.reset();
    clock = createClock(MOVE_AT);
    blobs = createBlobTestStore({ now: () => clock.now() });
    await storeDay(DAY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function moveDay(players) {
    for (const [index, player] of players.entries()) await seedRun(player, fullRunText(30000 + index, index));
    await runArchive(clock, blobs);
    return Promise.all(players.map(async (player) => (await runValue(player)).ghostArchive.key));
  }

  function putOrphan(name, ageMs) {
    const key = `daily-ghosts/v1/${DAY_ID}/${name}.gz`;
    blobs.objects.set(key, { bytes: new Uint8Array([1, 2, 3]), lastModifiedMs: clock.now() - ageMs });
    return key;
  }

  it("deletes old orphans after a day is done, keeps live copies, and measures what is left", async () => {
    const orphan = putOrphan("old-orphan", 2 * DAY_MS);
    const keys = await moveDay(["guest:a", "reddit:b"]);

    expect(blobs.objects.has(orphan)).toBe(false);
    for (const key of keys) expect(blobs.objects.has(key)).toBe(true);
    const day = await dayRecord();
    expect(day).toMatchObject({ state: "done", sweep: null, sweepNeeded: false, nextSweepAt: null });
    expect(day.blob).toMatchObject({ objects: 2 });
    expect(day.blob.bytes).toBe(keys.reduce((sum, key) => sum + blobs.objects.get(key).bytes.byteLength, 0));
    expect(await totals()).toMatchObject({ deleted: 1 });
    expect(await redis.hGetAll(archive.dailyGhostArchiveSweepRefsKey(DAY_ID))).toEqual({});
  });

  it("keeps a young orphan, and deletes it in a later sweep without any other change", async () => {
    await moveDay(["guest:a"]);
    const young = putOrphan("young-orphan", 0);
    // A held upload to the done day asks for a sweep.
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), sweepNeeded: true }),
    });
    clock.advance(60_000);
    await runArchive(clock, blobs);
    expect(blobs.objects.has(young)).toBe(true);
    const due = (await dayRecord()).nextSweepAt;
    expect(due).toBeGreaterThan(clock.now());

    clock.advance(due - clock.now() + 1);
    await runArchive(clock, blobs);
    expect(blobs.objects.has(young)).toBe(false);
    expect(await dayRecord()).toMatchObject({ nextSweepAt: null, blob: { objects: 1 } });
  });

  it("keeps a copy that a sign-in shared with an account after the guest's stub is gone", async () => {
    const [guestKey] = await moveDay(["guest:a"]);
    // The transfer copies the guest's stub to the account and deletes the guest.
    await redis.hSet(pbKey(), { [field("reddit:a")]: await redis.hGet(pbKey(), field("guest:a")) });
    await redis.hDel(pbKey(), [field("guest:a")]);
    await redis.incrBy(revisionKey(), 2);

    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    clock.advance(DAY_MS);
    await runArchive(clock, blobs);

    expect(await dayRecord()).toMatchObject({ state: "done", pass: 2, sweepNeeded: false });
    expect(blobs.objects.has(guestKey)).toBe(true);
    expect((await runValue("reddit:a")).ghostArchive.key).toBe(guestKey);
  });

  it("deletes a guest's copy after the guest's stub was removed by a clean-up", async () => {
    const [guestKey, accountKey] = await moveDay(["guest:gone", "reddit:b"]);
    await redis.hDel(pbKey(), [field("guest:gone")]);
    await redis.incrBy(revisionKey(), 1);
    // The copy is older than the next sweep's snapshot by more than the grace.
    blobs.setLastModified(guestKey, clock.now() - 2 * HOUR_MS);

    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);

    expect(blobs.objects.has(guestKey)).toBe(false);
    expect(blobs.objects.has(accountKey)).toBe(true);
  });

  it("starts the reference scan again when a sign-in moves a stub during it, and deletes nothing", async () => {
    const [guestKey] = await moveDay(["guest:a"]);
    blobs.setLastModified(guestKey, clock.now() - 2 * DAY_MS);
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), sweepNeeded: true }),
    });
    const hScan = redis.hScan.bind(redis);
    let moved = false;
    vi.spyOn(redis, "hScan").mockImplementation(async (key, cursor, pattern, count) => {
      const page = await hScan(key, cursor, pattern, count);
      if (key === pbKey() && !moved) {
        moved = true;
        // The page still shows the guest; then the transfer copies the stub and deletes the guest.
        await redis.hSet(pbKey(), { [field("reddit:a")]: await redis.hGet(pbKey(), field("guest:a")) });
        await redis.hDel(pbKey(), [field("guest:a")]);
        await redis.incrBy(revisionKey(), 2);
      }
      return page;
    });

    clock.advance(60_000);
    await runArchive(clock, blobs);

    expect(moved).toBe(true);
    expect(blobs.objects.has(guestKey)).toBe(true);
    expect(await totals()).toMatchObject({ deleted: 0 });
  });

  it("keeps the copy when a clean-up is refused during a sign-in that copies the guest's stub later", async () => {
    const { cleanupExpiredDailyGuests } = await import("../src/server/daily/daily-guest-cleanup.ts");
    const { DAILY_GUEST_EXPIRY_KEY, racedListKey } = await import("../src/server/player/raced-list.ts");
    const [guestKey] = await moveDay(["guest:old"]);
    blobs.setLastModified(guestKey, clock.now() - 2 * DAY_MS);
    await redis.zAdd(DAILY_GUEST_EXPIRY_KEY, { member: "guest:old", score: 1 });
    await redis.hSet(racedListKey("guest:old"), { [`daily:${DAY_ID}`]: "1" });
    // The sign-in marks the guest and reads its stub.
    await redis.set(guestProgressSelectionPendingKey("guest:old"), "1");
    const readStub = await redis.hGet(pbKey(), field("guest:old"));

    expect(await cleanupExpiredDailyGuests(clock.now())).toBe(0);
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), sweepNeeded: true }),
    });
    clock.advance(60_000);
    await runArchive(clock, blobs);
    // The sign-in now writes the stub it read to the account.
    await redis.hSet(pbKey(), { [field("reddit:new")]: readStub });

    expect(await redis.hGet(pbKey(), field("guest:old"))).toBe(readStub);
    expect(blobs.objects.has(guestKey)).toBe(true);
  });

  it("continues a long listing across requests, resumes inside a page, and counts each object once", async () => {
    const keys = await moveDay(["guest:a", "reddit:b"]);
    for (const key of keys) blobs.setLastModified(key, clock.now() - 2 * DAY_MS);
    const orphans = Array.from({ length: 450 }, (_value, index) => putOrphan(`orphan-${String(index).padStart(3, "0")}`, 2 * DAY_MS));
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), sweepNeeded: true }),
    });
    // Each blob call takes 100 ms, so one request cannot finish the sweep.
    const store = blobs.store;
    const slow = Object.fromEntries(Object.entries(store).map(([name, call]) => [name, async (...args) => {
      clock.advance(100);
      return call(...args);
    }]));

    let requests = 0;
    for (; requests < 20 && (await dayRecord()).sweepNeeded; requests += 1) {
      clock.advance(60_000);
      await archive.runDailyGhostArchive({
        mode: "move", dayLimit: null, store: slow, clock, maxCallsPerSecond: 1000,
      });
    }

    expect(requests).toBeGreaterThan(1);
    for (const orphan of orphans) expect(blobs.objects.has(orphan)).toBe(false);
    expect(blobs.count("delete")).toBe(450);
    expect(await totals()).toMatchObject({ deleted: 450 });
    expect((await dayRecord()).blob).toMatchObject({ objects: 2 });
  });

  it("starts the listing again when S3 refuses the saved token, with the same refs", async () => {
    const keys = await moveDay(["guest:a", "reddit:b"]);
    const orphans = Array.from({ length: 250 }, (_value, index) => putOrphan(`orphan-${String(index).padStart(3, "0")}`, 2 * DAY_MS));
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), sweepNeeded: true }),
    });
    // The first page is read, then every saved token is refused once.
    const list = blobs.store.list;
    let refused = false;
    const store = {
      ...blobs.store,
      list: async (prefix, token, maxKeys, signal) => {
        if (token && !refused) {
          refused = true;
          throw new (await import("../src/server/blob/blob-store.ts")).BlobListTokenRejectedError();
        }
        return list(prefix, token, maxKeys, signal);
      },
    };

    clock.advance(60_000);
    await archive.runDailyGhostArchive({ mode: "move", dayLimit: null, store, clock, maxCallsPerSecond: 1000 });

    expect(refused).toBe(true);
    for (const orphan of orphans) expect(blobs.objects.has(orphan)).toBe(false);
    for (const key of keys) expect(blobs.objects.has(key)).toBe(true);
    expect((await dayRecord()).blob).toMatchObject({ objects: 2 });
    expect(await totals()).toMatchObject({ deleted: 250 });
  });

  it("stops the sweep at a damaged reference and deletes nothing", async () => {
    await moveDay(["guest:a"]);
    const orphan = putOrphan("old-orphan", 2 * DAY_MS);
    const stub = await runValue("guest:a");
    await redis.hSet(pbKey(), { [field("guest:a")]: JSON.stringify({ ...stub, ghostArchive: { v: 1, key: "" } }) });
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), sweepNeeded: true }),
    });

    clock.advance(60_000);
    await runArchive(clock, blobs);

    expect(blobs.objects.has(orphan)).toBe(true);
    const day = await dayRecord();
    expect(day).toMatchObject({ sweep: null, sweepNeeded: true, lastError: "damaged_ref" });
    expect(day.nextSweepAt).toBeGreaterThan(clock.now() + HOUR_MS);
  });

  async function askForSweep() {
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({ ...(await dayRecord()), sweepNeeded: true }),
    });
  }

  const { updatedAt: _date, ...noDate } = JSON.parse(noGhostRunText(31000));
  for (const [label, raw] of [
    ["an empty value", ""],
    ["a value that cannot be read", "__gz:b64__:not-a-gzip-envelope"],
    ["a run without a ghost and without a date", JSON.stringify(noDate)],
  ]) {
    it(`stops the sweep at ${label} and deletes nothing`, async () => {
      const [key] = await moveDay(["guest:a"]);
      blobs.setLastModified(key, clock.now() - 2 * DAY_MS);
      const orphan = putOrphan("old-orphan", 2 * DAY_MS);
      await redis.hSet(pbKey(), { [field("reddit:damaged")]: raw });
      await askForSweep();

      clock.advance(60_000);
      await runArchive(clock, blobs);

      expect(blobs.objects.has(orphan)).toBe(true);
      expect(blobs.objects.has(key)).toBe(true);
      expect(await dayRecord()).toMatchObject({ sweep: null, sweepNeeded: true, lastError: "damaged_row" });
      expect(await totals()).toMatchObject({ deleted: 0 });
    });
  }

  it("keeps the copy of a stub that lost its reference after a sign-in copied it, and deletes other orphans", async () => {
    const [guestKey] = await moveDay(["guest:a"]);
    // The account's copy of the guest's stub loses its reference by outside damage.
    const { ghostArchive: _lost, ...stripped } = await runValue("guest:a");
    await redis.hSet(pbKey(), { [field("reddit:a")]: encodeRedisCompressedValue(JSON.stringify(stripped)) });
    await redis.hDel(pbKey(), [field("guest:a")]);
    blobs.setLastModified(guestKey, clock.now() - 2 * DAY_MS);
    const orphan = putOrphan("old-orphan", 2 * DAY_MS);
    await askForSweep();

    clock.advance(60_000);
    await runArchive(clock, blobs);

    expect(blobs.objects.has(guestKey)).toBe(true);
    expect(blobs.objects.has(orphan)).toBe(false);
    expect(await dayRecord()).toMatchObject({ sweep: null, sweepNeeded: false, blob: { objects: 1 } });
  });

  it("builds new refs for a sweep saved before the current rules, before it deletes anything", async () => {
    const [key] = await moveDay(["guest:a"]);
    blobs.setLastModified(key, clock.now() - 2 * DAY_MS);
    // A sweep from the earlier code, in its list phase, whose refs miss the live copy.
    await redis.hSet(archive.dailyGhostArchiveSweepRefsKey(DAY_ID), { "daily-ghosts/v1/other": "1" });
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
      [DAY_ID]: JSON.stringify({
        ...(await dayRecord()),
        sweep: {
          phase: "list", modeSerial: (await totals()).modeSerial, startedAt: clock.now(), revision: 0,
          refsCursor: 0, pageToken: null, nextToken: null, lastKey: null, kept: 0, keptBytes: 0,
          youngOrphanUntil: 0, deleted: 0,
        },
      }),
    });

    clock.advance(60_000);
    await runArchive(clock, blobs);

    expect(blobs.objects.has(key)).toBe(true);
    expect(await dayRecord()).toMatchObject({ sweep: null, sweepNeeded: false, blob: { objects: 1 } });
    expect(await totals()).toMatchObject({ deleted: 0 });
  });

  it("deletes nothing when it cannot read an orphan first, and goes on from that object later", async () => {
    await moveDay(["guest:a"]);
    const first = putOrphan("a-orphan", 2 * DAY_MS);
    const second = putOrphan("b-orphan", 2 * DAY_MS);
    blobs.faults.get = (key) => (key === first ? "fail" : null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await askForSweep();

    clock.advance(60_000);
    await runArchive(clock, blobs);
    expect(blobs.objects.has(first)).toBe(true);
    expect(blobs.objects.has(second)).toBe(true);
    // The listing stopped before the orphan it could not read.
    const { sweep } = await dayRecord();
    expect(sweep.phase).toBe("list");
    expect(sweep.lastKey === null || sweep.lastKey < first).toBe(true);

    blobs.faults.get = null;
    clock.advance(60_000);
    await runArchive(clock, blobs);
    expect(blobs.objects.has(first)).toBe(false);
    expect(blobs.objects.has(second)).toBe(false);
  });

  it("runs no held work on a day while its sweep runs, and asks for a sweep before a held upload", async () => {
    await moveDay(["guest:a"]);
    const text = fullRunText(29000, 5);
    await seedRun("guest:late", text);
    await redis.hSet(archive.dailyGhostArchiveHeldKey(DAY_ID), { [field("guest:late")]: "signin" });
    // A sweep is open on the day.
    const sweeping = {
      ...(await dayRecord()),
      hasHeld: true,
      sweep: {
        phase: "list", modeSerial: 1, startedAt: clock.now(), revision: 0, refsCursor: 0,
        pageToken: null, nextToken: null, lastKey: null, kept: 0, keptBytes: 0, youngOrphanUntil: 0, deleted: 0,
      },
    };
    await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, { [DAY_ID]: JSON.stringify(sweeping) });
    vi.spyOn(redis, "hScan");

    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    expect(await runText("guest:late")).toBe(text);

    // The next held upload fails to commit, so the sweep keeps the young copy and returns for it.
    redis.setBeforeExec((keys) => {
      if (keys.includes(pbKey())) redis.touch(pbKey());
    });
    clock.advance(HOUR_MS);
    await runArchive(clock, blobs);
    redis.setBeforeExec(null);
    expect(await runText("guest:late")).toBe(text);
    const lateCopy = blobs.keys(`daily-ghosts/v1/${DAY_ID}/${field("guest:late")}-`);
    expect(lateCopy).toHaveLength(1);
    const day = await dayRecord();
    expect(day.nextSweepAt).toBeGreaterThan(clock.now());

    // The commit works later; the copy is then referenced and stays.
    clock.advance(day.nextSweepAt - clock.now() + 1);
    await runArchive(clock, blobs);
    expect((await runValue("guest:late")).ghostArchive.key).toBe(lateCopy[0]);
    expect(blobs.objects.has(lateCopy[0])).toBe(true);
  });
});

describe("restoring moved ghosts and switching modes", () => {
  let blobs;
  let clock;

  beforeEach(async () => {
    redis.reset();
    clock = createClock(MOVE_AT);
    blobs = createBlobTestStore({ now: () => clock.now() });
    await storeDay(DAY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedPlayers(players) {
    const texts = {};
    for (const [index, player] of players.entries()) {
      texts[player] = fullRunText(30000 + index, index);
      await seedRun(player, texts[player]);
    }
    return texts;
  }

  function restoreRun(options = {}) {
    clock.advance(60_000);
    return runArchive(clock, blobs, { mode: "restore", ...options });
  }

  function moveRun(options = {}) {
    clock.advance(60_000);
    return runArchive(clock, blobs, { mode: "move", ...options });
  }

  it("writes every moved ghost of a done day back exactly, and keeps the blob copies", async () => {
    const texts = await seedPlayers(["guest:a", "reddit:b"]);
    await runArchive(clock, blobs);
    const keys = blobs.keys();

    const report = await restoreRun();

    expect(report).toMatchObject({ restored: 2 });
    for (const [player, text] of Object.entries(texts)) expect(await runText(player)).toBe(text);
    expect(blobs.keys()).toEqual(keys);
    expect(await dayRecord()).toMatchObject({ state: "restored", active: false, restored: 2 });
    expect(await totals()).toMatchObject({ moved: 2, restored: 2 });
  });

  it("restores a day that was only partly moved", async () => {
    const players = Array.from({ length: 40 }, (_value, index) => `guest:${index}`);
    const texts = await seedPlayers(players);
    // Slow blob calls: the first request moves only part of the day.
    const slow = Object.fromEntries(Object.entries(blobs.store).map(([name, call]) => [name, async (...args) => {
      clock.advance(1_000);
      return call(...args);
    }]));
    await archive.runDailyGhostArchive({ mode: "move", dayLimit: null, store: slow, clock, maxCallsPerSecond: 1000 });
    const partly = await dayRecord();
    expect(partly).toMatchObject({ state: "moving", active: true });
    expect(partly.moved).toBeGreaterThan(0);
    expect(partly.moved).toBeLessThan(40);

    for (let request = 0; request < 5 && (await dayRecord()).state !== "restored"; request += 1) await restoreRun();

    for (const player of players) expect(await runText(player)).toBe(texts[player]);
    expect(await dayRecord()).toMatchObject({ state: "restored" });
  });

  it("gives an account the full ghost of a stub that a sign-in copied to it", async () => {
    const texts = await seedPlayers(["guest:a"]);
    await runArchive(clock, blobs);
    await redis.hSet(pbKey(), { [field("reddit:a")]: await redis.hGet(pbKey(), field("guest:a")) });
    await redis.hDel(pbKey(), [field("guest:a")]);
    await redis.incrBy(revisionKey(), 2);

    for (let request = 0; request < 3 && (await dayRecord()).state !== "restored"; request += 1) {
      await restoreRun();
      clock.advance(HOUR_MS);
    }

    expect(await runText("reddit:a")).toBe(texts["guest:a"]);
    expect(await dayRecord()).toMatchObject({ state: "restored" });
  });

  it("keeps a stub whose copy is missing or does not match, and the day keeps restoring", async () => {
    const texts = await seedPlayers(["guest:a", "guest:b"]);
    await runArchive(clock, blobs);
    const stubA = await runText("guest:a");
    blobs.objects.delete((await runValue("guest:a")).ghostArchive.key);
    blobs.faults.get = (key) => (key.includes(field("guest:b")) ? "corrupt" : null);

    await restoreRun();

    expect(await runText("guest:a")).toBe(stubA);
    expect((await runValue("guest:b")).ghost).toBeNull();
    expect(await heldNames()).toEqual({
      [field("guest:a")]: "failed:missing",
      [field("guest:b")]: "failed:restore_mismatch",
    });
    expect(await dayRecord()).toMatchObject({ state: "restoring", active: false });

    blobs.faults.get = null;
    clock.advance(HOUR_MS);
    await restoreRun();
    expect(await runText("guest:b")).toBe(texts["guest:b"]);
    expect(await runText("guest:a")).toBe(stubA);
  });

  it("restores a held stub only after its sign-in ends", async () => {
    const texts = await seedPlayers(["guest:a"]);
    await runArchive(clock, blobs);
    await redis.set(guestProgressSelectionPendingKey("guest:a"), "1");

    await restoreRun();
    expect((await runValue("guest:a")).ghost).toBeNull();
    expect(await heldNames()).toEqual({ [field("guest:a")]: "signin" });
    expect(await dayRecord()).toMatchObject({ state: "restoring" });

    await redis.del(guestProgressSelectionPendingKey("guest:a"));
    for (let request = 0; request < 3 && (await dayRecord()).state !== "restored"; request += 1) {
      clock.advance(HOUR_MS);
      await restoreRun();
    }
    expect(await runText("guest:a")).toBe(texts["guest:a"]);
    expect(await dayRecord()).toMatchObject({ state: "restored" });
  });

  for (const phase of ["refs", "list"]) {
    it(`cancels a ${phase} sweep on a switch to restore, and a later move starts a new sweep`, async () => {
      await seedPlayers(["guest:a", "reddit:b"]);
      await runArchive(clock, blobs);
      const measured = (await dayRecord()).blob;
      expect(measured).toMatchObject({ objects: 2 });
      // A sweep is open in this phase, with saved refs and a listing position.
      await redis.hSet(archive.dailyGhostArchiveSweepRefsKey(DAY_ID), { "daily-ghosts/v1/old": "1" });
      await redis.hSet(archive.DAILY_GHOST_ARCHIVE_DAYS_KEY, {
        [DAY_ID]: JSON.stringify({
          ...(await dayRecord()),
          hasHeld: true,
          sweep: {
            phase, modeSerial: 1, startedAt: clock.now(), revision: 0, refsCursor: 0,
            pageToken: "old-token", nextToken: null, lastKey: "daily-ghosts/v1/z", kept: 7, keptBytes: 70,
            youngOrphanUntil: 0, deleted: 0,
          },
        }),
      });
      await redis.set(guestProgressSelectionPendingKey("guest:a"), "1");
      await redis.hSet(archive.dailyGhostArchiveHeldKey(DAY_ID), { [field("guest:a")]: "signin" });

      await restoreRun();
      let day = await dayRecord();
      expect(day.sweep).toBeNull();
      expect(day.blob).toEqual(measured);
      expect(await redis.hGetAll(archive.dailyGhostArchiveSweepRefsKey(DAY_ID))).toEqual({});
      expect((await runValue("guest:a")).ghost).toBeNull();

      await redis.del(guestProgressSelectionPendingKey("guest:a"));
      for (let request = 0; request < 3 && (await dayRecord()).state !== "restored"; request += 1) {
        clock.advance(HOUR_MS);
        await restoreRun();
      }
      expect((await runValue("guest:a")).ghost).not.toBeNull();
      expect(await dayRecord()).toMatchObject({ state: "restored" });

      const lists = [];
      const list = blobs.store.list;
      blobs.store.list = async (prefix, token, maxKeys, signal) => {
        lists.push(token);
        return list(prefix, token, maxKeys, signal);
      };
      await moveRun();
      day = await dayRecord();
      expect(day).toMatchObject({ state: "done", sweep: null, sweepNeeded: false });
      expect(lists[0]).toBeNull();
      expect(day.blob.measuredAt).toBeGreaterThan(measured.measuredAt);
    });
  }

  it("drops a held full ghost on a switch to restore, so a marker that never clears cannot block it", async () => {
    const texts = await seedPlayers(["guest:a", "guest:b"]);
    await redis.set(guestProgressSelectionPendingKey("guest:a"), "1");
    await runArchive(clock, blobs);
    expect(await heldNames()).toEqual({ [field("guest:a")]: "signin" });
    // A held name whose row is gone, and a stub held in move.
    await redis.hSet(archive.dailyGhostArchiveHeldKey(DAY_ID), {
      [field("guest:gone")]: "failed:upload",
      [field("guest:b")]: "failed:upload",
    });

    for (let request = 0; request < 4 && (await dayRecord()).state !== "restored"; request += 1) {
      clock.advance(HOUR_MS);
      await restoreRun();
    }

    expect(await runText("guest:a")).toBe(texts["guest:a"]);
    expect(await runText("guest:b")).toBe(texts["guest:b"]);
    expect(await heldNames()).toEqual({});
    expect(await dayRecord()).toMatchObject({ state: "restored" });
  });

  it("follows the mode table for new and restored days, and moves again after a restore", async () => {
    const texts = await seedPlayers(["guest:a"]);
    await restoreRun();
    expect(await dayRecord()).toBeNull();
    expect(await runText("guest:a")).toBe(texts["guest:a"]);

    await moveRun();
    const firstKey = (await runValue("guest:a")).ghostArchive.key;
    await restoreRun();
    expect(await dayRecord()).toMatchObject({ state: "restored" });
    const passes = (await dayRecord()).pass;
    await restoreRun();
    expect((await dayRecord()).pass).toBe(passes);

    await moveRun();
    expect((await runValue("guest:a")).ghostArchive.key).toBe(firstKey);
    expect(await dayRecord()).toMatchObject({ state: "done", pass: passes + 1 });
    expect(blobs.keys()).toEqual([firstKey]);
  });
});
