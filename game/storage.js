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
  moveVerificationEntriesToOwner,
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
    guestJoinedAccount: payload?.guestJoinedAccount === true,
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
    setGuestPlayerToken(null);
    return await fetchRemotePlayerProgressState();
  }
}

function getLocalPlayerProgressState() {
  const hasAnyData = hasAnyDailyChallengeStoredData();
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
  let pauseReleaseFailed = false;
  setGuestPlayerToken(remoteState.guestToken);
  const guestOwnerId = toGuestOwnerId(getOrCreatePlayerId("guest progress selection"));
  const isSignedInAccount = Boolean(remoteState.redditUsername)
    && remoteState.leaderboardPlayerId?.startsWith("reddit:");
  const progressSelection = remoteState.progressSelection;
  const guestRetiredWithoutTransfer = isSignedInAccount
    && remoteState.retireGuestIdentity
    && !progressSelection;
  const guestJoinedAccount = guestRetiredWithoutTransfer
    && remoteState.guestJoinedAccount === true;
  const hasPendingGuestRuns = isSignedInAccount
    && !guestRetiredWithoutTransfer
    && hasVerificationEntriesForOwner(guestOwnerId);
  const hasKnownTransfer = Boolean(
    progressSelection?.required
      || progressSelection?.state === "resume_required"
      || progressSelection?.state === "recovery_required"
      || progressSelection?.state === "completed"
      || hasPendingGuestRuns,
  );
  const alreadyReconciled = progressSelection?.state === "completed"
    && isVerificationQueueGuestProgressReconciled({
      transferId: progressSelection.transferId,
      guestPlayerId: progressSelection.sourceGuestPlayerId || guestOwnerId,
      accountPlayerId: remoteState.leaderboardPlayerId,
      choice: progressSelection.choice,
    });
  if (hasKnownTransfer && !alreadyReconciled) {
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
    pauseReleaseFailed = !clearVerificationQueueTransferBlock(remoteState.leaderboardPlayerId);
    if (pauseReleaseFailed) {
      console.error("Could not release the transfer pause for", remoteState.leaderboardPlayerId);
    }
  }
  let guestRunsStillUnmoved = false;
  if (guestJoinedAccount) {
    const { persisted } = moveVerificationEntriesToOwner(
      guestOwnerId,
      remoteState.leaderboardPlayerId,
    );
    guestRunsStillUnmoved = !persisted;
    if (guestRunsStillUnmoved) {
      console.error("Could not move this device's unsent guest runs to the account.");
    }
  }
  if (remoteState.retireGuestIdentity && !guestRunsStillUnmoved) {
    rotateGuestPlayerIdentity("completed guest promotion");
    if (!remoteState.leaderboardPlayerId) {
      const rebootstrapped = await fetchRemotePlayerProgressState();
      if (rebootstrapped) {
        setGuestPlayerToken(rebootstrapped.guestToken);
        remoteState = rebootstrapped;
      }
    }
  }
  setLeaderboardIdentityPreference(remoteState.leaderboardIdentity);
  if (!remoteState.leaderboardPlayerId) {
    return { ...remoteState, authoritative: false };
  }
  if (!hasKnownTransfer || alreadyReconciled) {
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

  let transferRecoveryUnresolved = false;
  const isTransferRecoveryError = (error) => Boolean(
    error?.transferRecovery || error?.reason === "guest_progress_recovery_required",
  );
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
    return offlineState();
  }
}
