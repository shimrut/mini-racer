import {
  clearDailyChallengeVerification,
  enqueueDailyChallengeVerification,
  getDueDailyChallengeVerifications,
  getDailyChallengeVerificationEntry,
  getNextVerificationAttemptAt,
  getVerificationRetryDelayMs,
  markDailyChallengeVerificationPending,
  markDailyChallengeVerificationRejected,
  createVerificationSnapshot,
  VERIFICATION_REJECTED_SNAPSHOT,
} from "./verification-queue.js";
import { setDailyChallengeBestTime } from "../daily-challenge/storage.js?v=1.91";
import { invalidateDailyChallengeSnapshot, submitDailyChallengeBestTime } from "../daily-challenge/service.js?v=1.94";
import { shouldAutoRetryVerificationQueue } from "../track/environment.js?v=1.91";

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
      !Number.isFinite(entry?.bestTime) ||
      !entry?.replay
    ) {
      return;
    }

    if (
      this.modal.matchesModalScoreboardContext({ challengeId: entry.challengeId })
    ) {
      this.modal.updateModalScoreboardSnapshot(
        createVerificationSnapshot({
          statusText: "Verifying...",
          verificationState: "pending",
          isLoading: true,
        }),
      );
    }

    try {
      const result = await submitDailyChallengeBestTime({
        challengeId: entry.challengeId,
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
      );
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            statusText: "Queued for retry",
            verificationState: "pending",
            isLoading: true,
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
      );
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(
          createVerificationSnapshot({
            statusText: "Retrying soon",
            verificationState: "pending",
            isLoading: true,
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
      invalidateDailyChallengeSnapshot(entry.challengeId);
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

      if (this.activeDailyChallenge?.id === entry.challengeId) {
        const scoreboardSnapshot = await this.refreshDailyChallengeSummary();
        if (
          this.modal.matchesModalScoreboardContext({
            challengeId: entry.challengeId,
          })
        ) {
          this.modal.updateModalScoreboardSnapshot(scoreboardSnapshot);
        }
      } else {
        this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      }
      return;
    }

    if (result?.status === 422) {
      markDailyChallengeVerificationRejected(entry.challengeId);
      this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
      if (
        this.modal.matchesModalScoreboardContext({
          challengeId: entry.challengeId,
        })
      ) {
        this.modal.updateModalScoreboardSnapshot(VERIFICATION_REJECTED_SNAPSHOT);
      }
      return;
    }

    markDailyChallengeVerificationPending(
      entry.challengeId,
      Date.now() + getVerificationRetryDelayMs(),
    );
    this.dailyChallengeUi.refreshDailyChallengeVerificationState(entry.challengeId);
    if (
      this.modal.matchesModalScoreboardContext({ challengeId: entry.challengeId })
    ) {
      this.modal.updateModalScoreboardSnapshot(
        createVerificationSnapshot({
          statusText: "Queued for retry",
          verificationState: "pending",
          isLoading: true,
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
