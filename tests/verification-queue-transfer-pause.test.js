import { beforeEach, describe, expect, it, vi } from "vitest";

let store = new Map();
let failWrites = false;
let failReads = false;

let denyStorageProperty = false;

function installBrowserStorage() {
  global.window = {
    get localStorage() {
      // Browsers set to block site data throw on the property itself, before any method call.
      if (denyStorageProperty) throw new Error("access to storage is denied");
      return storageObject;
    },
  };
}

const storageObject = {
  getItem(key) {
    if (failReads) throw new Error("storage unavailable");
    return store.has(key) ? store.get(key) : null;
  },
  setItem(key, value) {
    if (failWrites) throw new Error("quota exceeded");
    store.set(key, value);
  },
  removeItem(key) { store.delete(key); },
};

const GUEST = "guest:paused";
const ACCOUNT = "reddit:paused";
const UNRELATED = "reddit:unrelated";

describe("a known transfer keeps racing paused when browser storage fails", () => {
  let queue;

  beforeEach(async () => {
    store = new Map();
    failWrites = false;
    failReads = false;
    denyStorageProperty = false;
    installBrowserStorage();
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue = await import("../game/scoreboard/verification-queue.js");
  });

  it("reports the failed write and still holds the pause", () => {
    failWrites = true;

    expect(queue.recordVerificationQueueTransferBlock({
      transferId: "guest-transfer:1",
      guestPlayerId: GUEST,
      accountPlayerId: ACCOUNT,
    })).toBe(false);

    // The transfer stays unresolved for the caller, and this browser stops racing for both
    // identities it names, and for an identity it has not confirmed yet.
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
    expect(queue.isVerificationQueueSubmissionBlocked(GUEST)).toBe(true);
    expect(queue.isVerificationQueueSubmissionBlocked(undefined)).toBe(true);
  });

  it("does not discard an unpersisted block when a later read succeeds and is empty", () => {
    failWrites = true;
    queue.recordVerificationQueueTransferBlock({ guestPlayerId: GUEST, accountPlayerId: ACCOUNT });
    failWrites = false;

    // Storage works now and holds nothing. It never held this block, so its silence is not
    // evidence that the transfer was resolved.
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("releases a persisted block that another tab removed", () => {
    expect(queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT })).toBe(true);
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);

    store.clear();

    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(false);
  });

  it("retains what it already knows when the read itself fails", () => {
    queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT });
    failReads = true;

    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("leaves a confirmed unrelated account usable", () => {
    queue.recordVerificationQueueTransferBlock({ guestPlayerId: GUEST, accountPlayerId: ACCOUNT });

    expect(queue.isVerificationQueueSubmissionBlocked(UNRELATED)).toBe(false);
  });

  it("clears one account's block without erasing another's", () => {
    queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT });
    queue.recordVerificationQueueTransferBlock({ accountPlayerId: UNRELATED });

    expect(queue.clearVerificationQueueTransferBlock(UNRELATED)).toBe(true);

    expect(queue.isVerificationQueueSubmissionBlocked(UNRELATED)).toBe(false);
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("reports a removal storage refused instead of claiming the pause was lifted", () => {
    queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT });
    failWrites = true;

    expect(queue.clearVerificationQueueTransferBlock(ACCOUNT)).toBe(false);
    // The durable record still names it, so the pause holds until a later start-up removes it.
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("cannot carry a pause that storage never took across a reload", async () => {
    failWrites = true;
    queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT });
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
    failWrites = false;

    vi.resetModules();
    const reloaded = await import("../game/scoreboard/verification-queue.js");

    // The documented boundary. Memory does not survive a reload, so a browser whose storage
    // failed has to be told about the transfer by the server again before it can be safe.
    expect(reloaded.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(false);
  });
});

describe("a block only ever read back from storage is still held", () => {
  let queue;

  beforeEach(async () => {
    store = new Map();
    failWrites = false;
    failReads = false;
    denyStorageProperty = false;
    installBrowserStorage();
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue = await import("../game/scoreboard/verification-queue.js");
  });

  it("survives a storage failure after a cold load found it", async () => {
    // A previous session wrote this. This one has only ever read it.
    store.set("VectorGpTransferBlocks", JSON.stringify({
      "reddit:paused": { accountPlayerId: "reddit:paused", guestPlayerId: GUEST, state: "resume_required" },
    }));
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);

    failReads = true;

    // Reading fails now. The block was never written by this session, so without adopting it on
    // read there would be nothing left to hold the pause.
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("refuses offline play on a cold start when storage cannot be read", () => {
    failReads = true;

    // Nothing is known and nothing is ruled out. The agreed answer is a server connection.
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
    expect(queue.isVerificationQueueSubmissionBlocked(undefined)).toBe(true);
  });

  it("releases that hold once the server confirms the account is clear", () => {
    failReads = true;
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);

    queue.confirmVerificationQueueTransferSafety();

    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(false);
  });
});

describe("browser storage that denies access is handled, not thrown", () => {
  let queue;

  beforeEach(async () => {
    store = new Map();
    failWrites = false;
    failReads = false;
    denyStorageProperty = false;
    installBrowserStorage();
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue = await import("../game/scoreboard/verification-queue.js");
  });

  it("answers blocked instead of throwing when the property is denied", () => {
    denyStorageProperty = true;

    expect(() => queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).not.toThrow();
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("reports a failed write instead of throwing when the property is denied", () => {
    denyStorageProperty = true;

    expect(() => queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT }))
      .not.toThrow();
    expect(queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT })).toBe(false);
    // The pause is still held in memory even though nothing could be written down.
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });
});

describe("a cached block is refreshed, not just adopted once", () => {
  let queue;

  beforeEach(async () => {
    store = new Map();
    failWrites = false;
    failReads = false;
    denyStorageProperty = false;
    installBrowserStorage();
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue = await import("../game/scoreboard/verification-queue.js");
  });

  it("keeps the newer guest blocked after a later read failure", () => {
    const OLD_GUEST = "guest:old";
    const NEW_GUEST = "guest:new";

    store.set("VectorGpTransferBlocks", JSON.stringify({
      [ACCOUNT]: { accountPlayerId: ACCOUNT, guestPlayerId: OLD_GUEST, state: "resume_required" },
    }));
    expect(queue.isVerificationQueueSubmissionBlocked(OLD_GUEST)).toBe(true);

    // The same account is later named with a different guest.
    store.set("VectorGpTransferBlocks", JSON.stringify({
      [ACCOUNT]: { accountPlayerId: ACCOUNT, guestPlayerId: NEW_GUEST, state: "resume_required" },
    }));
    expect(queue.isVerificationQueueSubmissionBlocked(NEW_GUEST)).toBe(true);

    failReads = true;

    // A stale cached copy would restore the old pairing here and let the newer guest race.
    expect(queue.isVerificationQueueSubmissionBlocked(NEW_GUEST)).toBe(true);
  });
});
