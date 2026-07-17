import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoreboardEngineMethods } from "../game/scoreboard/engine-methods.js";
import {
  enqueueDailyChallengeVerification,
  getDailyChallengeVerificationEntry,
  resetVerificationQueueForTests,
} from "../game/scoreboard/verification-queue.js";
import {
  getDailyChallengeData,
  saveDailyChallengeBestTime,
  setDailyChallengeBestTime,
} from "../game/daily-challenge/storage.js";
import { isNewBestResult } from "../game/race/result-flow.js";

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

  it("updates and refetches the lifetime track PB independently from the daily leaderboard", async () => {
    const challengeId = "daily-track-pb";
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 44,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const applyVerifiedTrackPersonalBest = vi.fn();
    const invalidate = vi.fn();
    const prepareTrackPersonalBestGhost = vi.fn().mockResolvedValue(null);
    const refreshAfterAcceptedSubmission = vi.fn();
    const engine = {
      trackPersonalBestResult: {
        trackKey: "circuit",
        bestTime: 45,
        checkpointTimesSec: [10, 20],
      },
      applyVerifiedTrackPersonalBest,
      prepareTrackPersonalBestGhost,
      pbGhostService: { invalidate },
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: {
        refreshDailyChallengeAfterAcceptedSubmission: refreshAfterAcceptedSubmission,
      },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => false),
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
          bestTimeMs: 44000,
          trackBestTimeMs: 44000,
          trackPbImproved: true,
          trackGhostAvailable: true,
          checkpointTimesSec: [9, 19],
        },
      },
    );

    expect(applyVerifiedTrackPersonalBest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: challengeId,
        trackKey: "circuit",
      }),
      {
        trackKey: "circuit",
        bestTimeMs: 44000,
        checkpointTimesSec: [9, 19],
        ghostAvailable: true,
      },
    );
    expect(invalidate).toHaveBeenCalledWith(challengeId);
    expect(prepareTrackPersonalBestGhost).toHaveBeenCalledWith(
      expect.objectContaining({ id: challengeId }),
      { forceRefresh: true },
    );
    expect(refreshAfterAcceptedSubmission).not.toHaveBeenCalled();
  });

  it("installs the accepted canonical track PB without a follow-up GET", async () => {
    const challengeId = "daily-canonical-track-pb";
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 42,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const canonical = {
      trackKey: "circuit",
      bestTimeMs: 42000,
      checkpointTimesSec: [9, 19],
      updatedAt: "2026-07-17T20:00:00.000Z",
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [100, 100, 0],
      },
    };
    const installCanonicalTrackPersonalBestGhost = vi.fn();
    const prepareTrackPersonalBestGhost = vi.fn();
    const invalidate = vi.fn();
    const resolveTrackPersonalBestGhostPending = vi.fn();
    const engine = {
      installCanonicalTrackPersonalBestGhost,
      prepareTrackPersonalBestGhost,
      resolveTrackPersonalBestGhostPending,
      pbGhostService: { invalidate },
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: { refreshDailyChallengeAfterAcceptedSubmission: vi.fn() },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => false),
        updateModalScoreboardSnapshot: vi.fn(),
      },
    };

    await scoreboardEngineMethods.handleDailyChallengeVerificationResult.call(engine, entry, {
      ok: true,
      status: 200,
      body: {
        accepted: true,
        improved: false,
        bestTimeMs: 42000,
        trackPbPersistenceStatus: "stored",
        trackPersonalBest: canonical,
      },
    });

    expect(installCanonicalTrackPersonalBestGhost).toHaveBeenCalledWith(
      expect.objectContaining({ id: challengeId, trackKey: "circuit" }),
      canonical,
    );
    expect(resolveTrackPersonalBestGhostPending).toHaveBeenCalledWith(challengeId);
    expect(invalidate).not.toHaveBeenCalled();
    expect(prepareTrackPersonalBestGhost).not.toHaveBeenCalled();
  });

  it("marks the previous ghost unavailable when PB persistence fails", async () => {
    const challengeId = "daily-pb-unavailable";
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 42,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const markTrackPersonalBestGhostUnavailable = vi.fn();
    const engine = {
      markTrackPersonalBestGhostUnavailable,
      resolveTrackPersonalBestGhostPending: vi.fn(),
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: { refreshDailyChallengeAfterAcceptedSubmission: vi.fn() },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => false),
        updateModalScoreboardSnapshot: vi.fn(),
      },
    };

    await scoreboardEngineMethods.handleDailyChallengeVerificationResult.call(engine, entry, {
      ok: true,
      status: 200,
      body: {
        accepted: true,
        improved: false,
        bestTimeMs: 42_000,
        trackPbPersistenceStatus: "unavailable",
        trackPersonalBest: null,
      },
    });

    expect(markTrackPersonalBestGhostUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ id: challengeId, trackKey: "circuit" }),
    );
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

  it("rolls back a matching local PB when ranking permanently fails", async () => {
    const challengeId = "daily-rollback";
    const challenge = {
      id: challengeId,
      challengeDate: "2026-04-14",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    setDailyChallengeBestTime(challenge, 12, 1);
    saveDailyChallengeBestTime(challenge, 10, 1);
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 10,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
      challengeDate: "2026-04-14",
      previousBestTime: 12,
      previousCompletedLaps: 1,
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const engine = {
      activeDailyChallenge: challenge,
      dailyChallengeBestResult: { bestTime: 10, completedLaps: 1 },
      bestLapTime: 10,
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: {
        refreshDailyChallengeAfterAcceptedSubmission: vi.fn(),
      },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => false),
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

    expect(getDailyChallengeData(challengeId)).toMatchObject({ bestTime: 12 });
    expect(engine.dailyChallengeBestResult).toMatchObject({ bestTime: 12 });
    expect(engine.bestLapTime).toBe(12);
    expect(isNewBestResult(
      { bestResultComparator: "time" },
      { bestTime: 11 },
      engine.dailyChallengeBestResult,
    )).toBe(true);
  });

  it("clears a stuck rejected local PB when no previous best exists", async () => {
    const challengeId = "daily-clear-stuck";
    const challenge = {
      id: challengeId,
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    setDailyChallengeBestTime(challenge, 10, 1);
    enqueueDailyChallengeVerification({
      challengeId,
      bestTime: 10,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });
    const entry = getDailyChallengeVerificationEntry(challengeId);
    const engine = {
      currentDailyChallenge: challenge,
      dailyChallengeBestResult: { bestTime: 10 },
      bestLapTime: 10,
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      leaderboards: {
        refreshDailyChallengeAfterAcceptedSubmission: vi.fn(),
      },
      modal: {
        matchesModalScoreboardContext: vi.fn(() => false),
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

    expect(getDailyChallengeData(challengeId)).toBe(null);
    expect(engine.dailyChallengeBestResult).toBe(null);
    expect(engine.bestLapTime).toBe(null);
    expect(isNewBestResult(
      { bestResultComparator: "time" },
      { bestTime: 11 },
      engine.dailyChallengeBestResult,
    )).toBe(true);
  });
});
