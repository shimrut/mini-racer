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
  toGuestOwnerId,
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
import { requestServerSyncFailureChoice } from "./player/server-sync-failure.js";
import {
  hasVerificationEntriesForOwner,
  getCampaignVerificationEntriesForOwner,
  prepareVerificationQueueGuestProgressReconciliation,
  resolveVerificationQueueAfterGuestProgressSelection,
  recordVerificationQueueTransferBlock,
  clearVerificationQueueTransferBlock,
  isVerificationQueueSubmissionBlocked,
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

async function fetchHostedPlayerProgressState() {
  try {
    return await fetchRemotePlayerProgressState();
  } catch (error) {
    if (error?.status !== 401) {
      throw error;
    }
    // Keep the player id and drop only the token: the id is the only handle on this guest's progress, and the server re-issues a token for it.
    setGuestPlayerToken(null);
    return await fetchRemotePlayerProgressState();
  }
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
    progressTransferBlocked: isVerificationQueueSubmissionBlocked(),
  };
}

function addLocalCampaignSelectionEvidence(summary, ownerPlayerId) {
  const pendingEntries = getCampaignVerificationEntriesForOwner(ownerPlayerId);
  const pendingResults = Object.values(pendingEntries)
    .filter((entry) => entry?.verificationState === "pending" && entry?.progressConfirmed !== true)
    .length;
  return {
    ...(summary && typeof summary === "object" ? summary : {}),
    campaignPendingResults: pendingResults,
  };
}

function enrichProgressSelection(selection, { guestOwnerId, accountOwnerId }) {
  if (!selection || typeof selection !== "object") return selection;
  const guestSummary = addLocalCampaignSelectionEvidence(selection.guestSummary, guestOwnerId);
  const accountSummary = addLocalCampaignSelectionEvidence(selection.accountSummary, accountOwnerId);
  return {
    ...selection,
    guestSummary,
    accountSummary,
    guestHasProgress: Boolean(
      selection.guestHasProgress || guestSummary.campaignPendingResults > 0,
    ),
    accountHasProgress: Boolean(
      selection.accountHasProgress || accountSummary.campaignPendingResults > 0,
    ),
  };
}

async function finalizeHostedPlayerProgressState(remoteState, { onProgressSelectionRequired = null } = {}) {
  setGuestPlayerToken(remoteState.guestToken);
  const guestOwnerId = toGuestOwnerId(getOrCreatePlayerId("guest progress selection"));
  const isSignedInAccount = Boolean(remoteState.redditUsername)
    && remoteState.leaderboardPlayerId?.startsWith("reddit:");
  const hasPendingGuestRuns = isSignedInAccount
    && hasVerificationEntriesForOwner(guestOwnerId);
  const progressSelection = remoteState.progressSelection;
  const hasKnownTransfer = Boolean(
    progressSelection?.required
      || progressSelection?.state === "resume_required"
      || progressSelection?.state === "recovery_required"
      || progressSelection?.state === "completed"
      || hasPendingGuestRuns,
  );
  if (hasKnownTransfer) {
    // Written down before anything else, and scoped to the two identities this transfer names.
    // A reload followed by a network failure finds it again, so this browser cannot slip into
    // ordinary offline mode with the transfer still open.
    recordVerificationQueueTransferBlock({
      transferId: progressSelection?.transferId,
      guestPlayerId: progressSelection?.sourceGuestPlayerId || guestOwnerId,
      accountPlayerId: remoteState.leaderboardPlayerId,
      state: progressSelection?.state || "choice_required",
    });
    setActivePlayerOwnerId(null);
    await onProgressSelectionRequired?.(remoteState.progressSelection);
    let selectionResult;
    if (progressSelection?.state === "completed") {
      selectionResult = {
        choice: progressSelection.choice,
        transferId: progressSelection.transferId,
        sourceGuestPlayerId: progressSelection.sourceGuestPlayerId,
        completedAt: progressSelection.completedAt,
        playerState: remoteState,
      };
    } else {
      const selection = enrichProgressSelection(progressSelection || {
        required: true,
        guestHasProgress: true,
        accountHasProgress: Boolean(remoteState.hasAnyData),
        guestSummary: {
          hasDailyResults: true,
          campaignResults: 0,
          campaignUnlockedTracks: null,
          campaignTotalStages: null,
          dailySavedResults: null,
          dailyPlaylistSize: null,
          carsUnlocked: null,
          carsTotal: null,
          unlocks: false,
        },
        accountSummary: {
          hasDailyResults: false,
          campaignResults: 0,
          campaignUnlockedTracks: null,
          campaignTotalStages: null,
          dailySavedResults: null,
          dailyPlaylistSize: null,
          carsUnlocked: null,
          carsTotal: null,
          unlocks: false,
        },
      }, {
        guestOwnerId,
        accountOwnerId: remoteState.leaderboardPlayerId,
      });
      selectionResult = await requestGuestProgressSelection(selection, {
        onBeforeSubmit: (choice) => {
          const prepared = prepareVerificationQueueGuestProgressReconciliation({
            transferId: selection?.transferId,
            guestPlayerId: selection?.sourceGuestPlayerId || guestOwnerId,
            accountPlayerId: remoteState.leaderboardPlayerId,
            choice,
          });
          if (!prepared.prepared) {
            const error = new Error("This transfer is already being reconciled.");
            error.reason = "guest_progress_recovery_required";
            error.transferRecovery = true;
            throw error;
          }
          return prepared;
        },
      });
    }
    const choice = selectionResult?.choice;
    if (!selectionResult?.playerState) {
      throw new Error("Guest progress selection did not return account state.");
    }
    remoteState = normalizeRemotePlayerProgressState(selectionResult.playerState);
    setGuestPlayerToken(remoteState.guestToken);
    const reconciliation = resolveVerificationQueueAfterGuestProgressSelection({
      transferId: selectionResult.transferId || progressSelection?.transferId,
      completedAt: selectionResult.completedAt || progressSelection?.completedAt,
      guestPlayerId: selectionResult.sourceGuestPlayerId
        || progressSelection?.sourceGuestPlayerId
        || guestOwnerId,
      accountPlayerId: remoteState.leaderboardPlayerId,
      choice,
    });
    // Reconciliation must be on disk before the account's own state is applied and before any
    // submission resumes. A storage failure is an unresolved recovery, not a success.
    if (reconciliation.persisted === false) {
      const error = new Error("Your saved result is being protected while this transfer is reconciled.");
      error.reason = "guest_progress_recovery_required";
      error.transferRecovery = true;
      throw error;
    }
    clearDailyChallengeStoredData();
    const { clearDailyChallengeClientCaches } = await import("./daily-challenge/service.js");
    clearDailyChallengeClientCaches();
    clearTrackLastLapMedals();
    clearVerificationQueueTransferBlock(remoteState.leaderboardPlayerId);
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
  // The server named this account and reported no open transfer for it, so a marker left behind
  // by an earlier visit is stale. Another owner's block is left alone.
  if (!hasKnownTransfer) clearVerificationQueueTransferBlock(remoteState.leaderboardPlayerId);
  const authoritativeState = { ...remoteState, authoritative: true };
  setActivePlayerOwnerId(remoteState.leaderboardPlayerId);
  writeCachedPlayerProfile(remoteState.leaderboardPlayerId, authoritativeState);
  return authoritativeState;
}

export async function getPlayerProgressState({
  onProgressSelectionRequired = null,
  promptOnSyncFailure = false,
} = {}) {
  if (isLocalEnvironment()) {
    return getLocalPlayerProgressState();
  }

  while (true) {
    try {
      const remoteState = await fetchHostedPlayerProgressState();
      if (remoteState) {
        return await finalizeHostedPlayerProgressState(remoteState, {
          onProgressSelectionRequired,
        });
      }
    } catch (error) {
      console.error("Error loading player progress state:", error);
    }

    if (!promptOnSyncFailure) {
      return getHostedFallbackPlayerProgressState();
    }

    const decision = await requestServerSyncFailureChoice({
      retry: fetchHostedPlayerProgressState,
      allowOffline: !getHostedFallbackPlayerProgressState().progressTransferBlocked,
    });
    if (decision?.action === "synced" && decision.remoteState) {
      try {
        return await finalizeHostedPlayerProgressState(decision.remoteState, {
          onProgressSelectionRequired,
        });
      } catch (error) {
        console.error("Error loading player progress state:", error);
        continue;
      }
    }
    if (decision?.action === "retry") {
      continue;
    }
    return getHostedFallbackPlayerProgressState();
  }
}
