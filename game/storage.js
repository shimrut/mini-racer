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
  isVerificationQueueGuestProgressReconciled,
  recordVerificationQueueTransferBlock,
  clearVerificationQueueTransferBlock,
  confirmVerificationQueueTransferSafety,
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
  // Set when a resolved transfer's pause could not be taken off this browser. Availability, not
  // safety: the player stays paused until a later start-up succeeds in removing it.
  let pauseReleaseFailed = false;
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
  // A completion this browser already reconciled is old news. Doing the work again would wipe the
  // local Daily caches and medals on every launch for as long as the server keeps reporting it.
  const alreadyReconciled = progressSelection?.state === "completed"
    && isVerificationQueueGuestProgressReconciled({
      transferId: progressSelection.transferId,
      guestPlayerId: progressSelection.sourceGuestPlayerId || guestOwnerId,
      accountPlayerId: remoteState.leaderboardPlayerId,
      choice: progressSelection.choice,
    });
  if (hasKnownTransfer && !alreadyReconciled) {
    // Written down before anything else, and scoped to the two identities this transfer names.
    // A reload followed by a network failure finds it again, so this browser cannot slip into
    // ordinary offline mode with the transfer still open. If it cannot be written, this browser
    // cannot be trusted to hold the pause, so the transfer stays unresolved.
    const blocked = recordVerificationQueueTransferBlock({
      transferId: progressSelection?.transferId,
      guestPlayerId: progressSelection?.sourceGuestPlayerId || guestOwnerId,
      accountPlayerId: remoteState.leaderboardPlayerId,
      state: progressSelection?.state || "choice_required",
    });
    if (!blocked) {
      const error = new Error("This device cannot pause racing while your transfer finishes.");
      error.reason = "guest_progress_recovery_required";
      error.transferRecovery = true;
      throw error;
    }
    setActivePlayerOwnerId(null);
    await onProgressSelectionRequired?.(remoteState.progressSelection);
    let selectionResult;
    let selectionReturnedRawState = true;
    if (progressSelection?.state === "completed") {
      // remoteState is already normalized here, so it must not be normalized a second time.
      selectionReturnedRawState = false;
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
    remoteState = selectionReturnedRawState
      ? normalizeRemotePlayerProgressState(selectionResult.playerState)
      : selectionResult.playerState;
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
    // The transfer is resolved and its reconciliation is durable, so the pause may go. A removal
    // that storage refuses leaves this browser paused on work that is actually finished. That
    // costs the player racing, not data, so it is reported rather than thrown.
    pauseReleaseFailed = !clearVerificationQueueTransferBlock(remoteState.leaderboardPlayerId);
    if (pauseReleaseFailed) {
      console.error("Could not release the transfer pause for", remoteState.leaderboardPlayerId);
    }
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
  // The server named this account and left nothing unresolved for it, so a marker from an earlier
  // visit is stale. Another owner's block is left alone.
  if (!hasKnownTransfer || alreadyReconciled) {
    // The server named this account and left nothing unresolved for it. That is the only thing
    // that can settle transfer safety for a browser whose storage cannot be read.
    confirmVerificationQueueTransferSafety();
    if (!clearVerificationQueueTransferBlock(remoteState.leaderboardPlayerId)) {
      pauseReleaseFailed = true;
      console.error("Could not clear a stale transfer pause for", remoteState.leaderboardPlayerId);
    }
  }
  const authoritativeState = {
    ...remoteState,
    authoritative: true,
    ...(pauseReleaseFailed ? { transferPauseReleaseFailed: true } : {}),
  };
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

  // A transfer this browser knows about but could not resolve. Held for the whole call, because
  // the browser storage that would normally remember it is exactly what may have failed.
  let transferRecoveryUnresolved = false;
  const isTransferRecoveryError = (error) => Boolean(
    error?.transferRecovery || error?.reason === "guest_progress_recovery_required",
  );
  // An ordinary connection failure may fall back to offline play. An unresolved transfer may not:
  // racing offline now would build results on top of a replacement that never finished.
  const offlineState = () => {
    const fallback = getHostedFallbackPlayerProgressState();
    return transferRecoveryUnresolved
      ? { ...fallback, progressTransferBlocked: true }
      : fallback;
  };

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
      if (isTransferRecoveryError(error)) transferRecoveryUnresolved = true;
    }

    const mustStayOnline = transferRecoveryUnresolved
      || getHostedFallbackPlayerProgressState().progressTransferBlocked;
    if (!promptOnSyncFailure && !mustStayOnline) {
      return getHostedFallbackPlayerProgressState();
    }

    const decision = await requestServerSyncFailureChoice({
      retry: fetchHostedPlayerProgressState,
      allowOffline: !mustStayOnline,
    });
    if (decision?.action === "synced" && decision.remoteState) {
      try {
        return await finalizeHostedPlayerProgressState(decision.remoteState, {
          onProgressSelectionRequired,
        });
      } catch (error) {
        console.error("Error loading player progress state:", error);
        if (isTransferRecoveryError(error)) transferRecoveryUnresolved = true;
        continue;
      }
    }
    if (decision?.action === "retry") {
      continue;
    }
    // Offline was not on offer while the transfer is unresolved, so this is a dismissal rather
    // than a choice to play offline. The state says so, and the queue keeps submissions paused.
    return offlineState();
  }
}
