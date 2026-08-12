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
import {
  DEFAULT_CAR_UNLOCK_SNAPSHOT,
  normalizeCarUnlockSnapshot,
} from "./car/car-unlock-policy.js";
import {
  readCachedPlayerProfile,
  readLastConfirmedProfileOwnerId,
  writeCachedPlayerProfile,
} from "./player/profile-cache.js";

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
    carUnlocks: normalizeCarUnlockSnapshot(payload?.carUnlocks),
    retireGuestIdentity: Boolean(payload?.retireGuestIdentity),
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
    carUnlocks: DEFAULT_CAR_UNLOCK_SNAPSHOT,
    authoritative: true,
  };
}

/**
 * A hosted bootstrap that never answered says nothing about this player. Presenting the all-locked
 * default as if it were the answer resets an unlocked selection the server still recognises, so the
 * last confirmed profile stands in and an unknown one stays unknown.
 */
function getHostedFallbackPlayerProgressState() {
  const cached = readCachedPlayerProfile(readLastConfirmedProfileOwnerId());
  return {
    hasAnyData: cached?.hasAnyData ?? hasAnyDailyChallengeStoredData(),
    isReturningPlayer: cached?.isReturningPlayer ?? false,
    redditUsername: cached?.redditUsername ?? null,
    leaderboardIdentity: getLeaderboardIdentityPreference(),
    leaderboardPlayerId: getOrCreatePlayerId("player bootstrap"),
    playerPreferences: cached?.playerPreferences ?? null,
    carUnlocks: cached?.carUnlocks ?? null,
    authoritative: false,
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
      // Keep the player id and drop only the token: the id is the only handle on this guest's progress, and the server re-issues a token for it.
      setGuestPlayerToken(null);
      remoteState = await fetchRemotePlayerProgressState();
    }
    if (remoteState) {
      setGuestPlayerToken(remoteState.guestToken);
      if (remoteState.retireGuestIdentity) {
        rotateGuestPlayerIdentity("completed guest promotion");
      }
      setLeaderboardIdentityPreference(remoteState.leaderboardIdentity);
      const authoritativeState = { ...remoteState, authoritative: true };
      writeCachedPlayerProfile(
        remoteState.leaderboardPlayerId ?? getOrCreatePlayerId("player bootstrap"),
        authoritativeState,
      );
      return authoritativeState;
    }
  } catch (error) {
    console.error("Error loading player progress state:", error);
  }

  return getHostedFallbackPlayerProgressState();
}
