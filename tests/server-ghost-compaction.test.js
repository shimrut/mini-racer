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
