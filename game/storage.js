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
import { setActivePlayerOwnerId } from "./player/active-owner.js";
import { requestGuestProgressSelection } from "./player/guest-progress-selection.js";
import {
  hasVerificationEntriesForOwner,
  resolveVerificationQueueAfterGuestProgressSelection,
} from "./scoreboard/verification-queue.js";
import { clearDailyChallengeStoredData } from "./daily-challenge/storage.js";
import { clearTrackLastLapMedals } from "./medals/last-lap-medal-storage.js";

export const PLAYER_BOOTSTRAP_TIMEOUT_MS = 8_000;

async function fetchPlayerBootstrap(url) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), PLAYER_BOOTSTRAP_TIMEOUT_MS)
    : null;
  try {
    return await fetch(url, {
      method: "GET",
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function normalizeRemotePlayerProgressState(payload) {
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
    progressSelection: payload?.progressSelection && typeof payload.progressSelection === "object"
      ? payload.progressSelection
      : null,
  };
}

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

  const response = await fetchPlayerBootstrap(url.toString());

  if (!response.ok) {
    const error = new Error(`Player bootstrap failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return normalizeRemotePlayerProgressState(await response.json());
}

function getLocalPlayerProgressState() {
  const hasAnyData = hasAnyDailyChallengeStoredData();
  // Local development has no server to name an owner, so it owns its own namespace and keeps its queue working.
  setActivePlayerOwnerId(`local:${getOrCreatePlayerId("player bootstrap")}`);
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

export async function getPlayerProgressState({ onProgressSelectionRequired = null } = {}) {
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
      const guestPlayerId = getOrCreatePlayerId("guest progress selection");
      const isSignedInAccount = Boolean(remoteState.redditUsername)
        && remoteState.leaderboardPlayerId?.startsWith("reddit:");
      const hasPendingGuestRuns = isSignedInAccount
        && hasVerificationEntriesForOwner(`guest:${guestPlayerId}`);
      if (remoteState.progressSelection?.required || hasPendingGuestRuns) {
        setActivePlayerOwnerId(null);
        await onProgressSelectionRequired?.(remoteState.progressSelection);
        const selectionResult = await requestGuestProgressSelection(
          remoteState.progressSelection || {
            required: true,
            guestHasProgress: true,
            accountHasProgress: Boolean(remoteState.hasAnyData),
            guestSummary: { hasDailyResults: true, campaignResults: 0, unlocks: false },
            accountSummary: { hasDailyResults: false, campaignResults: 0, unlocks: false },
          },
        );
        const choice = selectionResult?.choice;
        if (!selectionResult?.playerState) {
          throw new Error("Guest progress selection did not return account state.");
        }
        remoteState = normalizeRemotePlayerProgressState(selectionResult.playerState);
        setGuestPlayerToken(remoteState.guestToken);
        resolveVerificationQueueAfterGuestProgressSelection({
          guestPlayerId: `guest:${guestPlayerId}`,
          accountPlayerId: remoteState.leaderboardPlayerId,
          choice,
        });
        clearDailyChallengeStoredData();
        const { clearDailyChallengeClientCaches } = await import("./daily-challenge/service.js");
        clearDailyChallengeClientCaches();
        clearTrackLastLapMedals();
      }
      if (remoteState.retireGuestIdentity) {
        rotateGuestPlayerIdentity("completed guest promotion");
        // The server refused a spent guest credential: this browser needs a fresh identity before it owns anything again.
        if (!remoteState.leaderboardPlayerId) {
          const rebootstrapped = await fetchRemotePlayerProgressState();
          if (rebootstrapped) {
            setGuestPlayerToken(rebootstrapped.guestToken);
            remoteState = rebootstrapped;
          }
        }
      }
      setLeaderboardIdentityPreference(remoteState.leaderboardIdentity);
      // Without a player id the server did not recognise anyone, so nothing here may be treated as this account's state.
      if (!remoteState.leaderboardPlayerId) {
        return { ...remoteState, authoritative: false };
      }
      const authoritativeState = { ...remoteState, authoritative: true };
      setActivePlayerOwnerId(remoteState.leaderboardPlayerId);
      writeCachedPlayerProfile(remoteState.leaderboardPlayerId, authoritativeState);
      return authoritativeState;
    }
  } catch (error) {
    console.error("Error loading player progress state:", error);
  }

  return getHostedFallbackPlayerProgressState();
}
