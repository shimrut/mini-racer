import { createHash } from "node:crypto";

/** Shared in-memory Redis stand-in for the transfer, lock, and recovery suites. */
export class RedisTestDouble {
  constructor() {
    this.reset();
  }

  reset() {
    this.strings = new Map();
    this.hashes = new Map();
    this.sortedSets = new Map();
    this.expiresAtSeconds = new Map();
    this.versions = new Map();
    this.beforeExec = null;
    this.failLockRelease = false;
    // Reddit answers a lost WATCH race by throwing, where this double returns nothing. Tests
    // that need production's shape turn this on.
    this.throwTransactionConflictAt = null;
    this.execCount = 0;
    this.failTransferRecordWriteAt = null;
    this.transferRecordWriteCount = 0;
  }

  _nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  _bump(key) {
    this.versions.set(key, (this.versions.get(key) || 0) + 1);
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
    this._bump(key);
    return true;
  }

  async get(key) {
    this._isExpired(key);
    return this.strings.get(key);
  }

  async mGet(keys) {
    return Promise.all(keys.map(async (key) => (await this.get(key)) ?? null));
  }

  async set(key, value, options = {}) {
    this._isExpired(key);
    if (key.includes("guest-progress-selection:v1:") && !key.endsWith(":lock")) {
      this.transferRecordWriteCount += 1;
      if (this.transferRecordWriteCount === this.failTransferRecordWriteAt) {
        this.failTransferRecordWriteAt = null;
        throw new Error("simulated transfer checkpoint failure");
      }
    }
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
    this._bump(key);
    return "OK";
  }

  async del(key) {
    const failAfterMutation = this.failLockRelease && key.endsWith(":lock");
    this.strings.delete(key);
    this.hashes.delete(key);
    this.sortedSets.delete(key);
    this.expiresAtSeconds.delete(key);
    this._bump(key);
    if (failAfterMutation) {
      throw new Error("simulated lock release failure");
    }
  }

  async incrBy(key, value) {
    this._isExpired(key);
    const nextValue = Number(this.strings.get(key) || 0) + value;
    this.strings.set(key, String(nextValue));
    return nextValue;
  }

  async expire(key, seconds) {
    this.expiresAtSeconds.set(key, this._nowSeconds() + seconds);
    this._bump(key);
  }

  setBeforeExec(callback) {
    this.beforeExec = callback;
  }

  touch(key) {
    this._bump(key);
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

  async watch(...keys) {
    const watchedVersions = new Map(
      keys.map((key) => [key, this.versions.get(key) || 0]),
    );
    const commands = [];
    return {
      multi: async () => {},
      unwatch: async () => {},
      discard: async () => {},
      del: async (...args) => {
        commands.push(() => this.del(...args));
      },
      set: async (...args) => {
        commands.push(() => this.set(...args));
      },
      hSet: async (...args) => {
        commands.push(() => this.hSet(...args));
      },
      hDel: async (...args) => {
        commands.push(() => this.hDel(...args));
      },
      zAdd: async (...args) => {
        commands.push(() => this.zAdd(...args));
      },
      zRem: async (...args) => {
        commands.push(() => this.zRem(...args));
      },
      incrBy: async (...args) => {
        commands.push(() => this.incrBy(...args));
      },
      expire: async (...args) => {
        commands.push(() => this.expire(...args));
      },
      exec: async () => {
        this.execCount += 1;
        if (this.execCount === this.throwTransactionConflictAt) {
          this.throwTransactionConflictAt = null;
          throw Object.assign(new Error('2 UNKNOWN: redis: transaction failed'), {
            code: 2,
            details: 'redis: transaction failed',
          });
        }
        if (this.beforeExec) this.beforeExec(keys);
        if ([...watchedVersions.entries()].some(([key, version]) => (
          (this.versions.get(key) || 0) !== version
        ))) return [];
        const results = [];
        for (const command of commands) {
          results.push(await command());
        }
        return results;
      },
    };
  }
}
