import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RedisTestDouble } from "./redis-test-double.js";
import { asCompressedRedis } from "./helpers/redis-compressed-face.js";

const redis = new RedisTestDouble();

// The compressing client reads stored envelopes as text, as on Reddit.
vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: asCompressedRedis(redis),
}));

const compaction = await import("../src/server/competition/ghost-compaction.ts");
const write = await import("../src/server/competition/pb-ghost-write.ts");
const { unpackPbGhostTrace } = await import("../src/server/competition/pb-ghost-pack.ts");
const { decodeRedisCompressedValue, encodeRedisCompressedValue } = await import("../src/server/redis/redis-compressed-value.ts");
const { guestProgressSelectionPendingKey } = await import("../src/server/player/guest-retirement.ts");
const { upsertPlayerTrackPersonalBest, getPlayerTrackPbRecord } = await import("../src/server/competition/pb-ghost-store.ts");
const { toCampaignCompetition } = await import("../src/server/competition/competition.ts");
const { CAMPAIGN_LIVE_STAGES } = await import("../game/campaign/manifest.js");
const { TRACKS } = await import("../game/track/tracks.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-07T12:00:00.000Z");

function field(playerId) {
  return createHash("sha256").update(playerId, "utf8").digest("base64url");
}

function ghost(seed = 0) {
  let state = 12345 + seed * 7919;
  const deltas = Array.from({ length: 300 }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (state % 401) - 200;
  });
  return { schemaVersion: 2, sampleIntervalMs: 50, finishTimeMs: 5000, origin: [1000, 2000, 50 + seed], deltas };
}

function runText(seed = 0, extra = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    trackKey: "circuit",
    trackFingerprint: "f".repeat(43),
    simulationRevision: 1,
    rulesRevision: 1,
    lapCount: 1,
    bestTimeMs: 30000 + seed,
    checkpointTimesSec: [10.5, 21.25],
    lapCompletionTimesSec: null,
    ghost: ghost(seed),
    updatedAt: "2026-09-21T12:00:00.000Z",
    ...extra,
  });
}

async function storeDay(date) {
  const startsAt = Date.parse(`${date}T00:00:00.000Z`);
  const id = `daily-gp-${date}`;
  await redis.hSet("dailygp:challenges", {
    [id]: JSON.stringify({ id, availableUntil: new Date(startsAt + 7 * DAY_MS).toISOString() }),
  });
  return `dailygp:challenge-pbs:${id}`;
}

async function seed(key, playerId, text) {
  await redis.hSet(key, { [field(playerId)]: encodeRedisCompressedValue(text) });
}

async function stored(key, playerId) {
  const raw = await redis.hGet(key, field(playerId));
  return raw ? JSON.parse(decodeRedisCompressedValue(raw)) : null;
}

async function runUntilIdle() {
  for (let request = 0; request < 50; request += 1) {
    if ((await compaction.readGhostCompactionState()).running === null) return request;
    await compaction.runGhostCompaction({ now: () => NOW.getTime() });
  }
  throw new Error("compaction did not finish");
}

describe("ghost compaction", () => {
  beforeEach(() => {
    redis.reset();
    write.resetPackedGhostWriteCacheForTests();
  });

  afterEach(() => {
    redis.setBeforeExec(null);
    vi.restoreAllMocks();
  });

  it("packs every plain ghost of the expired days and changes nothing else", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const oldDay = await storeDay("2026-09-20");
    const liveDay = await storeDay("2026-10-05");
    for (let index = 0; index < 230; index += 1) await seed(oldDay, `guest:${index}`, runText(index));
    await seed(oldDay, "reddit:seeded", runText(1, { ghost: null }));
    await seed(liveDay, "guest:live", runText(2));

    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();

    const state = await compaction.readGhostCompactionState();
    expect(state.steps.expired).toMatchObject({ total: 231, checked: 231, packed: 230 });
    expect(state.steps.expired.finishedAt).toBeTruthy();
    expect(state.steps.expired.savedBytes).toBeGreaterThan(0);
    for (const index of [0, 115, 229]) {
      const value = await stored(oldDay, `guest:${index}`);
      const original = JSON.parse(runText(index));
      expect(value.ghost).toBeNull();
      expect(unpackPbGhostTrace(value.ghostPacked)).toEqual(original.ghost);
      expect({ ...value, ghostPacked: undefined, ghost: original.ghost }).toEqual({ ...original, ghostPacked: undefined });
    }
    expect((await stored(oldDay, "reddit:seeded")).ghostPacked).toBeUndefined();
    expect((await stored(liveDay, "guest:live")).ghost).not.toBeNull();
    expect(await write.shouldWritePackedGhosts()).toBe(true);
  });

  it("starts the Campaign step only after the expired step, least played stage first", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(compaction.setGhostCompactionStep("start", "campaign", NOW)).rejects.toThrow("Finish the step before this one");
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();
    const [busy, quiet] = CAMPAIGN_LIVE_STAGES.slice(0, 2).map((stage) => toCampaignCompetition(stage.seriesId, stage).pbHashKey);
    for (let index = 0; index < 5; index += 1) await seed(busy, `guest:${index}`, runText(index));
    await seed(quiet, "guest:q", runText(9));

    const state = await compaction.setGhostCompactionStep("start", "campaign", NOW);

    const order = state.steps.campaign.boards.map((board) => board.key);
    expect(order.indexOf(quiet)).toBeLessThan(order.indexOf(busy));
    expect(order.at(-1)).toBe(busy);
    await runUntilIdle();
    expect((await stored(busy, "guest:4")).ghostPacked).toBeTruthy();
    expect((await stored(quiet, "guest:q")).ghostPacked).toBeTruthy();
  });

  it("leaves a marked player and a row that changed, and keeps a pause that comes in mid-run", async () => {
    const day = await storeDay("2026-09-20");
    for (let index = 0; index < 60; index += 1) await seed(day, `guest:${index}`, runText(index));
    await redis.set(guestProgressSelectionPendingKey("guest:3"), "1");
    const replaced = runText(77);
    let pauseSent = false;
    redis.setBeforeExec((keys) => {
      if (!keys.includes(day) || pauseSent) return;
      pauseSent = true;
      // A sign-in rewrites a row, and a moderator pauses, before the first commit.
      void redis.hSet(day, { [field("guest:0")]: encodeRedisCompressedValue(replaced) });
      redis.touch(day);
      void compaction.setGhostCompactionStep("pause", "expired", NOW);
    });

    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await compaction.runGhostCompaction({ now: () => NOW.getTime() });

    const paused = await compaction.readGhostCompactionState();
    expect(paused.running).toBeNull();
    expect(paused.steps.expired.finishedAt).toBeNull();
    expect((await stored(day, "guest:1")).ghostPacked).toBeUndefined();

    redis.setBeforeExec(null);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();
    expect((await stored(day, "guest:1")).ghostPacked).toBeTruthy();
    expect(JSON.stringify(await stored(day, "guest:0"))).toBe(JSON.stringify({ ...JSON.parse(replaced), ghost: null, ghostPacked: (await stored(day, "guest:0")).ghostPacked }));
    expect((await stored(day, "guest:3")).ghostPacked).toBeUndefined();
  });

  async function savedState() {
    return JSON.parse(await redis.get(compaction.GHOST_COMPACTION_STATE_KEY));
  }

  // Records the keys of each watch that was dropped without a commit.
  function recordUnwatches() {
    const watch = redis.watch.bind(redis);
    const unwatched = [];
    vi.spyOn(redis, "watch").mockImplementation(async (...keys) => {
      const transaction = await watch(...keys);
      return { ...transaction, unwatch: async () => { unwatched.push(keys); } };
    });
    return unwatched;
  }

  it("keeps a Pause saved during a run when the run then fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    vi.spyOn(redis, "hScan").mockImplementationOnce(async () => {
      await compaction.setGhostCompactionStep("pause", "expired", NOW);
      throw new Error("Redis read failed");
    });

    await compaction.runGhostCompaction({ now: () => NOW.getTime() });

    const state = await compaction.readGhostCompactionState();
    expect(state.running).toBeNull();
    expect(state.lastError).toBe("Redis read failed");
  });

  it("pauses on the state as it is when saved, so progress saved meanwhile stays", async () => {
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    const progressed = await savedState();
    progressed.steps.expired.checked = 50;
    redis.setBeforeExec((keys) => {
      if (!keys.includes(compaction.GHOST_COMPACTION_STATE_KEY)) return;
      redis.setBeforeExec(null);
      // A run's commit lands between the Pause's read and its write.
      void redis.set(compaction.GHOST_COMPACTION_STATE_KEY, JSON.stringify(progressed));
    });

    const state = await compaction.setGhostCompactionStep("pause", "expired", NOW);

    expect(state.running).toBeNull();
    expect((await savedState()).steps.expired.checked).toBe(50);
  });

  it("refuses to start a step while another runs, and leaves the state and no watch behind", async () => {
    await redis.set(compaction.GHOST_COMPACTION_STATE_KEY, JSON.stringify({
      running: "campaign",
      writePacked: true,
      steps: { expired: { finishedAt: NOW.toISOString(), startedAt: NOW.toISOString() }, campaign: { startedAt: NOW.toISOString() } },
    }));
    const before = await redis.get(compaction.GHOST_COMPACTION_STATE_KEY);
    const unwatched = recordUnwatches();

    await expect(compaction.setGhostCompactionStep("start", "expired", NOW)).rejects.toMatchObject({
      name: "GhostCompactionRefusal",
      message: "Another step is running.",
    });

    expect(await redis.get(compaction.GHOST_COMPACTION_STATE_KEY)).toBe(before);
    expect(unwatched).toEqual([[compaction.GHOST_COMPACTION_STATE_KEY]]);
  });

  it("drops the watch when a Start fails while it reads the boards", async () => {
    vi.spyOn(redis, "hGetAll").mockRejectedValueOnce(new Error("Redis read failed"));
    const unwatched = recordUnwatches();

    await expect(compaction.setGhostCompactionStep("start", "expired", NOW)).rejects.toThrow("Redis read failed");

    expect(unwatched).toEqual([[compaction.GHOST_COMPACTION_STATE_KEY]]);
    expect(await redis.get(compaction.GHOST_COMPACTION_STATE_KEY)).toBeFalsy();
  });

  it("decides a Start on the state saved meanwhile", async () => {
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await compaction.setGhostCompactionStep("pause", "expired", NOW);
    const resumed = await savedState();
    resumed.running = "expired";
    resumed.steps.expired.checked = 20;
    redis.setBeforeExec((keys) => {
      if (!keys.includes(compaction.GHOST_COMPACTION_STATE_KEY)) return;
      redis.setBeforeExec(null);
      // Another moderator resumed the step, and a run saved progress.
      void redis.set(compaction.GHOST_COMPACTION_STATE_KEY, JSON.stringify(resumed));
    });

    const state = await compaction.setGhostCompactionStep("start", "expired", NOW);

    expect(state.running).toBe("expired");
    expect(state.steps.expired.checked).toBe(20);
    expect((await savedState()).steps.expired.checked).toBe(20);
  });

  it("keeps a board with a skipped row open, and Run again packs the row once its sign-in ends", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const marked = await storeDay("2026-09-20");
    const clean = await storeDay("2026-09-21");
    await seed(marked, "guest:a", runText(1));
    await seed(marked, "guest:b", runText(2));
    await seed(clean, "guest:c", runText(3));
    await redis.set(guestProgressSelectionPendingKey("guest:a"), "1");

    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();
    let step = (await compaction.readGhostCompactionState()).steps.expired;
    expect(step).toMatchObject({ skipped: 1, doneKeys: [clean] });
    expect(step.finishedAt).toBeTruthy();

    await redis.del(guestProgressSelectionPendingKey("guest:a"));
    const again = await compaction.setGhostCompactionStep("start", "expired", NOW);
    expect(again.steps.expired.boards.map((board) => board.key)).toEqual([marked]);
    await runUntilIdle();

    expect((await stored(marked, "guest:a")).ghostPacked).toBeTruthy();
    step = (await compaction.readGhostCompactionState()).steps.expired;
    expect(step).toMatchObject({ skipped: 0 });
    expect(step.doneKeys.sort()).toEqual([marked, clean].sort());
  });

  it("does not hold a board open for a row that was packed while the run read it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));
    redis.setBeforeExec((keys) => {
      if (!keys.includes(day)) return;
      redis.setBeforeExec(null);
      // A new best time, saved packed, lands before the commit.
      void redis.hSet(day, { [field("guest:a")]: compaction.packedRunText(encodeRedisCompressedValue(runText(5))) });
      redis.touch(day);
    });

    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();

    expect((await compaction.readGhostCompactionState()).steps.expired).toMatchObject({ skipped: 0, doneKeys: [day] });
  });

  it("counts a skipped row once when a page is cut short and read again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    for (let index = 0; index < 60; index += 1) await seed(day, `guest:${index}`, runText(index));
    await redis.set(guestProgressSelectionPendingKey("guest:1"), "1");
    let late = false;
    const now = () => NOW.getTime() + (late ? 60_000 : 0);
    // Time runs out after the first group of the page is saved.
    redis.setBeforeExec((keys) => {
      if (!keys.includes(day)) return;
      redis.setBeforeExec(null);
      late = true;
    });
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await compaction.runGhostCompaction({ now });
    expect((await compaction.readGhostCompactionState()).steps.expired.checked).toBe(0);

    late = false;
    await runUntilIdle();

    expect((await compaction.readGhostCompactionState()).steps.expired).toMatchObject({ checked: 60, skipped: 1 });
  });

  it("reads every board again on the first Start of a step finished before skipped rows were counted", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));
    await redis.set(compaction.GHOST_COMPACTION_STATE_KEY, JSON.stringify({
      running: null,
      writePacked: true,
      steps: {
        expired: {
          boards: [{ key: day, total: 1 }], index: 1, cursor: 0, total: 1, checked: 1, packed: 0, savedBytes: 0,
          doneKeys: [day], startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
        },
      },
    }));

    const state = await compaction.setGhostCompactionStep("start", "expired", NOW);
    expect(state.steps.expired.boards.map((board) => board.key)).toEqual([day]);
    await runUntilIdle();

    expect((await stored(day, "guest:a")).ghostPacked).toBeTruthy();
    expect((await compaction.readGhostCompactionState()).steps.expired).toMatchObject({ skipTracked: true, doneKeys: [day] });
  });

  it("starts a step paused before skipped rows were counted again from its first row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    for (let index = 0; index < 10; index += 1) await seed(day, `guest:${index}`, runText(index));
    // Paused part-way: an earlier run left the first rows behind.
    await redis.set(compaction.GHOST_COMPACTION_STATE_KEY, JSON.stringify({
      running: null,
      writePacked: true,
      steps: {
        expired: {
          boards: [{ key: day, total: 10 }], index: 0, cursor: 5, total: 10, checked: 5, packed: 0, savedBytes: 0,
          doneKeys: [], startedAt: NOW.toISOString(), finishedAt: null,
        },
      },
    }));

    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();

    for (const index of [0, 4, 9]) expect((await stored(day, `guest:${index}`)).ghostPacked).toBeTruthy();
    expect((await compaction.readGhostCompactionState()).steps.expired).toMatchObject({ checked: 10, packed: 10 });
  });

  // A step left running on its last page: the next Start is a new run while a request may hold the old one.
  async function storeLegacyRunningStep(day, rows) {
    await redis.set(compaction.GHOST_COMPACTION_STATE_KEY, JSON.stringify({
      running: "expired",
      writePacked: true,
      steps: {
        expired: {
          boards: [{ key: day, total: rows }], index: 0, cursor: rows - 1, total: rows, checked: rows - 1,
          packed: 0, savedBytes: 0, doneKeys: [], startedAt: NOW.toISOString(), finishedAt: null,
        },
      },
    }));
  }

  it("lets no request save into a new run of its step started while it worked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    for (let index = 0; index < 201; index += 1) await seed(day, `guest:${index}`, runText(index));
    await storeLegacyRunningStep(day, 201);
    const scan = redis.hScan.bind(redis);
    let restarted = false;
    vi.spyOn(redis, "hScan").mockImplementation(async (key, cursor, pattern, count) => {
      const page = await scan(key, cursor, pattern, count);
      if (key === day && !restarted) {
        restarted = true;
        // While the request reads its last page, a moderator pauses and starts again.
        await compaction.setGhostCompactionStep("pause", "expired", NOW);
        await compaction.setGhostCompactionStep("start", "expired", NOW);
      }
      return page;
    });

    await compaction.runGhostCompaction({ now: () => NOW.getTime() });

    let step = (await compaction.readGhostCompactionState()).steps.expired;
    expect(step).toMatchObject({ runId: 1, index: 0, cursor: 0, checked: 0, packed: 0, doneKeys: [] });
    expect((await stored(day, "guest:200")).ghostPacked).toBeUndefined();

    await runUntilIdle();
    step = (await compaction.readGhostCompactionState()).steps.expired;
    expect(step).toMatchObject({ runId: 1, checked: 201, packed: 201, doneKeys: [day] });
    for (const index of [0, 199, 200]) expect((await stored(day, `guest:${index}`)).ghostPacked).toBeTruthy();
  });

  it("does not give a new run the error of a request that worked on the old one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    for (let index = 0; index < 3; index += 1) await seed(day, `guest:${index}`, runText(index));
    await storeLegacyRunningStep(day, 3);
    vi.spyOn(redis, "hScan").mockImplementationOnce(async () => {
      await compaction.setGhostCompactionStep("pause", "expired", NOW);
      await compaction.setGhostCompactionStep("start", "expired", NOW);
      throw new Error("Redis read failed");
    });

    await compaction.runGhostCompaction({ now: () => NOW.getTime() });

    const state = await compaction.readGhostCompactionState();
    expect(state).toMatchObject({ running: "expired", lastError: null });
    expect(state.steps.expired.runId).toBe(1);
  });

  it("keeps the run number on Resume, and raises it for each new run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));

    expect((await compaction.setGhostCompactionStep("start", "expired", NOW)).steps.expired.runId).toBe(1);
    await compaction.setGhostCompactionStep("pause", "expired", NOW);
    expect((await compaction.setGhostCompactionStep("start", "expired", NOW)).steps.expired.runId).toBe(1);
    await runUntilIdle();
    expect((await compaction.setGhostCompactionStep("start", "expired", NOW)).steps.expired.runId).toBe(2);
  });

  // The first request carrying the packed-write switch fails before saving anything.
  function failFirstSwitchWrite() {
    let failed = false;
    const fail = () => {
      failed = true;
      throw new Error("Redis write failed");
    };
    const set = redis.set.bind(redis);
    vi.spyOn(redis, "set").mockImplementation(async (key, ...rest) => {
      if (key === write.WRITE_PACKED_GHOSTS_KEY && !failed) fail();
      return set(key, ...rest);
    });
    const watch = redis.watch.bind(redis);
    vi.spyOn(redis, "watch").mockImplementation(async (...keys) => {
      const transaction = await watch(...keys);
      let carriesSwitch = false;
      return {
        ...transaction,
        set: async (key, ...rest) => {
          if (key === write.WRITE_PACKED_GHOSTS_KEY) carriesSwitch = true;
          return transaction.set(key, ...rest);
        },
        exec: async () => {
          if (carriesSwitch && !failed) fail();
          return transaction.exec();
        },
      };
    });
  }

  it("saves a Start and the packed-write switch together, and a second Start repairs a failed one", async () => {
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));
    failFirstSwitchWrite();

    await expect(compaction.setGhostCompactionStep("start", "expired", NOW)).rejects.toThrow("Redis write failed");

    // Neither is saved, and this server does not think the switch is on.
    expect(await redis.get(compaction.GHOST_COMPACTION_STATE_KEY)).toBeFalsy();
    expect(await redis.get(write.WRITE_PACKED_GHOSTS_KEY)).toBeFalsy();
    expect(await write.shouldWritePackedGhosts(NOW.getTime())).toBe(false);

    const state = await compaction.setGhostCompactionStep("start", "expired", NOW);

    expect(state.running).toBe("expired");
    expect(await redis.get(write.WRITE_PACKED_GHOSTS_KEY)).toBe("1");
    expect(await write.shouldWritePackedGhosts(NOW.getTime() + 61_000)).toBe(true);
  });

  it("sets the switch again on a Start of a running step whose switch is off, and keeps its progress", async () => {
    const saved = JSON.stringify({
      running: "expired",
      writePacked: true,
      steps: {
        expired: {
          runId: 3, skipTracked: true, boards: [{ key: "dailygp:challenge-pbs:daily-gp-2026-09-20", total: 9 }],
          index: 0, cursor: 5, total: 9, checked: 5, packed: 4, savedBytes: 400, skipped: 1, boardSkipped: 1,
          doneKeys: [], startedAt: NOW.toISOString(), finishedAt: null,
        },
      },
    });
    await redis.set(compaction.GHOST_COMPACTION_STATE_KEY, saved);

    const state = await compaction.setGhostCompactionStep("start", "expired", NOW);

    expect(await redis.get(write.WRITE_PACKED_GHOSTS_KEY)).toBe("1");
    expect(await redis.get(compaction.GHOST_COMPACTION_STATE_KEY)).toBe(saved);
    expect(state.steps.expired).toMatchObject({ runId: 3, cursor: 5, checked: 5, packed: 4 });
  });

  it("does not show a paused step's late error while another step runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Expired finishes once, so Campaign may run.
    const day = await storeDay("2026-09-20");
    await seed(day, "guest:a", runText(1));
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();
    const [stage] = CAMPAIGN_LIVE_STAGES;
    await seed(toCampaignCompetition(stage.seriesId, stage).pbHashKey, "guest:c", runText(2));
    await compaction.setGhostCompactionStep("start", "campaign", NOW);
    // A day that expired since gives Expired real work on Run again.
    const later = await storeDay("2026-09-25");
    await seed(later, "guest:b", runText(3));
    vi.spyOn(redis, "hScan").mockImplementationOnce(async () => {
      // While a Campaign request reads, a moderator pauses Campaign and starts Expired.
      await compaction.setGhostCompactionStep("pause", "campaign", NOW);
      await compaction.setGhostCompactionStep("start", "expired", NOW);
      throw new Error("Redis read failed");
    });

    await compaction.runGhostCompaction({ now: () => NOW.getTime() });

    expect(await compaction.readGhostCompactionState()).toMatchObject({ running: "expired", lastError: null });
  });

  it("runs again over the days that expired since, and only those", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await storeDay("2026-09-20");
    await seed(first, "guest:a", runText(1));
    await compaction.setGhostCompactionStep("start", "expired", NOW);
    await runUntilIdle();
    const later = await storeDay("2026-09-29");
    await seed(later, "guest:b", runText(2));

    const state = await compaction.setGhostCompactionStep("start", "expired", new Date(NOW.getTime() + 2 * DAY_MS));

    expect(state.steps.expired.boards.map((board) => board.key)).toEqual([later]);
    await runUntilIdle();
    expect((await stored(later, "guest:b")).ghostPacked).toBeTruthy();
  });
});

describe("saving best times packed", () => {
  beforeEach(() => {
    redis.reset();
    write.resetPackedGhostWriteCacheForTests();
  });

  it("saves plain until the switch is on, then packed, and reads both as a plain ghost", async () => {
    const stage = CAMPAIGN_LIVE_STAGES[0];
    const competition = toCampaignCompetition(stage.seriesId, stage);
    const track = TRACKS[stage.trackKey];
    const save = (playerId, bestTimeMs) => upsertPlayerTrackPersonalBest({
      playerId, competition, track, bestTimeMs, checkpointTimesSec: null, ghost: ghost(1),
    });

    await save("guest:plain", 40000);
    await write.turnOnPackedGhostWrites();
    await save("guest:packed", 40000);

    expect((await stored(competition.pbHashKey, "guest:plain")).ghost).toEqual(ghost(1));
    const packed = await stored(competition.pbHashKey, "guest:packed");
    expect(packed.ghost).toBeNull();
    expect(unpackPbGhostTrace(packed.ghostPacked)).toEqual(ghost(1));
    for (const playerId of ["guest:plain", "guest:packed"]) {
      expect((await getPlayerTrackPbRecord({ playerId, competition, track })).ghost).toEqual(ghost(1));
    }
  });

  it("reads the switch at most once a minute on each server", async () => {
    const get = vi.spyOn(redis, "get");
    await write.shouldWritePackedGhosts(1_000);
    await write.shouldWritePackedGhosts(30_000);
    await write.shouldWritePackedGhosts(62_000);
    expect(get.mock.calls.filter(([key]) => key === write.WRITE_PACKED_GHOSTS_KEY)).toHaveLength(2);
  });
});
