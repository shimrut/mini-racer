import {
  clearDailyChallengeVerification,
  enqueueDailyChallengeVerification,
  getDueDailyChallengeVerifications,
  getDailyChallengeVerificationEntry,
  getNextVerificationAttemptAt,
  getVerificationRetryDelayMs,
  markDailyChallengeVerificationPending,
  markDailyChallengeVerificationError,
  createVerificationSnapshot,
} from "./verification-queue.js";
import { setDailyChallengeBestTime } from "../daily-challenge/storage.js";
import {
  getCachedDailyChallengeSnapshot,
  getDailyChallengeSnapshot,
  submitDailyChallengeBestTime,
} from "../daily-challenge/service.js";
import { shouldAutoRetryVerificationQueue } from "../track/environment.js";

function isRetryableVerificationFailure(result) {
  const status = Number(result?.status);
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
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

    if (!entry?.replay) {
      markDailyChallengeVerificationError(
        entry.challengeId,
        "Submission replay is missing. Finish another run to rank it.",
      );
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

    if (result?.ok && body?.accepted && Number.isFinite(body?.bestTimeMs)) {
      const challenge = {
        id: entry.challengeId,
        challengeDate: entry.challengeDate,
        trackKey: entry.trackKey,
        objectiveType: entry.objectiveType,
      };
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
      clearDailyChallengeVerification(entry.challengeId);

      let scoreboardSnapshot = getCachedDailyChallengeSnapshot(entry.challengeId);
      if (body.improved === true) {
        scoreboardSnapshot = this.leaderboards?.refreshDailyChallengeAfterAcceptedSubmission
          ? await this.leaderboards.refreshDailyChallengeAfterAcceptedSubmission(entry.challengeId)
          : await getDailyChallengeSnapshot({
              challengeId: entry.challengeId,
              forceRefresh: true,
            });
      }
      if (
        scoreboardSnapshot &&
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(scoreboardSnapshot);
      }
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
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
      markDailyChallengeVerificationError(
        entry.challengeId,
        typeof body?.error === "string" ? body.error : "Submission failed",
      );
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

    markDailyChallengeVerificationError(
      entry.challengeId,
      "Submission unavailable",
    );
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
    });
    this.dailyChallengeUi.refreshDailyChallengeVerificationState(challenge?.id);
    if (enqueued) {
      this.scheduleVerificationQueueProcessing(0);
    }
    return enqueued;
  },
};
