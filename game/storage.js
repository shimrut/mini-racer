import { hasAnyDailyChallengeStoredData } from "./daily-challenge/storage.js";
import {
  getLeaderboardIdentityPreference,
  normalizeLeaderboardIdentityPreference,
  setLeaderboardIdentityPreference,
} from "./scoreboard/display-preference.js";
import {
  API_ROUTES,
} from "./scoreboard/api-client.js";
import {
  getGuestPlayerToken,
  getOrCreatePlayerId,
  rotateGuestPlayerIdentity,
  setGuestPlayerToken,
} from "./scoreboard/player-identity.js";
import { isLocalEnvironment } from "./track/environment.js";

async function fetchRemotePlayerProgressState() {
  const config = API_ROUTES;
  if (!config?.playerBootstrapUrl || typeof fetch !== "function") {
    return null;
  }

  const url = new URL(config.playerBootstrapUrl, window.location.origin);
  url.searchParams.set("playerId", getOrCreatePlayerId("player bootstrap"));
  const guestToken = getGuestPlayerToken();
  if (guestToken) {
    url.searchParams.set("guestToken", guestToken);
  }

  const response = await fetch(url.toString(), { method: "GET" });

  if (!response.ok) {
    const error = new Error(`Player bootstrap failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  return {
    hasAnyData: Boolean(payload?.hasAnyData),
    isReturningPlayer: Boolean(payload?.isReturningPlayer),
    redditUsername:
      typeof payload?.redditUsername === "string" && payload.redditUsername.trim()
        ? payload.redditUsername.trim()
        : null,
    leaderboardIdentity: normalizeLeaderboardIdentityPreference(
      payload?.leaderboardIdentity
    ),
    leaderboardPlayerId:
      typeof payload?.playerId === "string" && payload.playerId.trim()
        ? payload.playerId.trim()
        : null,
    guestToken:
      typeof payload?.guestToken === "string" && payload.guestToken.trim()
        ? payload.guestToken.trim()
        : null,
    playerPreferences:
      payload?.playerPreferences && typeof payload.playerPreferences === "object"
        ? payload.playerPreferences
        : null,
  };
}

function getLocalPlayerProgressState() {
  const hasAnyData = hasAnyDailyChallengeStoredData();
  return {
    hasAnyData,
    isReturningPlayer: false,
    redditUsername: null,
    leaderboardIdentity: getLeaderboardIdentityPreference(),
    leaderboardPlayerId: getOrCreatePlayerId("player bootstrap"),
    playerPreferences: null,
  };
}

export async function getPlayerProgressState() {
  if (isLocalEnvironment()) {
    return getLocalPlayerProgressState();
  }

  try {
    let remoteState;
    try {
      remoteState = await fetchRemotePlayerProgressState();
    } catch (error) {
      if (error?.status !== 401) {
        throw error;
      }
      rotateGuestPlayerIdentity();
      remoteState = await fetchRemotePlayerProgressState();
    }
    if (remoteState) {
      setGuestPlayerToken(remoteState.guestToken);
      setLeaderboardIdentityPreference(remoteState.leaderboardIdentity);
      return remoteState;
    }
  } catch (error) {
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      console.error("Error loading player progress state:", error);
    }
  }

  return getLocalPlayerProgressState();
}
