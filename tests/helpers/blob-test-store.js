import { BlobListTokenRejectedError } from "../../src/server/blob/blob-store.ts";

// An in-memory blob store with the shape of the server's BlobStore. Tests can
// make calls fail, stall, return other bytes, or refuse a listing token.
// Listings are in key order, as S3 lists them.
export function createBlobTestStore({ now = () => Date.now() } = {}) {
  const objects = new Map();
  const calls = [];
  const faults = {
    put: null,
    get: null,
    list: null,
    delete: null,
  };
  let rejectTokens = false;
  let tokenSerial = 0;
  const tokens = new Map();

  function fault(kind, key) {
    const rule = faults[kind];
    if (!rule) return null;
    return typeof rule === "function" ? rule(key) : rule;
  }

  async function apply(kind, key, signal, run) {
    calls.push({ kind, key });
    const action = fault(kind, key);
    if (action === "fail") throw new Error(`blob ${kind} failed`);
    if (action === "stall") {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return run(action);
  }

  const store = {
    async put(key, body, signal) {
      return apply("put", key, signal, () => {
        objects.set(key, { bytes: new Uint8Array(body), lastModifiedMs: now() });
      });
    },
    async get(key, signal) {
      return apply("get", key, signal, (action) => {
        const found = objects.get(key);
        if (!found) return null;
        if (action === "corrupt") {
          const bytes = new Uint8Array(found.bytes);
          bytes[bytes.length - 1] ^= 0xff;
          return bytes;
        }
        return new Uint8Array(found.bytes);
      });
    },
    async list(prefix, token, maxKeys, signal) {
      return apply("list", prefix, signal, () => {
        let after = null;
        if (token) {
          if (rejectTokens || !tokens.has(token)) throw new BlobListTokenRejectedError();
          after = tokens.get(token);
        }
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(prefix) && (after === null || key > after))
          .sort();
        const pageKeys = keys.slice(0, maxKeys);
        let nextToken = null;
        if (keys.length > maxKeys) {
          tokenSerial += 1;
          nextToken = `token-${tokenSerial}`;
          tokens.set(nextToken, pageKeys[pageKeys.length - 1]);
        }
        return {
          objects: pageKeys.map((key) => ({
            key,
            size: objects.get(key).bytes.byteLength,
            lastModifiedMs: objects.get(key).lastModifiedMs,
          })),
          nextToken,
        };
      });
    },
    async delete(key, signal) {
      return apply("delete", key, signal, () => {
        objects.delete(key);
      });
    },
  };

  return {
    store,
    objects,
    calls,
    faults,
    rejectListTokens(value = true) {
      rejectTokens = value;
    },
    keys(prefix = "") {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    setLastModified(key, ms) {
      const found = objects.get(key);
      if (found) found.lastModifiedMs = ms;
    },
    count(kind) {
      return calls.filter((call) => call.kind === kind).length;
    },
  };
}
