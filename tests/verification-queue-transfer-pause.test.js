import { beforeEach, describe, expect, it, vi } from "vitest";

let store = new Map();
let failWrites = false;
let failReads = false;

let denyStorageProperty = false;

function installBrowserStorage() {
  global.window = {
    get localStorage() {
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

    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
    expect(queue.isVerificationQueueSubmissionBlocked(GUEST)).toBe(true);
    expect(queue.isVerificationQueueSubmissionBlocked(undefined)).toBe(true);
  });

  it("does not discard an unpersisted block when a later read succeeds and is empty", () => {
    failWrites = true;
    queue.recordVerificationQueueTransferBlock({ guestPlayerId: GUEST, accountPlayerId: ACCOUNT });
    failWrites = false;

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
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("cannot carry a pause that storage never took across a reload", async () => {
    failWrites = true;
    queue.recordVerificationQueueTransferBlock({ accountPlayerId: ACCOUNT });
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
    failWrites = false;

    vi.resetModules();
    const reloaded = await import("../game/scoreboard/verification-queue.js");

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
    store.set("VectorGpTransferBlocks", JSON.stringify({
      "reddit:paused": { accountPlayerId: "reddit:paused", guestPlayerId: GUEST, state: "resume_required" },
    }));
    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);

    failReads = true;

    expect(queue.isVerificationQueueSubmissionBlocked(ACCOUNT)).toBe(true);
  });

  it("refuses offline play on a cold start when storage cannot be read", () => {
    failReads = true;

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

    store.set("VectorGpTransferBlocks", JSON.stringify({
      [ACCOUNT]: { accountPlayerId: ACCOUNT, guestPlayerId: NEW_GUEST, state: "resume_required" },
    }));
    expect(queue.isVerificationQueueSubmissionBlocked(NEW_GUEST)).toBe(true);

    failReads = true;

    expect(queue.isVerificationQueueSubmissionBlocked(NEW_GUEST)).toBe(true);
  });
});
