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

  it("keeps retryable submit failures queued instead of converting them to terminal errors", async () => {
    enqueueDailyChallengeVerification({
      challengeId: "daily-504",
      bestTime: 44,
      replay: REPLAY,
      objectiveType: "single_lap_fastest",
      trackKey: "circuit",
    });

    const entry = getDailyChallengeVerificationEntry("daily-504");
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
        status: 504,
        body: null,
      },
    );

    expect(getDailyChallengeVerificationEntry("daily-504")).toMatchObject({
      verificationState: "pending",
      submissionStage: "retrying",
    });
    expect(engine.dailyChallengeUi.refreshDailyChallengeVerificationState).toHaveBeenCalledWith(
      "daily-504",
    );
    expect(engine.modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationState: "pending",
        submissionStage: "retrying",
        isLoading: true,
      }),
    );
  });
});
