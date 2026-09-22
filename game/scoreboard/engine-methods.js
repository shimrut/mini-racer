import {
  clearDailyChallengeVerification,
  enqueueDailyChallengeVerification,
  getDueDailyChallengeVerifications,
  getDueCampaignVerifications,
  getDailyChallengeVerificationEntry,
  getNextVerificationAttemptAt,
  getVerificationRetryDelayMs,
  markDailyChallengeTrackPbRetry,
  markDailyChallengeVerificationPending,
  markDailyChallengeVerificationError,
  createVerificationSnapshot,
  isDailyChallengeVerificationExpired,
  isRetryableVerificationFailure,
} from "./verification-queue.js";
import {
  rollbackDailyChallengeBestIfMatchesFailedSubmission,
  setDailyChallengeBestTime,
} from "../daily-challenge/storage.js";
import {
  getCachedDailyChallengeSnapshot,
  getDailyChallengeSnapshot,
  submitDailyChallengeBestTime,
} from "../daily-challenge/service.js";
import { shouldAutoRetryVerificationQueue } from "../track/environment.js";

function scoreboardSnapshotFromSubmitRank(body, cachedSnapshot) {
  const playerRank = Number.isInteger(body?.playerRank) && body.playerRank > 0
    ? body.playerRank
    : null;
  const leaderboardEntryCount = Number.isInteger(body?.leaderboardEntryCount)
    && body.leaderboardEntryCount >= 0
    ? body.leaderboardEntryCount
    : null;
  if (playerRank == null && leaderboardEntryCount == null) {
    return null;
  }
  return {
    ...(cachedSnapshot && typeof cachedSnapshot === "object" ? cachedSnapshot : {}),
    isLoading: false,
    ...(playerRank != null
      ? { playerRank, playerRankLabel: `#${playerRank}` }
      : {}),
    ...(leaderboardEntryCount != null
      ? { leaderboardEntryCount, totalCount: leaderboardEntryCount }
      : {}),
  };
}

function challengeFromDailyVerificationEntry(engine, entry) {
  const active = engine?.activeDailyChallenge;
  if (active?.id === entry?.challengeId) return active;
  const completedLaps = Number.isInteger(entry?.completedLaps)
    ? Math.max(1, Math.trunc(entry.completedLaps))
    : null;
  return {
    id: entry.challengeId,
    challengeDate: entry.challengeDate,
    trackKey: entry.trackKey,
    objectiveType: entry.objectiveType,
    ...(completedLaps > 1
      ? { objectiveParams: { lapCount: completedLaps } }
      : {}),
  };
}

function previousBestFromVerificationEntry(entry) {
  if (!Number.isFinite(entry?.previousBestTime)) return null;
  return {
    bestTime: entry.previousBestTime,
    completedLaps: Number.isFinite(entry.previousCompletedLaps)
      ? entry.previousCompletedLaps
      : null,
    checkpointTimesSec: Array.isArray(entry.previousCheckpointTimesSec)
      ? entry.previousCheckpointTimesSec
      : null,
  };
}

export function rollbackLocalBestForFailedVerificationEntry(engine, entry) {
  if (!entry?.challengeId || !Number.isFinite(entry?.bestTime)) return null;
  const restored = rollbackDailyChallengeBestIfMatchesFailedSubmission(
    {
      id: entry.challengeId,
      challengeDate: entry.challengeDate,
      trackKey: entry.trackKey,
      objectiveType: entry.objectiveType,
    },
    entry.bestTime,
    previousBestFromVerificationEntry(entry),
  );
  if (
    engine?.activeDailyChallenge?.id === entry.challengeId
    || engine?.currentDailyChallenge?.id === entry.challengeId
  ) {
    engine.dailyChallengeBestResult = restored ? { ...restored } : null;
    if (!Object.prototype.hasOwnProperty.call(engine, "trackPersonalBestResult")) {
      engine.bestLapTime = Number.isFinite(restored?.bestTime)
        ? restored.bestTime
        : null;
    }
  }
  return restored;
}

export const scoreboardEngineMethods = {
  scheduleVerificationQueueProcessing(delayMs = null) {
    if (this.verificationQueueTimer !== null) {
      clearTimeout(this.verificationQueueTimer);
      this.verificationQueueTimer = null;
    }

    const resolvedDelay =
      delayMs === null
        ? (() => {
          const nextAttemptAt = getNextVerificationAttemptAt();
          return nextAttemptAt === null
            ? null
            : Math.max(0, nextAttemptAt - Date.now());
        })()
        : Math.max(0, delayMs);

    if (resolvedDelay === null) return;
    if (resolvedDelay > 0 && !shouldAutoRetryVerificationQueue()) return;

    this.verificationQueueTimer = window.setTimeout(() => {
      this.verificationQueueTimer = null;
      this.processVerificationQueue().catch((error) => {
        console.error("Error processing verification queue:", error);
        this.scheduleVerificationQueueProcessing(getVerificationRetryDelayMs());
      });
    }, resolvedDelay);
  },

  async processVerificationQueue() {
    if (this.isProcessingVerificationQueue) return;
    this.isProcessingVerificationQueue = true;

    try {
      const dueDailyEntries = getDueDailyChallengeVerifications();
      for (const entry of dueDailyEntries) {
        await this.processDailyChallengeVerificationEntry(entry);
      }
      const dueCampaignEntries = getDueCampaignVerifications();
      for (const entry of dueCampaignEntries) {
        await this.processCampaignVerificationEntry(entry);
      }
      if (this.campaignVerifiedBootstrap) {
        this.refreshCampaignVerificationOverlay?.();
      }
    } finally {
      this.isProcessingVerificationQueue = false;
      this.scheduleVerificationQueueProcessing(null);
    }
  },

  async processDailyChallengeVerificationEntry(entry) {
    if (
      !entry?.challengeId ||
      !Number.isFinite(entry?.bestTime)
    ) {
      return;
    }

    if (isDailyChallengeVerificationExpired(entry)) {
      clearDailyChallengeVerification(entry.challengeId);
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({ challengeId: entry.challengeId })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            verificationState: "error",
            isLoading: false,
            submissionStage: "error",
            statusText: "Leaderboard submission expired.",
          }),
        );
      }
      return;
    }

    if (!entry?.replay) {
      markDailyChallengeVerificationError(
        entry.challengeId,
        "Submission replay is missing. Finish another run to rank it.",
      );
      rollbackLocalBestForFailedVerificationEntry(this, entry);
      this.restorePreviousTrackPersonalBestGhost?.({
        id: entry.challengeId,
        trackKey: entry.trackKey,
      });
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({ challengeId: entry.challengeId })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            verificationState: "error",
            isLoading: false,
            submissionStage: "error",
            statusText: "Submission replay is missing. Finish another run to rank it.",
          }),
        );
      }
      return;
    }

    if (
      this.modal.matchesModalScoreboardContext({ challengeId: entry.challengeId })
    ) {
      this.modal.updateModalScoreboardSnapshot(
        createVerificationSnapshot({
          verificationState: "pending",
          isLoading: true,
          submissionStage: "verifying",
        }),
      );
    }
    markDailyChallengeVerificationPending(entry.challengeId, Date.now(), {
      submissionStage: "verifying",
      preserveUpdatedAt: true,
    });
    this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);

    try {
      const result = await submitDailyChallengeBestTime({
        challengeId: entry.challengeId,
        trackKey: entry.trackKey,
        bestTime: entry.bestTime,
        replay: entry.replay,
        checkpointTimesSec: entry.checkpointTimesSec,
        submissionOwnerId: entry.ownerPlayerId ?? null,
      });
      await this.handleDailyChallengeVerificationResult(entry, result);
    } catch (error) {
      console.error("Error submitting queued daily challenge time:", error);
      markDailyChallengeVerificationPending(
        entry.challengeId,
        Date.now() + getVerificationRetryDelayMs(),
        {
          submissionStage: "retrying",
          preserveUpdatedAt: true,
        },
      );
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            verificationState: "pending",
            isLoading: true,
            submissionStage: "retrying",
          }),
        );
      }
    }
  },

  async handleDailyChallengeVerificationResult(entry, result) {
    const currentEntry = getDailyChallengeVerificationEntry(entry.challengeId);
    if (
      !currentEntry ||
      currentEntry.updatedAt !== entry.updatedAt ||
      currentEntry.bestTime !== entry.bestTime
    ) {
      return;
    }

    const body = result?.body || null;
    if (result?.ok && body?.throttled) {
      markDailyChallengeVerificationPending(
        entry.challengeId,
        Date.now() + (Number(body?.retryAfterSeconds) || 1) * 1000,
        {
          submissionStage: "retrying",
          preserveUpdatedAt: true,
        },
      );
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            verificationState: "pending",
            isLoading: true,
            submissionStage: "retrying",
          }),
        );
      }
      return;
    }

    if (result?.status === 409 && body?.reason === "submission_identity_changed") {
      markDailyChallengeVerificationPending(
        entry.challengeId,
        Date.now() + getVerificationRetryDelayMs(),
        { submissionStage: "pending", preserveUpdatedAt: true },
      );
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      return;
    }

    if (result?.ok && body?.accepted && Number.isFinite(body?.bestTimeMs)) {
      this.applyCarUnlockSnapshot?.(body.carUnlocks);
      const challenge = challengeFromDailyVerificationEntry(this, entry);
      setDailyChallengeBestTime(
        challenge,
        body.bestTimeMs / 1000,
        Number.isFinite(body?.completedLaps)
          ? body.completedLaps
          : entry.completedLaps,
        Array.isArray(body?.checkpointTimesSec)
          ? body.checkpointTimesSec
          : entry.checkpointTimesSec,
      );

      const trackPbUnavailable = body.trackPbPersistenceStatus === "unavailable";
      let trackPbRetryPending = false;
      if (trackPbUnavailable) {
        const { exhausted } = markDailyChallengeTrackPbRetry(
          entry.challengeId,
          Date.now() + getVerificationRetryDelayMs(),
        );
        trackPbRetryPending = !exhausted;
      } else {
        clearDailyChallengeVerification(entry.challengeId);
      }

      const existingTrackBest = this.trackPersonalBestResult;
      const existingTrackBestTimeMs = Number.isFinite(existingTrackBest?.bestTime)
        ? Math.round(existingTrackBest.bestTime * 1000)
        : null;
      const hasCanonicalTrackPbContract = ["stored", "unchanged", "unavailable"]
        .includes(body.trackPbPersistenceStatus);
      const canonicalTrackPersonalBest =
        ["stored", "unchanged"].includes(body.trackPbPersistenceStatus)
        && body.trackPersonalBest && typeof body.trackPersonalBest === "object"
          ? body.trackPersonalBest
          : null;
      if (canonicalTrackPersonalBest) {
        this.installCanonicalTrackPersonalBestGhost?.(
          challenge,
          canonicalTrackPersonalBest,
        );
      } else if (trackPbUnavailable && !trackPbRetryPending) {
        this.markTrackPersonalBestGhostUnavailable?.(challenge);
      } else if (!hasCanonicalTrackPbContract && Number.isFinite(body.trackBestTimeMs)) {
        this.applyVerifiedTrackPersonalBest?.(challenge, {
          trackKey: entry.trackKey,
          bestTimeMs: body.trackBestTimeMs,
          checkpointTimesSec: body.trackPbImproved === true
            ? (Array.isArray(body.checkpointTimesSec)
                ? body.checkpointTimesSec
                : entry.checkpointTimesSec)
            : existingTrackBest?.checkpointTimesSec ?? null,
          ghostAvailable: Boolean(body.trackGhostAvailable),
        });
      }
      if (hasCanonicalTrackPbContract) {
        this.resolveTrackPersonalBestGhostPending?.(entry.challengeId);
      }
      const shouldRefreshGhost = !hasCanonicalTrackPbContract
        && Boolean(body.trackGhostAvailable) && (
        body.trackPbImproved === true
        || !Number.isFinite(existingTrackBestTimeMs)
        || body.trackBestTimeMs < existingTrackBestTimeMs
      );
      if (shouldRefreshGhost) {
        this.pbGhostService?.invalidate?.(entry.challengeId);
        try {
          await this.prepareTrackPersonalBestGhost?.(challenge, {
            forceRefresh: true,
          });
        } catch (error) {
          console.error("Error refreshing personal best ghost:", error);
        } finally {
          this.resolveTrackPersonalBestGhostPending?.(entry.challengeId);
        }
      } else if (!hasCanonicalTrackPbContract) {
        this.resolveTrackPersonalBestGhostPending?.(entry.challengeId);
      }

      let scoreboardSnapshot = scoreboardSnapshotFromSubmitRank(
        body,
        getCachedDailyChallengeSnapshot(entry.challengeId),
      );
      if (
        scoreboardSnapshot
        && this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(scoreboardSnapshot);
      }
      if (body.improved === true) {
        scoreboardSnapshot = this.leaderboards?.refreshDailyChallengeAfterAcceptedSubmission
          ? await this.leaderboards.refreshDailyChallengeAfterAcceptedSubmission(entry.challengeId)
          : await getDailyChallengeSnapshot({
              challengeId: entry.challengeId,
              forceRefresh: true,
            });
      }
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          scoreboardSnapshot || {
            isLoading: false,
            verificationState: "pending",
            submissionStage: null,
            statusText: null,
            playerRankLabel: null,
          },
        );
      }
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      void this.resolveLeaderboardOpponentAdvanceAfterVerification?.({
        mode: "daily",
        competitionId: entry.challengeId,
        benchmarkTimeMs: body.bestTimeMs,
      });
      return;
    }

    if (result && !result.ok && isRetryableVerificationFailure(result)) {
      markDailyChallengeVerificationPending(
        entry.challengeId,
        Date.now() + getVerificationRetryDelayMs(),
        {
          submissionStage: "retrying",
          statusText: typeof body?.error === "string" ? body.error : null,
          preserveUpdatedAt: true,
        },
      );
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            verificationState: "pending",
            isLoading: true,
            submissionStage: "retrying",
            statusText: typeof body?.error === "string" ? body.error : null,
          }),
        );
      }
      return;
    }

    if (result && !result.ok) {
      this.restorePreviousTrackPersonalBestGhost?.({
        id: entry.challengeId,
        trackKey: entry.trackKey,
      });
      markDailyChallengeVerificationError(
        entry.challengeId,
        typeof body?.error === "string" ? body.error : "Submission failed",
      );
      rollbackLocalBestForFailedVerificationEntry(this, entry);
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            verificationState: "error",
            isLoading: false,
            submissionStage: "error",
            statusText:
              typeof body?.error === "string" ? body.error : "Submission failed",
          }),
        );
      }
      return;
    }

    this.restorePreviousTrackPersonalBestGhost?.({
      id: entry.challengeId,
      trackKey: entry.trackKey,
    });
    markDailyChallengeVerificationError(
      entry.challengeId,
      "Submission unavailable",
    );
    rollbackLocalBestForFailedVerificationEntry(this, entry);
    this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
    if (this.modal.matchesModalScoreboardContext({ challengeId: entry.challengeId })) {
      this.modal.updateModalScoreboardSnapshot(
        createVerificationSnapshot({
          verificationState: "error",
          isLoading: false,
          submissionStage: "error",
          statusText: "Submission unavailable",
        }),
      );
    }
  },

  enqueueDailyChallengeVerificationSubmission({
    challenge,
    bestTime,
    completedLaps = null,
    replay,
    checkpointTimesSec = null,
    previousBest = null,
    isTrackPbCandidate = false,
  } = {}) {
    if (
      !challenge?.id ||
      challenge.trackKey !== this.currentTrackKey ||
      this.currentChallengeRun?.challengeId !== challenge.id ||
      this.currentChallengeRun?.trackKey !== challenge.trackKey
    ) {
      return false;
    }

    const { enqueued } = enqueueDailyChallengeVerification({
      challengeId: challenge?.id,
      bestTime,
      completedLaps,
      replay,
      checkpointTimesSec,
      objectiveType: challenge?.objectiveType,
      challengeDate: challenge?.challengeDate,
      trackKey: challenge?.trackKey,
      previousBestTime: Number.isFinite(previousBest?.bestTime)
        ? previousBest.bestTime
        : null,
      previousCompletedLaps: Number.isFinite(previousBest?.completedLaps)
        ? previousBest.completedLaps
        : null,
      previousCheckpointTimesSec: Array.isArray(previousBest?.checkpointTimesSec)
        ? previousBest.checkpointTimesSec
        : null,
      expiresAt: (() => {
        const availableUntilMs = Date.parse(challenge?.availableUntil);
        return Number.isFinite(availableUntilMs)
          ? new Date(availableUntilMs + (6 * 60 * 60 * 1000)).toISOString()
          : null;
      })(),
    });
    if (enqueued && isTrackPbCandidate) {
      this.markTrackPersonalBestGhostPending?.(challenge);
    }
    this.dailyChallengeUi.refreshDailyChallengeVerificationState(challenge?.id);
    if (enqueued) {
      const processing = this.processVerificationQueue?.();
      if (processing && typeof processing.catch === "function") {
        void processing.catch((error) => {
          console.error("Error processing verification queue:", error);
          this.scheduleVerificationQueueProcessing(getVerificationRetryDelayMs());
        });
      } else {
        this.scheduleVerificationQueueProcessing(0);
      }
    }
    return enqueued;
  },
};
