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
  });
});
