import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoreboardEngineMethods } from "../game/scoreboard/engine-methods.js";
import {
  enqueueDailyChallengeVerification,
  getDailyChallengeVerificationEntry,
  resetVerificationQueueForTests,
} from "../game/scoreboard/verification-queue.js";

const REPLAY = { inputs: [{ frames: 1, left: false, right: false }] };

function installLocalStorage() {
  const map = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, value),
      removeItem: (key) => map.delete(key),
    },
  };
}

describe("scoreboard engine verification retries", () => {
  beforeEach(() => {
    installLocalStorage();
    resetVerificationQueueForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.window;
  });

  it.each([
    [504, null],
    [503, {
      accepted: false,
      error: "Submission save was interrupted. Retrying automatically.",
    }],
  ])("keeps retryable HTTP %i submit failures queued instead of converting them to terminal errors", async (status, body) => {
    const challengeId = `daily-${status}`;
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 44,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });

    const entry = getDailyChallengeVerificationEntry(challengeId);
    const engine = {
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: { refreshDailyChallengeAfterAcceptedSubmission: vi.fn() },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => true),
        updateModalScoreboardSnapshot: vi.fn(),
      },
    };

    await scoreboardEngineMethods.handleDailyChallengeVerificationResult.call(
      engine,
      entry,
      {
        ok: false,
        status,
        body,
      },
    );

    expect(getDailyChallengeVerificationEntry(challengeId)).toMatchObject({
      verificationState: "pending",
      submissionStage: "retrying",
    });
    expect(engine.dailyChallengeUi.refreshDailyChallengeVerificationState).toHaveBeenCalledWith(
      challengeId,
    );
    expect(engine.modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationState: "pending",
        submissionStage: "retrying",
        isLoading: true,
        ...(body?.error ? { statusText: body.error } : {}),
      }),
    );
    expect(engine.leaderboards.refreshDailyChallengeAfterAcceptedSubmission)
      .not.toHaveBeenCalled();
  });

  it("routes an accepted better time through the session-aware standings refresh", async () => {
    const challengeId = "daily-accepted";
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 44,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const scoreboardSnapshot = {
      playerRankLabel: "#2",
      currentPlayerRow: { bestTime: 43 },
    };
    const engine = {
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: {
        refreshDailyChallengeAfterAcceptedSubmission: vi.fn()
          .mockResolvedValue(scoreboardSnapshot),
      },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => true),
        updateModalScoreboardSnapshot: vi.fn(),
      },
    };

    await scoreboardEngineMethods.handleDailyChallengeVerificationResult.call(
      engine,
      entry,
      {
        ok: true,
        status: 200,
        body: {
          accepted: true,
          improved: true,
          bestTimeMs: 43000,
          completedLaps: 1,
        },
      },
    );

    expect(engine.leaderboards.refreshDailyChallengeAfterAcceptedSubmission)
      .toHaveBeenCalledWith(challengeId);
    expect(engine.modal.updateModalScoreboardSnapshot)
      .toHaveBeenCalledWith(scoreboardSnapshot);
    expect(getDailyChallengeVerificationEntry(challengeId)).toBe(null);
  });

  it("does not refresh standings when an accepted replay did not improve the stored time", async () => {
    const challengeId = "daily-accepted-slower";
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 45,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const refreshAfterAcceptedSubmission = vi.fn();
    const engine = {
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: {
        refreshDailyChallengeAfterAcceptedSubmission: refreshAfterAcceptedSubmission,
      },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => true),
        updateModalScoreboardSnapshot: vi.fn(),
      },
    };

    await scoreboardEngineMethods.handleDailyChallengeVerificationResult.call(
      engine,
      entry,
      {
        ok: true,
        status: 200,
        body: {
          accepted: true,
          improved: false,
          bestTimeMs: 43000,
          completedLaps: 1,
        },
      },
    );

    expect(refreshAfterAcceptedSubmission).not.toHaveBeenCalled();
    expect(getDailyChallengeVerificationEntry(challengeId)).toBe(null);
  });

  it("does not refresh standings when a submission is rejected", async () => {
    const challengeId = "daily-rejected";
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 44,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const refreshAfterAcceptedSubmission = vi.fn();
    const engine = {
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: {
        refreshDailyChallengeAfterAcceptedSubmission: refreshAfterAcceptedSubmission,
      },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => true),
        updateModalScoreboardSnapshot: vi.fn(),
      },
    };

    await scoreboardEngineMethods.handleDailyChallengeVerificationResult.call(
      engine,
      entry,
      {
        ok: false,
        status: 400,
        body: { error: "Replay rejected" },
      },
    );

    expect(refreshAfterAcceptedSubmission).not.toHaveBeenCalled();
    expect(getDailyChallengeVerificationEntry(challengeId)).toMatchObject({
      verificationState: "error",
      submissionStage: "error",
    });
  });
});
