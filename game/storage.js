import { hasAnyDailyChallengeStoredData } from "./daily-challenge/storage.js?v=2.09";
import {
  getLeaderboardIdentityPreference,
  normalizeLeaderboardIdentityPreference,
  setLeaderboardIdentityPreference,
} from "./scoreboard/display-preference.js?v=2.09";
import {
  buildServiceHeaders,
  getBaseApiConfig,
  getOrCreatePlayerId,
} from "./scoreboard/api-client.js?v=2.09";
import { isLocalEnvironment } from "./track/environment.js?v=2.09";

async function fetchRemotePlayerProgressState() {
  const config = getBaseApiConfig();
  if (!config?.playerBootstrapUrl || typeof fetch !== "function") {
    return null;
  }

  const url = new URL(config.playerBootstrapUrl, window.location.origin);
  url.searchParams.set("playerId", getOrCreatePlayerId("player bootstrap"));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: buildServiceHeaders(config),
  });

  if (!response.ok) {
    throw new Error(`Player bootstrap failed: ${response.status}`);
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
  };
}

export async function getPlayerProgressState() {
  try {
    if (isLocalEnvironment()) {
      return getLocalPlayerProgressState();
    }
    const remoteState = await fetchRemotePlayerProgressState();
    if (remoteState) {
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

export async function hasAnyTrackData() {
  const state = await getPlayerProgressState();
  return state.hasAnyData;
}
