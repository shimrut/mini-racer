import { beforeEach, describe, expect, it, vi } from "vitest";

class RedisTestDouble {
  constructor() {
    this.reset();
  }

  reset() {
    this.strings = new Map();
    this.hashes = new Map();
    this.sortedSets = new Map();
    this.expiresAtSeconds = new Map();
  }

  _nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  _isExpired(key) {
    const expiresAt = this.expiresAtSeconds.get(key);
    if (!Number.isFinite(expiresAt)) {
      return false;
    }
    if (expiresAt > this._nowSeconds()) {
      return false;
    }
    this.expiresAtSeconds.delete(key);
    this.strings.delete(key);
    this.hashes.delete(key);
    this.sortedSets.delete(key);
    return true;
  }

  async get(key) {
    this._isExpired(key);
    return this.strings.get(key);
  }

  async mGet(keys) {
    return Promise.all(keys.map((key) => this.get(key) ?? null));
  }

  async set(key, value, options = {}) {
    this._isExpired(key);
    if (options?.nx && this.strings.has(key)) {
      return "";
    }
    if (options?.xx && !this.strings.has(key)) {
      return "";
    }
    this.strings.set(key, value);
    if (options?.expiration instanceof Date) {
      this.expiresAtSeconds.set(key, Math.floor(options.expiration.getTime() / 1000));
    }
    return "OK";
  }

  async del(key) {
    this.strings.delete(key);
    this.hashes.delete(key);
    this.sortedSets.delete(key);
    this.expiresAtSeconds.delete(key);
  }

  async incrBy(key, value) {
    this._isExpired(key);
    const nextValue = Number(this.strings.get(key) || 0) + value;
    this.strings.set(key, String(nextValue));
    return nextValue;
  }

  async expire(key, seconds) {
    this.expiresAtSeconds.set(key, this._nowSeconds() + seconds);
  }

  async expireTime(key) {
    this._isExpired(key);
    return this.expiresAtSeconds.get(key) || -1;
  }

  async hGet(key, field) {
    this._isExpired(key);
    return this.hashes.get(key)?.get(field);
  }

  async hDel(key, fields) {
    this._isExpired(key);
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) {
      if (hash.delete(field)) removed += 1;
    }
    return removed;
  }

  async hSet(key, fieldValues) {
    this._isExpired(key);
    const hash = this.hashes.get(key) || new Map();
    this.hashes.set(key, hash);
    let added = 0;
    for (const [field, value] of Object.entries(fieldValues)) {
      if (!hash.has(field)) {
        added += 1;
      }
      hash.set(field, value);
    }
    return added;
  }

  async hSetNX(key, field, value) {
    this._isExpired(key);
    const hash = this.hashes.get(key) || new Map();
    if (hash.has(field)) {
      return 0;
    }
    this.hashes.set(key, hash);
    hash.set(field, value);
    return 1;
  }

  async hMGet(key, fields) {
    this._isExpired(key);
    const hash = this.hashes.get(key) || new Map();
    return fields.map((field) => hash.get(field) ?? null);
  }

  async hGetAll(key) {
    this._isExpired(key);
    return Object.fromEntries(this.hashes.get(key)?.entries() || []);
  }

  async hScan(key, cursor, _pattern, count = 10) {
    this._isExpired(key);
    const entries = [...(this.hashes.get(key)?.entries() || [])];
    const start = Math.max(0, cursor);
    const end = Math.min(entries.length, start + count);
    return {
      cursor: end < entries.length ? end : 0,
      fieldValues: entries.slice(start, end).map(([field, value]) => ({ field, value })),
    };
  }

  async zAdd(key, ...members) {
    this._isExpired(key);
    const set = this.sortedSets.get(key) || new Map();
    this.sortedSets.set(key, set);
    for (const member of members) {
      set.set(member.member, member.score);
    }
    return members.length;
  }

  async zCard(key) {
    this._isExpired(key);
    return this.sortedSets.get(key)?.size || 0;
  }

  async zRank(key, member) {
    this._isExpired(key);
    const set = this.sortedSets.get(key);
    if (!set || !set.has(member)) {
      return undefined;
    }
    const ordered = [...set.entries()].sort((a, b) => {
      if (a[1] === b[1]) {
        return a[0].localeCompare(b[0]);
      }
      return a[1] - b[1];
    });
    const index = ordered.findIndex(([candidate]) => candidate === member);
    return index >= 0 ? index : undefined;
  }

  async zScore(key, member) {
    this._isExpired(key);
    return this.sortedSets.get(key)?.get(member);
  }

  async zRem(key, members) {
    this._isExpired(key);
    const set = this.sortedSets.get(key);
    members.forEach((member) => set?.delete(member));
    return members.length;
  }

  async zRange(key, start, stop) {
    this._isExpired(key);
    const ordered = [...(this.sortedSets.get(key)?.entries() || [])]
      .sort((a, b) => {
        if (a[1] === b[1]) return a[0].localeCompare(b[0]);
        return a[1] - b[1];
      });
    return ordered.slice(start, stop + 1).map(([member, score]) => ({ member, score }));
  }

  async watch() {
    const commands = [];
    return {
      multi: async () => {},
      unwatch: async () => {},
      del: async (...args) => {
        commands.push(() => this.del(...args));
      },
      set: async (...args) => {
        commands.push(() => this.set(...args));
      },
      hSet: async (...args) => {
        commands.push(() => this.hSet(...args));
      },
      zAdd: async (...args) => {
        commands.push(() => this.zAdd(...args));
      },
      incrBy: async (...args) => {
        commands.push(() => this.incrBy(...args));
      },
      expire: async (...args) => {
        commands.push(() => this.expire(...args));
      },
      exec: async () => {
        const results = [];
        for (const command of commands) {
          results.push(await command());
        }
        return results;
      },
    };
  }
}

const redis = new RedisTestDouble();

vi.mock("@devvit/redis", () => ({
  redis,
  redisCompressed: redis,
}));

const {
  getGuestProgressSelection,
  getServerDailyGpChallenge,
  getServerDailyGpPlaylist,
} = await import("../src/server/daily-gp-store.ts");
const { startServerCampaignRace } = await import("../src/server/campaign-store.ts");
const { recordCompletedRace } = await import("../src/server/car-unlock-store.ts");
const { mintGuestPlayerToken } = await import("../src/server/player-token.ts");

const REDIS_METHODS = [
  "get", "mGet", "set", "del", "incrBy", "expire", "expireTime",
  "hGet", "hDel", "hSet", "hSetNX", "hMGet", "hGetAll", "hScan",
  "zAdd", "zCard", "zRank", "zScore", "zRem", "zRange", "watch",
];

let redisCalls = 0;

function countRedisCalls() {
  redisCalls = 0;
  for (const method of REDIS_METHODS) {
    const original = RedisTestDouble.prototype[method];
    redis[method] = async function counted(...args) {
      redisCalls += 1;
      return original.apply(this, args);
    };
  }
}

function stopCountingRedisCalls() {
  for (const method of REDIS_METHODS) delete redis[method];
}

async function seedSevenDayPlaylist() {
  const realNow = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let dayOffset = 6; dayOffset >= 0; dayOffset -= 1) {
    vi.setSystemTime(new Date(realNow - (dayOffset * 86400000)));
    await getServerDailyGpChallenge();
  }
  vi.setSystemTime(new Date(realNow));
  vi.useRealTimers();
}

describe("guest progress selection", () => {
  beforeEach(() => {
    redis.reset();
    stopCountingRedisCalls();
  });

  it("answers a guest that owns runs without walking the Daily playlist", async () => {
    await seedSevenDayPlaylist();
    expect((await getServerDailyGpPlaylist()).length).toBe(7);
    // Every accepted run records this event, so it is the cheap proof the guest owns progress.
    await recordCompletedRace("guest:cheap-evidence");

    countRedisCalls();
    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:cheap-evidence",
      redditPlayerId: "reddit:cheap-evidence",
    });
    stopCountingRedisCalls();

    expect(selection.required).toBe(true);
    expect(selection.guestHasProgress).toBe(true);
    // A per-day walk of the 7-day playlist costs 14 reads per identity on its own.
    expect(redisCalls).toBeLessThan(12);
  });

  it("confirms an empty-looking guest against the playlist before it can be retired", async () => {
    await seedSevenDayPlaylist();

    countRedisCalls();
    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:no-evidence",
      redditPlayerId: "reddit:no-evidence",
    });
    stopCountingRedisCalls();

    expect(selection.required).toBe(false);
    expect(selection.guestHasProgress).toBe(false);
    // Retiring the guest destroys its runs, so this answer is never given on cheap evidence alone.
    expect(redisCalls).toBeGreaterThan(14);
  });

  it("reports Campaign progress the guest never completed a race for", async () => {
    await seedSevenDayPlaylist();
    const guestToken = await mintGuestPlayerToken("campaign-only");
    await startServerCampaignRace({
      raceId: "numbered-v1-00",
      playerId: "campaign-only",
      guestToken,
    });

    const selection = await getGuestProgressSelection({
      guestPlayerId: "guest:campaign-only",
      redditPlayerId: "reddit:campaign-only",
    });

    expect(selection.required).toBe(true);
    expect(selection.guestSummary).toEqual({
      hasDailyResults: false,
      campaignResults: 0,
      unlocks: false,
    });
  });
});
