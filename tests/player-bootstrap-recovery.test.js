import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PLAYER_ID_KEY = "VectorGpScoreboardPlayerId";
const GUEST_TOKEN_KEY = "VectorGpGuestPlayerToken";

function createLocalStorage(initialEntries = {}) {
  const values = new Map(Object.entries(initialEntries));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function createResponse(status, payload = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  };
}

describe("guest bootstrap recovery", () => {
  let localStorage;
  let consoleError;

  beforeEach(() => {
    vi.resetModules();
    localStorage = createLocalStorage({
      [PLAYER_ID_KEY]: "old-guest-id",
      [GUEST_TOKEN_KEY]: "old-guest-token",
      VectorGpDailyChallengeData: JSON.stringify({ saved: { bestTime: 12.3 } }),
      UnrelatedPreference: "keep-me",
    });
    vi.stubGlobal("window", {
      location: {
        hostname: "example.devvit.net",
        origin: "https://example.devvit.net",
        protocol: "https:",
      },
      localStorage,
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "new-guest-id") });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it("rotates once after 401, retries without the rejected token, and preserves local data", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createResponse(401))
      .mockResolvedValueOnce(createResponse(200, {
        playerId: "guest:new-guest-id",
        guestToken: "new-guest-token",
        leaderboardIdentity: "constructed",
        playerPreferences: null,
        hasAnyData: false,
        isReturningPlayer: false,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0][0]);
    const secondUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(firstUrl.searchParams.get("playerId")).toBe("old-guest-id");
    expect(firstUrl.searchParams.get("guestToken")).toBe("old-guest-token");
    expect(secondUrl.searchParams.get("playerId")).toBe("new-guest-id");
    expect(secondUrl.searchParams.has("guestToken")).toBe(false);
    expect(localStorage.getItem(PLAYER_ID_KEY)).toBe("new-guest-id");
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBe("new-guest-token");
    expect(localStorage.getItem("UnrelatedPreference")).toBe("keep-me");
    expect(localStorage.getItem("VectorGpDailyChallengeData")).toContain("12.3");
    expect(state.leaderboardPlayerId).toBe("guest:new-guest-id");
  });

  it("does not rotate for non-authorization failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(500));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PLAYER_ID_KEY)).toBe("old-guest-id");
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBe("old-guest-token");
    expect(state.leaderboardPlayerId).toBe("old-guest-id");
  });

  it("does not reuse a rejected token when browser storage cannot remove it", async () => {
    localStorage.removeItem = vi.fn(() => {
      throw new Error("storage is read-only");
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createResponse(401))
      .mockResolvedValueOnce(createResponse(200, {
        playerId: "guest:new-guest-id",
        guestToken: "new-guest-token",
        leaderboardIdentity: "constructed",
        playerPreferences: null,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    await getPlayerProgressState();

    const retryUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(retryUrl.searchParams.get("playerId")).toBe("new-guest-id");
    expect(retryUrl.searchParams.has("guestToken")).toBe(false);
  });

  it("stops after one failed recovery attempt and keeps the rotated local identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(401));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(PLAYER_ID_KEY)).toBe("new-guest-id");
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("UnrelatedPreference")).toBe("keep-me");
    expect(state.leaderboardPlayerId).toBe("new-guest-id");
  });
});
