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

  it("normalizes a null bootstrap body into empty remote progress fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(200, null));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      hasAnyData: false,
      isReturningPlayer: false,
      redditUsername: null,
      leaderboardPlayerId: null,
      playerPreferences: null,
    });
  });

  it("ignores non-string reddit usernames from bootstrap payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(200, {
      hasAnyData: true,
      isReturningPlayer: true,
      redditUsername: 42,
      playerId: "guest:server-id",
      guestToken: "server-token",
      leaderboardIdentity: "reddit",
      playerPreferences: { pbGhostEnabled: true },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(state.redditUsername).toBe(null);
    expect(state.leaderboardPlayerId).toBe("guest:server-id");
    expect(state.playerPreferences).toEqual({ pbGhostEnabled: true });
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

  it("uses local progress state without fetching on localhost", async () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "localhost",
        origin: "http://localhost:5173",
        protocol: "http:",
      },
      localStorage,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      hasAnyData: true,
      isReturningPlayer: false,
      redditUsername: null,
      leaderboardPlayerId: "old-guest-id",
      playerPreferences: null,
    });
  });

  it("normalizes a successful remote bootstrap payload and stores trimmed credentials", async () => {
    localStorage.removeItem(GUEST_TOKEN_KEY);
    const preferences = { soundEnabled: true };
    const fetchMock = vi.fn().mockResolvedValue(createResponse(200, {
      hasAnyData: "yes",
      isReturningPlayer: 0,
      redditUsername: "  RaceFan  ",
      leaderboardIdentity: "reddit",
      playerId: "  guest:abc  ",
      guestToken: "  new-token  ",
      playerPreferences: preferences,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("playerId")).toBe("old-guest-id");
    expect(url.searchParams.has("guestToken")).toBe(false);
    expect(state).toMatchObject({
      hasAnyData: true,
      isReturningPlayer: false,
      redditUsername: "RaceFan",
      leaderboardIdentity: "reddit",
      leaderboardPlayerId: "guest:abc",
      guestToken: "new-token",
      playerPreferences: preferences,
    });
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBe("new-token");
  });

  it("nulls blank username and non-object preferences from bootstrap payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(200, {
      hasAnyData: false,
      isReturningPlayer: true,
      redditUsername: "   ",
      playerId: "   ",
      guestToken: "   ",
      playerPreferences: "nope",
      leaderboardIdentity: "constructed",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(state).toMatchObject({
      hasAnyData: false,
      isReturningPlayer: true,
      redditUsername: null,
      leaderboardPlayerId: null,
      guestToken: null,
      playerPreferences: null,
      leaderboardIdentity: "constructed",
    });
  });

  it("falls back to local state when fetch is unavailable on localhost", async () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "localhost",
        origin: "http://localhost:5173",
        protocol: "http:",
      },
      localStorage,
    });
    vi.stubGlobal("fetch", undefined);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(state.hasAnyData).toBe(true);
    expect(state.leaderboardPlayerId).toBe("old-guest-id");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs hosted bootstrap failures and still returns local progress", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(500));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    expect(state.leaderboardPlayerId).toBe("old-guest-id");
    expect(state.hasAnyData).toBe(true);
  });

  it("does not log bootstrap failures on loopback hosts", async () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "127.0.0.1",
        origin: "http://127.0.0.1:5173",
        protocol: "http:",
      },
      localStorage,
    });
    const fetchMock = vi.fn().mockResolvedValue(createResponse(500));
    vi.stubGlobal("fetch", fetchMock);
    const { getPlayerProgressState } = await import("../game/storage.js");

    const state = await getPlayerProgressState();

    expect(state.leaderboardPlayerId).toBe("old-guest-id");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns local progress when remote bootstrap has no usable URL", async () => {
    vi.resetModules();
    vi.doMock("../game/scoreboard/api-client.js", async () => {
      const actual = await vi.importActual("../game/scoreboard/api-client.js");
      return {
        ...actual,
        API_ROUTES: { playerBootstrapUrl: null },
      };
    });
    vi.stubGlobal("fetch", vi.fn());
    const { getPlayerProgressState } = await import("../game/storage.js");
    const state = await getPlayerProgressState();
    expect(state.leaderboardPlayerId).toBe("old-guest-id");
    expect(fetch).not.toHaveBeenCalled();
    vi.doUnmock("../game/scoreboard/api-client.js");
  });
});
