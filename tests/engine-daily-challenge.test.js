import { describe, expect, it, vi } from "vitest";
import { RealTimeRacer } from "../game/engine.js";
import { modeRouterEngineMethods } from "../game/modes/engine-methods.js";
import { CarSpriteLoader, getCarAssetUrlCandidates } from "../game/car/sprite.js";
import { readTrackLastLapMedal } from "../game/medals/last-lap-medal-storage.js";
import {
  enqueueDailyChallengeVerification,
  markDailyChallengeVerificationPending,
  resetVerificationQueueForTests,
} from "../game/scoreboard/verification-queue.js";

describe("RealTimeRacer daily challenge modal payload", () => {
  it("compares intermediate laps using cumulative elapsed pace at equivalent PB boundaries", () => {
    const showLapFlash = vi.fn();
    const engine = {
      currentChallengeRun: {
        completedLaps: 0,
        recentLaps: [],
        bestLap: null,
        requiredLaps: 3,
      },
      activeDailyChallenge: {
        id: "campaign-stage",
        trackKey: "circuit",
        objectiveType: "multi_lap_total",
        objectiveParams: { lapCount: 3 },
      },
      currentTrackKey: "circuit",
      activePersonalBestPaceBaseline: {
        finishTimeSec: 33,
        lapCompletionTimesSec: [11, 22, 33],
      },
      getActiveRacePaceBaseline:
        RealTimeRacer.prototype.getActiveRacePaceBaseline,
      hud: { showLapFlash },
      _resetLapTrailAfterIntermediateLap: vi.fn(),
      updateDailyChallengeHud: vi.fn(),
      requestRender: vi.fn(),
    };

    RealTimeRacer.prototype.handleDailyChallengeLapCompleted.call(engine, 10, {
      elapsedTimeSec: 10,
      completedLaps: 1,
      requiredLaps: 3,
      isFinalLap: false,
    });
    RealTimeRacer.prototype.handleDailyChallengeLapCompleted.call(engine, 12.5, {
      elapsedTimeSec: 22.5,
      completedLaps: 2,
      requiredLaps: 3,
      isFinalLap: false,
    });

    expect(showLapFlash).toHaveBeenNthCalledWith(1, expect.objectContaining({
      lapNumber: 1,
      elapsedTimeSec: 10,
      deltaVsBest: -1,
    }));
    expect(showLapFlash).toHaveBeenNthCalledWith(2, expect.objectContaining({
      lapNumber: 2,
      elapsedTimeSec: 22.5,
      deltaVsBest: 0.5,
    }));
  });

  it("does not flash a first-lap delta against the previous race total", () => {
    const showLapFlash = vi.fn();
    const engine = {
      currentChallengeRun: {
        completedLaps: 0,
        recentLaps: [],
        bestLap: null,
        requiredLaps: 2,
      },
      activeDailyChallenge: {
        id: "daily-two-lap",
        trackKey: "circuit",
        objectiveType: "multi_lap_total",
        objectiveParams: { lapCount: 2 },
      },
      currentTrackKey: "circuit",
      activePersonalBestPaceBaseline: {
        finishTimeSec: 33,
        lapCompletionTimesSec: [33],
      },
      getActiveRacePaceBaseline:
        RealTimeRacer.prototype.getActiveRacePaceBaseline,
      hud: { showLapFlash },
      _resetLapTrailAfterIntermediateLap: vi.fn(),
      updateDailyChallengeHud: vi.fn(),
      requestRender: vi.fn(),
    };

    RealTimeRacer.prototype.handleDailyChallengeLapCompleted.call(engine, 10, {
      elapsedTimeSec: 10,
      completedLaps: 1,
      requiredLaps: 2,
      isFinalLap: false,
    });

    expect(showLapFlash).toHaveBeenCalledWith(expect.objectContaining({
      lapNumber: 1,
      elapsedTimeSec: 10,
      deltaVsBest: null,
    }));
  });

  it("keeps the challenge date in the lobby summary for post-bound standings", () => {
    const setDailyChallengeSummary = vi.fn();
    const challenge = {
      id: "daily-gp-2026-07-10",
      trackKey: "circuit",
      challengeDate: "2026-07-10",
      startsAt: "2026-07-10T00:00:00.000Z",
      endsAt: "2026-07-11T00:00:00.000Z",
      objectiveType: "single_lap_fastest",
      skin: "default",
    };

    RealTimeRacer.prototype.setDailyChallengeLobbySummary.call({
      dailyChallengeUi: { setDailyChallengeSummary },
      dailyChallengeBestResult: null,
      bestLapTime: null,
      syncTrackMedalFromChallengeBest: vi.fn(),
    }, challenge);

    expect(setDailyChallengeSummary).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: challenge.id,
      challengeDate: challenge.challengeDate,
      startsAt: challenge.startsAt,
    }));
  });

  it("closes the main-menu garage when escape is pressed", () => {
    const setPanelVisible = vi.fn();
    const event = { key: "Escape", code: "Escape", preventDefault: vi.fn() };

    RealTimeRacer.prototype.handleKey.call(
      {
        status: "ready",
        startOverlay: { isStartOverlayVisible: () => true },
        garage: {
          isGarageOpen: () => true,
          setPanelVisible,
        },
        getSteeringDirection: () => null,
      },
      event,
      true,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(setPanelVisible).toHaveBeenCalledWith(false);
  });

  it("resumes from pause when escape is pressed", () => {
    const resumeActiveRun = vi.fn();
    const event = { key: "Escape", code: "Escape", preventDefault: vi.fn() };

    RealTimeRacer.prototype.handleKey.call(
      {
        status: "paused",
        modal: { isPauseModalActive: () => true },
        resumeActiveRun,
        getSteeringDirection: () => null,
      },
      event,
      true,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(resumeActiveRun).toHaveBeenCalled();
  });

  it("restarts the race when plain R is pressed while playing", () => {
    const restartDailyChallenge = vi.fn();
    const event = { key: "r", preventDefault: vi.fn() };

    RealTimeRacer.prototype.handleKey.call(
      {
        status: "playing",
        currentChallengeRun: { id: "run-1" },
        modal: { isModalActive: () => false },
        restartDailyChallenge,
        getSteeringDirection: () => null,
      },
      event,
      true,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(restartDailyChallenge).toHaveBeenCalled();
  });

  it("restarts the race when plain R is pressed while paused", () => {
    const restartDailyChallenge = vi.fn();
    const event = { key: "R", preventDefault: vi.fn() };

    RealTimeRacer.prototype.handleKey.call(
      {
        status: "paused",
        currentChallengeRun: { id: "run-1" },
        modal: {
          isModalActive: () => true,
          isStandaloneRunsViewActive: () => false,
        },
        restartDailyChallenge,
        getSteeringDirection: () => null,
      },
      event,
      true,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(restartDailyChallenge).toHaveBeenCalled();
  });

  it("restarts the race when plain R is pressed on the finish screen", () => {
    const restartDailyChallenge = vi.fn();
    const event = { key: "r", preventDefault: vi.fn() };

    RealTimeRacer.prototype.handleKey.call(
      {
        status: "won",
        currentChallengeRun: { id: "run-1" },
        modal: {
          isModalActive: () => true,
          isStandaloneRunsViewActive: () => false,
        },
        restartDailyChallenge,
        getSteeringDirection: () => null,
      },
      event,
      true,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(restartDailyChallenge).toHaveBeenCalled();
  });

  it.each([
    { label: "Ctrl", modifiers: { ctrlKey: true } },
    { label: "Meta", modifiers: { metaKey: true } },
    { label: "Alt", modifiers: { altKey: true } },
    { label: "Shift", modifiers: { shiftKey: true } },
  ])("does not restart when $label+R is pressed", ({ modifiers }) => {
    const restartDailyChallenge = vi.fn();
    const reset = vi.fn();
    const event = {
      key: "r",
      preventDefault: vi.fn(),
      ...modifiers,
    };

    RealTimeRacer.prototype.handleKey.call(
      {
        status: "playing",
        currentChallengeRun: { id: "run-1" },
        modal: { isModalActive: () => false },
        restartDailyChallenge,
        reset,
        getSteeringDirection: () => null,
      },
      event,
      true,
    );

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(restartDailyChallenge).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("shows race wording in the HUD for multi-lap daily challenges", () => {
    const setHudPrimaryMetric = vi.fn();
    const setBestTime = vi.fn();

    RealTimeRacer.prototype.syncChallengeHudPrimaryStats.call({
      activeDailyChallenge: { objectiveType: "multi_lap_total" },
      hud: {
        setHudPrimaryMetric,
        setBestTime,
      },
      bestLapTime: 48.35,
    });

    expect(setHudPrimaryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "RACE",
        useTimer: true,
        visible: true,
      }),
    );
    expect(setBestTime).toHaveBeenCalledWith(48.35, {
      persistToTrackCard: false,
    });
  });

  it("shows race wording in the pause modal for multi-lap daily challenges", () => {
    const showModal = vi.fn();
    const interaction = vi.fn();

    RealTimeRacer.prototype.pauseActiveRun.call({
      status: "playing",
      clearSteeringInput: vi.fn(),
      isDailyChallengeRun: () => true,
      bestLapTime: 48.35,
      currentTime: 50.1,
      currentTrackKey: "circuit",
      activeDailyChallenge: { objectiveType: "multi_lap_total", skin: "default", trackKey: "circuit" },
      getSelectedCarAssetName: () => "assets/cars/mr_mr_red.webp",
      modal: { showModal },
      journeys: { interaction },
      showPauseModal: RealTimeRacer.prototype.showPauseModal,
      resumeActiveRun: vi.fn(),
      reset: vi.fn(),
    });

    expect(showModal).toHaveBeenCalledWith(
      "PAUSED",
      null,
      expect.objectContaining({
        lapTime: 50.1,
        bestTime: 48.35,
        deltaToBest: 1.75,
        primaryStatLabel: "Race Time",
      }),
      expect.objectContaining({
        modalKind: "pause",
        pauseTrackPreview: expect.objectContaining({
          trackKey: "circuit",
          skin: "default",
          trackName: "Classic Circuit",
        }),
        settingsAction: expect.any(Function),
      }),
    );
    expect(interaction).toHaveBeenCalledWith("pause");
  });

  it("reports resume only after a paused run becomes playable again", () => {
    const interaction = vi.fn();
    const engine = {
      status: "paused",
      journeys: { interaction },
      carEffectsAudio: { prepareOnUserGesture: vi.fn() },
      medalEffectsAudio: { prepareOnUserGesture: vi.fn() },
      proceduralMusic: { prepareOnUserGesture: vi.fn() },
      runtimeConfig: { resumeRelaunchDelay: 0.2 },
      armRelaunchDelay: vi.fn(),
      getNow: vi.fn(() => 123),
      modal: { closeModal: vi.fn() },
      updateDailyChallengeHud: vi.fn(),
      requestRender: vi.fn(),
    };

    RealTimeRacer.prototype.resumeActiveRun.call(engine);

    expect(engine.status).toBe("playing");
    expect(interaction).toHaveBeenCalledWith("resume");
  });

  it("reports normalized checkpoint progress through Journeys", () => {
    const progressCheckpoint = vi.fn();
    const showCheckpointFlash = vi.fn();

    RealTimeRacer.prototype.handleCheckpointPassed.call({
      journeys: { progressCheckpoint },
      currentTrack: { checkpoints: [{}, {}, {}] },
      currentTrackKey: "circuit",
      activeDailyChallenge: null,
      sessionBestCheckpointTimesByTrackKey: Object.create(null),
      hud: { showCheckpointFlash },
    }, { index: 1, splitTimeSec: 4.2 });

    expect(progressCheckpoint).toHaveBeenCalledWith(1, 3);
    expect(showCheckpointFlash).toHaveBeenCalled();
  });

  it("ends rejected finishes as incomplete Journeys", () => {
    const endAttempt = vi.fn();
    const showModal = vi.fn();
    const engine = {
      status: "playing",
      journeys: { endAttempt },
      activeDailyChallenge: null,
      bestLapTime: null,
      currentTime: 12.3,
      hud: {
        setPauseVisible: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
      },
      modal: { showModal, modalMsg: null },
      restartDailyChallenge: vi.fn(),
      reset: vi.fn(),
      openDailyChallengePlaylist: vi.fn(),
    };

    RealTimeRacer.prototype.handleInvalidDailyChallengeWin.call(engine, "invalid");

    expect(engine.status).toBe("ready");
    expect(endAttempt).toHaveBeenCalledWith({ complete: false });
    expect(showModal).toHaveBeenCalled();
  });

  it("keeps leaderboard-open enabled and returns completed runs through the Daily selector", () => {
    const showModal = vi.fn();
    const endAttempt = vi.fn();
    const returnToActiveLobby = vi.fn();

    RealTimeRacer.prototype.handleDailyChallengeWin.call(
      {
        isValidatedWinData: () => true,
        currentChallengeRun: { completedLaps: 2 },
        activeDailyChallenge: {
          id: "daily-1",
          trackKey: "circuit",
          objectiveType: "multi_lap_total",
        },
        status: "playing",
        journeys: { endAttempt },
        currentRunPolicy: { bestResultComparator: "time" },
        dailyChallengeBestResult: null,
        bestLapTime: null,
        cachedSpeed: 0,
        hud: {
          syncHud: vi.fn(),
          setBestTime: vi.fn(),
          setHudPersonalBestsOpenAllowed: vi.fn(),
        },
        dailyChallengeUi: {
          getDailyChallengeScoreboardSnapshot: vi.fn(() => null),
        },
        modal: {
          showModal,
          modalMsg: null,
        },
        restartDailyChallenge: vi.fn(),
        reset: vi.fn(),
        returnToActiveLobby,
        enqueueDailyChallengeVerificationSubmission: vi.fn(),
        scoreboardReplay: { getPayload: vi.fn(() => ({ inputs: [] })) },
      },
      {
        lapTime: 44.12,
        completedLaps: 2,
      },
    );

    expect(showModal).toHaveBeenCalled();
    expect(showModal.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        scoreboardChallengeId: "daily-1",
        allowLeaderboardOpen: true,
      }),
    );
    expect(showModal.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        shareRequest: {
          source: "finish",
          challengeId: "daily-1",
          replay: { inputs: [] },
        },
      }),
    );
    expect(showModal.mock.calls[0][3]).not.toHaveProperty("playlistAction");
    showModal.mock.calls[0][3].secondaryAction();
    expect(returnToActiveLobby).toHaveBeenCalledTimes(1);
    expect(endAttempt).toHaveBeenCalledWith({ complete: true });
  });

  it("starts Improve without the beaten ghost after taking first", () => {
    const showModal = vi.fn();
    const handleStartDailyChallenge = vi.fn();
    const restartDailyChallenge = vi.fn();
    const challenge = {
      id: "daily-1",
      trackKey: "circuit",
      objectiveType: "fastest_lap",
    };

    RealTimeRacer.prototype.handleDailyChallengeWin.call(
      {
        isValidatedWinData: () => true,
        currentChallengeRun: { completedLaps: 1 },
        activeDailyChallenge: challenge,
        status: "playing",
        journeys: { endAttempt: vi.fn() },
        currentRunPolicy: { bestResultComparator: "time" },
        dailyChallengeBestResult: null,
        bestLapTime: 9.3,
        cachedSpeed: 0,
        hud: {
          syncHud: vi.fn(),
          setBestTime: vi.fn(),
          setHudPersonalBestsOpenAllowed: vi.fn(),
        },
        dailyChallengeUi: {
          getDailyChallengeScoreboardSnapshot: vi.fn(() => null),
        },
        modal: { showModal, modalMsg: null },
        getRaceComparisonResult: () => ({
          outcome: "won",
          deltaSec: -0.061,
          target: { displayName: "Rival", rank: 1, finishTimeSec: 9.361 },
        }),
        handleStartDailyChallenge,
        restartDailyChallenge,
        returnToActiveLobby: vi.fn(),
        enqueueDailyChallengeVerificationSubmission: vi.fn(),
        scoreboardReplay: { getPayload: vi.fn(() => ({ inputs: [] })) },
      },
      {
        lapTime: 9.3,
        completedLaps: 1,
      },
    );

    showModal.mock.calls[0][3].restartAction();
    expect(handleStartDailyChallenge).toHaveBeenCalledWith(challenge);
    expect(restartDailyChallenge).not.toHaveBeenCalled();
  });

  it("does not compare a first multi-lap race total against lap one", () => {
    const showModal = vi.fn();
    const engine = {
      isValidatedWinData: () => true,
      currentChallengeRun: {
        completedLaps: 2,
        recentLaps: [{ lapNumber: 1, time: 9.764 }, { lapNumber: 2, time: 9.062 }],
        bestLapSecBeforeLastLap: 9.764,
      },
      activeDailyChallenge: {
        id: "daily-first-multi-lap",
        trackKey: "circuit",
        objectiveType: "multi_lap_total",
        objectiveParams: { lapCount: 2 },
      },
      status: "playing",
      journeys: { endAttempt: vi.fn() },
      currentRunPolicy: { bestResultComparator: "time" },
      dailyChallengeBestResult: null,
      trackPersonalBestResult: null,
      bestLapTime: 9.062,
      cachedSpeed: 0,
      sessionBestLapSecByTrackKey: {},
      sessionBestCheckpointTimesByTrackKey: {},
      hud: {
        syncHud: vi.fn(),
        setBestTime: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
      },
      dailyChallengeUi: {
        getDailyChallengeScoreboardSnapshot: vi.fn(() => null),
      },
      modal: { showModal, modalMsg: null },
      restartDailyChallenge: vi.fn(),
      returnToActiveLobby: vi.fn(),
      enqueueDailyChallengeVerificationSubmission: vi.fn(),
      scoreboardReplay: { getPayload: vi.fn(() => ({ inputs: [] })) },
    };

    RealTimeRacer.prototype.handleDailyChallengeWin.call(engine, {
      lapTime: 18.826,
      completedLaps: 2,
    });

    expect(showModal.mock.calls[0][2]).toEqual(expect.objectContaining({
      lapTime: 18.826,
      primaryStatLabel: "Race Time",
      previousPersonalBestSec: undefined,
      deltaToPersonalBest: undefined,
    }));
  });

  it("compares a multi-lap total against an earlier session race total", () => {
    const showModal = vi.fn();
    const engine = {
      isValidatedWinData: () => true,
      currentChallengeRun: {
        completedLaps: 2,
        recentLaps: [{ lapNumber: 1, time: 9.764 }, { lapNumber: 2, time: 9.062 }],
        bestLapSecBeforeLastLap: 9.764,
      },
      activeDailyChallenge: {
        id: "daily-repeat-multi-lap",
        trackKey: "circuit",
        objectiveType: "multi_lap_total",
        objectiveParams: { lapCount: 2 },
      },
      status: "playing",
      journeys: { endAttempt: vi.fn() },
      currentRunPolicy: { bestResultComparator: "time" },
      dailyChallengeBestResult: null,
      trackPersonalBestResult: null,
      bestLapTime: 9.062,
      cachedSpeed: 0,
      sessionBestLapSecByTrackKey: { "daily-repeat-multi-lap": 19.5 },
      sessionBestCheckpointTimesByTrackKey: {},
      hud: {
        syncHud: vi.fn(),
        setBestTime: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
      },
      dailyChallengeUi: {
        getDailyChallengeScoreboardSnapshot: vi.fn(() => null),
      },
      modal: { showModal, modalMsg: null },
      restartDailyChallenge: vi.fn(),
      returnToActiveLobby: vi.fn(),
      enqueueDailyChallengeVerificationSubmission: vi.fn(),
      scoreboardReplay: { getPayload: vi.fn(() => ({ inputs: [] })) },
    };

    RealTimeRacer.prototype.handleDailyChallengeWin.call(engine, {
      lapTime: 18.826,
      completedLaps: 2,
    });

    expect(showModal.mock.calls[0][2].previousPersonalBestSec).toBe(19.5);
    expect(showModal.mock.calls[0][2].deltaToPersonalBest).toBeCloseTo(-0.674);
  });

  it("syncs Verifying status from the queue after the finish modal opens", () => {
    const store = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => {
          store.set(key, String(value));
        },
        removeItem: (key) => {
          store.delete(key);
        },
      },
    };

    const showModal = vi.fn();
    const updateModalScoreboardSnapshot = vi.fn();
    const engine = {
      isValidatedWinData: () => true,
      currentChallengeRun: { completedLaps: 1, recentLaps: [], bestLapSecBeforeLastLap: null },
      activeDailyChallenge: {
        id: "daily-post-open-sync",
        trackKey: "circuit",
        objectiveType: "single_lap_fastest",
        challengeDate: "2026-07-19",
        availableUntil: "2099-01-01T00:00:00.000Z",
      },
      status: "playing",
      journeys: { endAttempt: vi.fn() },
      currentRunPolicy: { bestResultComparator: "time" },
      dailyChallengeBestResult: null,
      trackPersonalBestResult: null,
      bestLapTime: null,
      cachedSpeed: 0,
      rankedSubmissionBlockedReason: null,
      hasTrackMedalBeforeLastLapWrite: false,
      trackMedalBeforeLastLapWrite: null,
      sessionBestLapSecByTrackKey: {},
      sessionBestCheckpointTimesByTrackKey: {},
      hud: {
        syncHud: vi.fn(),
        setBestTime: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
      },
      dailyChallengeUi: {
        getDailyChallengeScoreboardSnapshot: vi.fn(() => null),
        refreshDailyChallengeVerificationState: vi.fn(),
      },
      modal: {
        showModal,
        updateModalScoreboardSnapshot,
        modalMsg: null,
      },
      restartDailyChallenge: vi.fn(),
      reset: vi.fn(),
      scoreboardReplay: { getPayload: vi.fn(() => ({ inputs: [] })), overflowed: false },
      enqueueDailyChallengeVerificationSubmission: vi.fn(() => {
        enqueueDailyChallengeVerification({
          challengeId: "daily-post-open-sync",
          bestTime: 11.2,
          replay: { inputs: [] },
          objectiveType: "single_lap_fastest",
          trackKey: "circuit",
          challengeDate: "2026-07-19",
          expiresAt: "2099-01-01T06:00:00.000Z",
        });
        markDailyChallengeVerificationPending("daily-post-open-sync", Date.now(), {
          submissionStage: "verifying",
          preserveUpdatedAt: true,
        });
        return true;
      }),
    };

    resetVerificationQueueForTests();
    RealTimeRacer.prototype.handleDailyChallengeWin.call(engine, {
      lapTime: 11.2,
      completedLaps: 1,
    });

    expect(showModal).toHaveBeenCalled();
    expect(updateModalScoreboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        isLoading: true,
        submissionStage: "verifying",
        statusText: "Verifying...",
      }),
    );

    resetVerificationQueueForTests();
    delete globalThis.window;
  });

  it("passes the pre-lap track medal into the win modal after lap storage updates", () => {
    const store = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => {
          store.set(key, String(value));
        },
        removeItem: (key) => {
          store.delete(key);
        },
      },
    };

    const showModal = vi.fn();
    const engine = {
      currentChallengeRun: { completedLaps: 0, recentLaps: [], bestLap: null },
      activeDailyChallenge: {
        id: "daily-1",
        trackKey: "circuit",
        objectiveType: "single_lap_fastest",
      },
      currentTrackKey: "circuit",
      trackMedalBeforeLastLapWrite: null,
      hasTrackMedalBeforeLastLapWrite: false,
      _resetLapTrailAfterIntermediateLap: vi.fn(),
      updateDailyChallengeHud: vi.fn(),
      requestRender: vi.fn(),
      hud: {
        showLapFlash: vi.fn(),
        syncHud: vi.fn(),
        setBestTime: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
      },
      isValidatedWinData: () => true,
      currentRunPolicy: { bestResultComparator: "time" },
      dailyChallengeBestResult: null,
      bestLapTime: null,
      cachedSpeed: 0,
      dailyChallengeUi: {
        getDailyChallengeScoreboardSnapshot: vi.fn(() => null),
      },
      modal: { showModal, modalMsg: null },
      restartDailyChallenge: vi.fn(),
      reset: vi.fn(),
      enqueueDailyChallengeVerificationSubmission: vi.fn(),
      scoreboardReplay: { getPayload: vi.fn(() => ({ inputs: [] })) },
    };

    RealTimeRacer.prototype.handleDailyChallengeLapCompleted.call(engine, 5.1, {
      elapsedTimeSec: 5.1,
      completedLaps: 1,
      requiredLaps: 1,
      isFinalLap: true,
    });

    expect(engine.hasTrackMedalBeforeLastLapWrite).toBe(false);
    expect(engine.trackMedalBeforeLastLapWrite).toBe(null);

    RealTimeRacer.prototype.handleDailyChallengeWin.call(engine, {
      lapTime: 5.1,
      completedLaps: 1,
    });

    expect(showModal).toHaveBeenCalled();
    expect(showModal.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        previousTrackMedal: null,
        lapMedal: "gold",
      }),
    );

    delete globalThis.window;
  });

  it("restores earned track medals from a loaded daily best time", () => {
    const store = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => {
          store.set(key, String(value));
        },
        removeItem: (key) => {
          store.delete(key);
        },
      },
    };

    const restored = RealTimeRacer.prototype.syncTrackMedalFromChallengeBest.call(
      {},
      { id: "daily-1", trackKey: "circuit", objectiveType: "single_lap_fastest" },
      5.1,
    );

    expect(restored).toBe("gold");
    expect(readTrackLastLapMedal("circuit")).toBe("gold");

    delete globalThis.window;
  });

  it("retries a completed daily run without falling back to the regular reset path", () => {
    const reset = vi.fn();
    const endAttempt = vi.fn();
    const startAttempt = vi.fn();

    RealTimeRacer.prototype.restartDailyChallenge.call({
      activeDailyChallenge: {
        id: "daily-1",
        trackKey: "harborParkLoop",
        physicsOverrides: {
          accel: 58,
          brakePower: 90,
          maxSpeed: 320,
          turnRate: 5.75,
          grip: 2.5,
        },
      },
      journeys: { endAttempt, startAttempt },
      reset,
    });

    expect(reset).toHaveBeenCalledWith(true, {
      preserveDailyChallenge: true,
      preserveRaceComparisonTarget: true,
    });
    expect(endAttempt).toHaveBeenCalledWith({ complete: false });
    expect(startAttempt).toHaveBeenCalledWith({ mode: "daily", reason: "restart" });
  });

  it("passes improve intent when restarting from the win screen", () => {
    const reset = vi.fn();
    const endAttempt = vi.fn();
    const startAttempt = vi.fn();

    RealTimeRacer.prototype.restartDailyChallenge.call(
      {
        activeDailyChallenge: { id: "daily-1", trackKey: "harborParkLoop" },
        journeys: { endAttempt, startAttempt },
        reset,
      },
      { reason: "improve" },
    );

    expect(startAttempt).toHaveBeenCalledWith({ mode: "daily", reason: "improve" });
    expect(reset).toHaveBeenCalledWith(true, {
      preserveDailyChallenge: true,
      preserveRaceComparisonTarget: false,
    });
  });

  it("clears daily challenge race context when leaving a challenge run", () => {
    const engine = {
      currentDailyChallenge: { id: "daily-today", trackKey: "circuit" },
      activeDailyChallenge: { id: "daily-today", trackKey: "circuit" },
      lastPlayedDailyChallenge: { id: "daily-playlist", trackKey: "harborParkLoop" },
      currentChallengeRun: { challengeId: "daily-today", trackKey: "circuit" },
      syncCurrentRunPolicy: vi.fn(),
      setRuntimeConfig: vi.fn(),
      setDailyChallengeLobbySummary: vi.fn(),
      hud: {
        setHudPrimaryMetric: vi.fn(),
        setHudBestMetric: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
      },
      updateDailyChallengeHud: vi.fn(),
    };

    RealTimeRacer.prototype.clearDailyChallengeRun.call(engine);

    expect(engine.currentChallengeRun).toBe(null);
    expect(engine.activeDailyChallenge).toBe(null);
    expect(engine.lastPlayedDailyChallenge).toEqual({
      id: "daily-playlist",
      trackKey: "harborParkLoop",
    });
    expect(engine.setDailyChallengeLobbySummary).toHaveBeenCalledWith({
      id: "daily-playlist",
      trackKey: "harborParkLoop",
    });
  });

  it("remembers the last playlist challenge and resumes it from home Start", async () => {
    const featured = {
      id: "daily-today",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    const playlistChallenge = {
      id: "daily-playlist",
      trackKey: "harborParkLoop",
      objectiveType: "single_lap_fastest",
    };
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: featured,
      activeDailyChallenge: null,
      lastPlayedDailyChallenge: null,
      currentTrackKey: "circuit",
      trackCanvas: {},
      startOverlay: { hideStartOverlay: vi.fn() },
      loadTrack: vi.fn(async function loadTrack(trackKey) {
        this.currentTrackKey = trackKey;
      }),
      applyDailyChallenge: vi.fn(),
      startSequence: vi.fn(),
      journeys: { startAttempt: vi.fn() },
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, playlistChallenge);

    expect(engine.lastPlayedDailyChallenge).toBe(playlistChallenge);
    expect(engine.applyDailyChallenge).toHaveBeenCalledWith(playlistChallenge);

    engine.activeDailyChallenge = null;
    engine.applyDailyChallenge.mockClear();
    engine.startSequence.mockClear();
    engine.loadTrack.mockClear();
    engine.journeys.startAttempt.mockClear();

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, null);

    expect(engine.applyDailyChallenge).toHaveBeenCalledWith(playlistChallenge);
    expect(engine.applyDailyChallenge).not.toHaveBeenCalledWith(featured);
    expect(engine.loadTrack).not.toHaveBeenCalled();
    expect(engine.startSequence).toHaveBeenCalled();
  });

  it("routes a Daily finish correctly after starting from Campaign in Tracks", async () => {
    const challenge = {
      id: "daily-from-campaign",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    const engine = {
      status: "ready",
      startButtonPending: false,
      activeRaceMode: "campaign",
      activeCampaignStage: { raceId: "numbered-v1-00" },
      activeHeadToHead: { challengeId: "previous-challenge" },
      currentTrackKey: "numberZero",
      trackCanvas: {},
      startOverlay: { hideStartOverlay: vi.fn() },
      loadTrack: vi.fn(),
      applyDailyChallenge: vi.fn(),
      startSequence: vi.fn(),
      journeys: { startAttempt: vi.fn() },
      handleDailyChallengeWin: vi.fn(),
      handleCampaignWin: vi.fn(),
      handleHeadToHeadWin: vi.fn(),
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);
    const result = { lapTime: 8.25 };
    modeRouterEngineMethods.handleActiveRaceWin.call(engine, result);

    expect(engine.startSequence).toHaveBeenCalledTimes(1);
    expect(engine.handleDailyChallengeWin).toHaveBeenCalledWith(result);
    expect(engine.handleCampaignWin).not.toHaveBeenCalled();
    expect(engine.handleHeadToHeadWin).not.toHaveBeenCalled();
    expect(engine.activeRaceMode).toBe("daily");
    expect(engine.activeCampaignStage).toBeNull();
    expect(engine.activeHeadToHead).toBeNull();
  });

  it("rebuilds a missing Daily canvas when the challenge track key is unchanged", async () => {
    const challenge = {
      id: "daily-missing-canvas",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: challenge,
      activeDailyChallenge: null,
      currentTrackKey: challenge.trackKey,
      trackCanvas: null,
      startOverlay: { hideStartOverlay: vi.fn() },
      loadTrack: vi.fn(),
      applyDailyChallenge: vi.fn(),
      startSequence: vi.fn(),
      journeys: { startAttempt: vi.fn() },
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(engine.loadTrack).toHaveBeenCalledWith(challenge.trackKey, {
      loadPlayerProgress: false,
      preserveDailyChallengeContext: true,
      preserveRaceComparisonTarget: false,
      showStartOverlayOnReset: false,
      keepScreen: true,
      prepared: null,
      loadedOnly: true,
      challenge,
    });
    expect(engine.startSequence).toHaveBeenCalledTimes(1);
  });

  it("restores Daily with Retry Start when the selected track cannot load", async () => {
    const challenge = {
      id: "daily-track-failed",
      trackKey: "blueSector",
      objectiveType: "single_lap_fastest",
    };
    const showDailyLobby = vi.fn();
    const setRaceStartError = vi.fn();
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: challenge,
      activeDailyChallenge: null,
      currentTrackKey: "circuit",
      trackCanvas: {},
      startOverlay: { beginRaceStartTransition: vi.fn(() => Promise.resolve()) },
      lobbyUi: {
        clearRaceStartError: vi.fn(),
        setRaceStartError,
      },
      loadTrack: vi.fn().mockRejectedValue(new Error("track chunk failed")),
      showDailyLobby,
      applyDailyChallenge: vi.fn(),
      startSequence: vi.fn(),
      journeys: { startAttempt: vi.fn() },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(showDailyLobby).toHaveBeenCalledWith({ selectChallengeId: challenge.id });
    expect(setRaceStartError).toHaveBeenCalledWith(
      "daily",
      "Track failed to load. Tap Retry Start.",
    );
    expect(engine.applyDailyChallenge).not.toHaveBeenCalled();
    expect(engine.startSequence).not.toHaveBeenCalled();
    expect(engine.startButtonPending).toBe(false);
  });

  it("waits for the Daily lobby exit before starting the countdown", async () => {
    const challenge = {
      id: "daily-transition",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    let finishTransition;
    const raceStartTransition = new Promise((resolve) => {
      finishTransition = resolve;
    });
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: challenge,
      activeDailyChallenge: null,
      currentTrackKey: challenge.trackKey,
      trackCanvas: {},
      startOverlay: {
        beginRaceStartTransition: vi.fn(() => raceStartTransition),
      },
      applyDailyChallenge: vi.fn(),
      startSequence: vi.fn(),
      journeys: { startAttempt: vi.fn() },
    };

    const start = RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);
    await Promise.resolve();

    expect(engine.startOverlay.beginRaceStartTransition).toHaveBeenCalledTimes(1);
    expect(engine.startSequence).not.toHaveBeenCalled();

    finishTransition();
    await start;

    expect(engine.startSequence).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue verification when the active track does not match the challenge", () => {
    const engine = {
      currentTrackKey: "blueSector",
      currentChallengeRun: { challengeId: "daily-1", trackKey: "blueSector" },
      dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
      scheduleVerificationQueueProcessing: vi.fn(),
    };

    const enqueued = RealTimeRacer.prototype.enqueueDailyChallengeVerificationSubmission.call(engine, {
      challenge: { id: "daily-1", trackKey: "circuit", objectiveType: "single_lap_fastest" },
      bestTime: 10,
      completedLaps: 1,
      replay: { inputs: [{ frames: 600, left: false, right: false, relaunchDelay: false }] },
    });

    expect(enqueued).toBe(false);
    expect(engine.dailyChallengeUi.refreshDailyChallengeVerificationState).not.toHaveBeenCalled();
    expect(engine.scheduleVerificationQueueProcessing).not.toHaveBeenCalled();
  });

  it("starts verification processing synchronously when the finish is queued", () => {
    const store = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => {
          store.set(key, String(value));
        },
        removeItem: (key) => {
          store.delete(key);
        },
      },
    };
    const callOrder = [];
    const engine = {
      currentTrackKey: "circuit",
      currentChallengeRun: { challengeId: "daily-1", trackKey: "circuit" },
      dailyChallengeUi: {
        refreshDailyChallengeVerificationState: vi.fn(() => callOrder.push("refresh")),
      },
      markTrackPersonalBestGhostPending: vi.fn(() => callOrder.push("mark-pending")),
      processVerificationQueue: vi.fn(() => {
        callOrder.push("submit-started");
        return Promise.resolve();
      }),
      scheduleVerificationQueueProcessing: vi.fn(),
    };

    expect(RealTimeRacer.prototype.enqueueDailyChallengeVerificationSubmission.call(engine, {
      challenge: { id: "daily-1", trackKey: "circuit", objectiveType: "single_lap_fastest" },
      bestTime: 10,
      completedLaps: 1,
      replay: { inputs: [{ frames: 600, left: false, right: false }] },
      isTrackPbCandidate: true,
    })).toBe(true);

    expect(callOrder).toEqual(["mark-pending", "refresh", "submit-started"]);
    expect(engine.scheduleVerificationQueueProcessing).not.toHaveBeenCalled();
  });

  it("starts a playlist-selected daily challenge from an active result modal", async () => {
    const challenge = {
      id: "daily-1",
      trackKey: "harborParkLoop",
      objectiveType: "single_lap_fastest",
    };
    const engine = {
      status: "won",
      startButtonPending: false,
      currentDailyChallenge: null,
      activeDailyChallenge: { id: "previous", trackKey: "harborParkLoop" },
      currentTrackKey: "harborParkLoop",
      startOverlay: { hideStartOverlay: vi.fn() },
      reset: vi.fn(function reset() {
        this.status = "ready";
      }),
      loadTrack: vi.fn(),
      applyDailyChallenge: vi.fn(),
      journeys: { startAttempt: vi.fn() },
      startSequence: vi.fn(function startSequence() {
        if (this.status === "ready") {
          this.status = "starting";
        }
      }),
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(engine.startOverlay.hideStartOverlay).toHaveBeenCalled();
    expect(engine.reset).toHaveBeenCalledWith(false, {
      showStartOverlay: false,
      keepScreen: true,
    });
    expect(engine.applyDailyChallenge).toHaveBeenCalledWith(challenge);
    expect(engine.startSequence).toHaveBeenCalled();
    expect(engine.journeys.startAttempt).toHaveBeenCalledWith({
      mode: "daily",
      reason: "track_switch",
      replaceActive: false,
    });
    expect(engine.status).toBe("starting");
  });

  it("does not block playlist-selected track switches on player bootstrap", async () => {
    const challenge = {
      id: "daily-2",
      trackKey: "blueSector",
      objectiveType: "single_lap_fastest",
    };
    const engine = {
      status: "won",
      startButtonPending: false,
      currentDailyChallenge: null,
      activeDailyChallenge: { id: "previous", trackKey: "harborParkLoop" },
      currentTrackKey: "harborParkLoop",
      startOverlay: { hideStartOverlay: vi.fn() },
      reset: vi.fn(),
      loadTrack: vi.fn(async function loadTrack(trackKey) {
        this.currentTrackKey = trackKey;
        this.status = "ready";
      }),
      applyDailyChallenge: vi.fn(),
      trackModeStart: vi.fn(),
      startSequence: vi.fn(),
      journeys: { startAttempt: vi.fn() },
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(engine.loadTrack).toHaveBeenCalledWith("blueSector", {
      loadPlayerProgress: false,
      preserveDailyChallengeContext: true,
      preserveRaceComparisonTarget: false,
      showStartOverlayOnReset: false,
      keepScreen: true,
      prepared: null,
      loadedOnly: true,
      challenge,
    });
    expect(engine.applyDailyChallenge).toHaveBeenCalledWith(challenge);
    expect(engine.startSequence).toHaveBeenCalled();
    expect(engine.journeys.startAttempt).toHaveBeenCalledWith({
      mode: "daily",
      reason: "track_switch",
      replaceActive: true,
    });
  });

  it("does not wait for the PB ghost request before starting a playlist track", async () => {
    const challenge = {
      id: "daily-ghost-pending",
      trackKey: "blueSector",
      objectiveType: "single_lap_fastest",
    };
    let resolveGhost;
    const ghostRequest = new Promise((resolve) => {
      resolveGhost = resolve;
    });
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: null,
      activeDailyChallenge: null,
      currentTrackKey: "blueSector",
      trackCanvas: {},
      startOverlay: { hideStartOverlay: vi.fn() },
      applyDailyChallenge: vi.fn(),
      trackModeStart: vi.fn(),
      startSequence: vi.fn(),
      pbGhost: { clearTrack: vi.fn() },
      prepareTrackPersonalBestGhost: vi.fn(() => ghostRequest),
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(engine.startSequence).toHaveBeenCalled();
    expect(engine.startButtonPending).toBe(false);
    expect(engine.prepareTrackPersonalBestGhost).toHaveBeenCalledWith(challenge);
    resolveGhost(null);
    await ghostRequest;
  });

  it("does not reuse a prepared ghost while a local track PB candidate is pending", async () => {
    const challenge = {
      id: "daily-pending-pb",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    const clearPrepared = vi.fn();
    const prepareTrackPersonalBestGhost = vi.fn();
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: challenge,
      activeDailyChallenge: null,
      currentTrackKey: challenge.trackKey,
      trackCanvas: {},
      preparedPbGhostChallengeId: challenge.id,
      pendingPbGhostCandidateChallengeIds: new Set([challenge.id]),
      startOverlay: { hideStartOverlay: vi.fn() },
      applyDailyChallenge: vi.fn(),
      trackModeStart: vi.fn(),
      startSequence: vi.fn(),
      pbGhost: { clearPrepared },
      prepareTrackPersonalBestGhost,
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(clearPrepared).toHaveBeenCalledTimes(1);
    expect(prepareTrackPersonalBestGhost).not.toHaveBeenCalled();
    expect(engine.preparedPbGhostChallengeId).toBe(null);
    expect(engine.startSequence).toHaveBeenCalled();
  });

  it("does not issue a fallback GET for the immediate attempt after PB persistence is unavailable", async () => {
    const challenge = {
      id: "daily-unavailable-pb",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    const clearPrepared = vi.fn();
    const prepareTrackPersonalBestGhost = vi.fn();
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: challenge,
      activeDailyChallenge: null,
      currentTrackKey: challenge.trackKey,
      trackCanvas: {},
      preparedPbGhostChallengeId: null,
      pendingPbGhostCandidateChallengeIds: new Set(),
      unavailablePbGhostChallengeIds: new Set([challenge.id]),
      pbGhostSelectionChallengeId: challenge.id,
      pbGhostSelectionGeneration: 1,
      startOverlay: { hideStartOverlay: vi.fn() },
      applyDailyChallenge: vi.fn(),
      trackModeStart: vi.fn(),
      startSequence: vi.fn(),
      pbGhost: { clearPrepared },
      prepareTrackPersonalBestGhost,
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(clearPrepared).toHaveBeenCalledTimes(1);
    expect(prepareTrackPersonalBestGhost).not.toHaveBeenCalled();
    expect(engine.startSequence).toHaveBeenCalled();
  });

  it("does not let late or superseded ghost requests prepare the wrong selection", async () => {
    const challenge = { id: "daily-a", trackKey: "circuit" };
    let resolveFirst;
    let resolveSecond;
    const requests = [
      new Promise((resolve) => { resolveFirst = resolve; }),
      new Promise((resolve) => { resolveSecond = resolve; }),
    ];
    const prepare = vi.fn();
    const engine = {
      activeDailyChallenge: challenge,
      currentDailyChallenge: challenge,
      trackPersonalBestByTrackKey: Object.create(null),
      sessionBestLapSecByTrackKey: Object.create(null),
      sessionBestCheckpointTimesByTrackKey: Object.create(null),
      pbGhost: { prepare, clearTrack: vi.fn() },
      pbGhostService: { getForChallenge: vi.fn(() => requests.shift()) },
    };

    const first = RealTimeRacer.prototype.prepareTrackPersonalBestGhost.call(engine, challenge);
    const second = RealTimeRacer.prototype.prepareTrackPersonalBestGhost.call(engine, challenge);
    const newerRecord = {
      trackKey: "circuit",
      bestTimeMs: 900,
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [100, 0, 0],
      },
    };
    resolveSecond(newerRecord);
    await second;
    resolveFirst({
      trackKey: "circuit",
      bestTimeMs: 1000,
      ghost: {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [100, 0, 0],
      },
    });
    await first;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(newerRecord);

    let resolveLate;
    engine.pbGhostService.getForChallenge.mockReturnValueOnce(
      new Promise((resolve) => { resolveLate = resolve; }),
    );
    const late = RealTimeRacer.prototype.prepareTrackPersonalBestGhost.call(engine, challenge);
    engine.pbGhostSelectionChallengeId = "daily-b";
    engine.pbGhostSelectionGeneration += 1;
    engine.activeDailyChallenge = { id: "daily-b", trackKey: "blueSector" };
    resolveLate(newerRecord);
    await late;
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("reuses the ghost prepared during startup on the first play", async () => {
    const challenge = {
      id: "daily-gp-2026-07-17",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    const engine = {
      status: "ready",
      startButtonPending: false,
      currentDailyChallenge: challenge,
      activeDailyChallenge: null,
      currentTrackKey: challenge.trackKey,
      trackCanvas: {},
      preparedPbGhostChallengeId: challenge.id,
      startOverlay: { hideStartOverlay: vi.fn() },
      applyDailyChallenge: vi.fn(),
      trackModeStart: vi.fn(),
      startSequence: vi.fn(),
      pbGhost: {
        preparedRecord: { samples: [{}, {}] },
        clearTrack: vi.fn(),
      },
      prepareTrackPersonalBestGhost: vi.fn(),
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(engine.pbGhost.clearTrack).not.toHaveBeenCalled();
    expect(engine.prepareTrackPersonalBestGhost).not.toHaveBeenCalled();
    expect(engine.startSequence).toHaveBeenCalled();
  });

  it("loads the resolved valid post ghost as part of initial race assets", async () => {
    const challenge = {
      id: "daily-gp-2026-07-14",
      trackKey: "blueSector",
      objectiveType: "single_lap_fastest",
    };
    const engine = {
      playerHistoryPromise: Promise.resolve({ isReturningPlayer: true }),
      dailyChallengePromise: Promise.resolve(challenge),
      setLoadingStatus: vi.fn(),
      prepareTrackPersonalBestGhost: vi.fn().mockResolvedValue({
        trackKey: challenge.trackKey,
      }),
    };

    await expect(
      RealTimeRacer.prototype.loadInitialPersonalBestGhostAsset.call(engine),
    ).resolves.toEqual({ trackKey: challenge.trackKey });

    expect(engine.prepareTrackPersonalBestGhost).toHaveBeenCalledWith(challenge);
  });

  it("loads today's resolved ghost when an expired post falls back to today", async () => {
    const featuredChallenge = {
      id: "daily-gp-2026-07-17",
      trackKey: "circuit",
      objectiveType: "single_lap_fastest",
    };
    let resolveProfile;
    const engine = {
      playerHistoryPromise: new Promise((resolve) => {
        resolveProfile = resolve;
      }),
      dailyChallengePromise: Promise.resolve(featuredChallenge),
      setLoadingStatus: vi.fn(),
      prepareTrackPersonalBestGhost: vi.fn().mockResolvedValue(null),
    };

    const assetPromise = RealTimeRacer.prototype.loadInitialPersonalBestGhostAsset.call(
      engine,
    );
    await Promise.resolve();
    expect(engine.prepareTrackPersonalBestGhost).not.toHaveBeenCalled();

    resolveProfile({ isReturningPlayer: false });
    await assetPromise;

    expect(engine.prepareTrackPersonalBestGhost).toHaveBeenCalledWith(featuredChallenge);
  });

  it("uses the default car settings for daily challenges", () => {
    const setRuntimeConfig = vi.fn();

    RealTimeRacer.prototype.applyDailyChallenge.call({
      createDailyChallengeRun: vi.fn(() => ({})),
      syncCurrentRunPolicy: vi.fn(),
      syncTrackMedalFromChallengeBest: vi.fn(),
      setRuntimeConfig,
      dailyChallengeBestResult: null,
      bestLapTime: null,
      hud: {
        setPauseVisible: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
      },
      syncChallengeHudPrimaryStats: vi.fn(),
      updateDailyChallengeHud: vi.fn(),
    }, {
      id: "daily-1",
    });

    expect(setRuntimeConfig).toHaveBeenCalledWith(null);
  });

  it("uses the PB for the selected race contract instead of another day's stored best", () => {
    const setBestTime = vi.fn();
    const engine = {
      createDailyChallengeRun: vi.fn(() => ({})),
      syncCurrentRunPolicy: vi.fn(),
      syncTrackMedalFromChallengeBest: vi.fn(),
      setRuntimeConfig: vi.fn(),
      dailyChallengeBestResult: null,
      trackPersonalBestResult: null,
      trackPersonalBestByTrackKey: {
        "daily-1": {
          challengeId: "daily-1",
          trackKey: "circuit",
          bestTime: 41.25,
          checkpointTimesSec: [10, 20, 30],
        },
      },
      sessionBestLapSecByTrackKey: Object.create(null),
      sessionBestCheckpointTimesByTrackKey: Object.create(null),
      bestLapTime: null,
      hud: {
        setPauseVisible: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
        setBestTime,
      },
      syncChallengeHudPrimaryStats: vi.fn(),
      updateDailyChallengeHud: vi.fn(),
    };

    RealTimeRacer.prototype.applyDailyChallenge.call(engine, {
      id: "daily-1",
      trackKey: "circuit",
    });

    expect(engine.bestLapTime).toBe(41.25);
    expect(engine.trackPersonalBestResult).toMatchObject({
      trackKey: "circuit",
      bestTime: 41.25,
    });
    expect(engine.sessionBestLapSecByTrackKey["daily-1"]).toBe(41.25);
  });

  it("loads car sprites from app-relative asset URLs", () => {
    const originalImage = global.Image;
    const imageInstances = [];

    global.Image = class {
      constructor() {
        this.listeners = {};
        imageInstances.push(this);
      }

      addEventListener(type, handler) {
        this.listeners[type] = handler;
      }
    };

    const loader = new CarSpriteLoader();
    loader.prefetch("assets/cars/mr_mr_red.webp");

    expect(imageInstances).toHaveLength(1);
    expect(imageInstances[0].src).toBe("/assets/cars/mr_mr_red.webp");

    global.Image = originalImage;
  });

  it("falls back to source-local public asset URLs", async () => {
    const originalImage = global.Image;
    const imageInstances = [];

    global.Image = class {
      constructor() {
        this.listeners = {};
        imageInstances.push(this);
      }

      addEventListener(type, handler) {
        this.listeners[type] = handler;
      }

      set src(value) {
        this._src = value;
      }

      get src() {
        return this._src;
      }
    };

    const loader = new CarSpriteLoader();
    const record = loader.prefetch("assets/cars/mr_mr_red.webp");

    imageInstances[0].listeners.error();
    expect(imageInstances[0].src).toBe("/public/assets/cars/mr_mr_red.webp");
    imageInstances[0].listeners.load();
    await expect(record.promise).resolves.toBe(imageInstances[0]);

    global.Image = originalImage;
  });

  it("exposes built and source-local car asset URL candidates", () => {
    expect(getCarAssetUrlCandidates("assets/cars/mr_mr_red.webp")).toEqual([
      "/assets/cars/mr_mr_red.webp",
      "/public/assets/cars/mr_mr_red.webp",
    ]);
  });

  it("centers the ready-state map after the start overlay settles the page layout", () => {
    const originalWindow = global.window;
    global.window = { innerWidth: 1024 };
    let containerHeight = 900;
    const callOrder = [];
    const canvas = { width: 1000, height: 900 };

    try {
      RealTimeRacer.prototype.reset.call({
        clearTimers: vi.fn(),
        pendingStartFrame: null,
        modal: {
          isModalActive: () => false,
          closeModal: vi.fn(),
        },
        hud: {
          setHudPersonalBestsOpenAllowed: vi.fn(),
          setPauseVisible: vi.fn(),
          resetCountdown: vi.fn(),
          resetHud: vi.fn(),
          setBestTime: vi.fn(),
        },
        startOverlay: {
          showStartOverlay: vi.fn(() => {
            callOrder.push("showStartOverlay");
            containerHeight = 820;
          }),
          hideStartOverlay: vi.fn(),
        },
        currentTrack: {
          startPos: { x: 12, y: 9 },
          startAngle: 0,
        },
        pos: { x: 0, y: 0 },
        prevPos: { x: 0, y: 0 },
        velocity: { x: 1, y: 1 },
        angle: 1,
        prevAngle: 1,
        clearSteeringInput: vi.fn(),
        relaunchDelayRemaining: 0,
        status: "won",
        activeRunId: 0,
        nextCheckpointIndex: 2,
        accumulator: 0,
        currentTime: 12,
        skidMarks: { clear: vi.fn() },
        routeTrace: { clear: vi.fn() },
        runHistory: { clear: vi.fn() },
        runHistoryTimer: 0,
        particles: [{}],
        clearDailyChallengeRun: vi.fn(),
        bestLapTime: null,
        canvas,
        resize: RealTimeRacer.prototype.resize,
        container: {
          clientWidth: 1000,
          get clientHeight() {
            return containerHeight;
          },
        },
        isNarrowViewport: false,
        camera: { x: 0, y: 0 },
        zoom: 1,
        _lookAheadX: 5,
        _lookAheadY: 5,
        requestRender: vi.fn(() => {
          callOrder.push("requestRender");
        }),
      });
    } finally {
      global.window = originalWindow;
    }

    expect(canvas.height).toBe(820);
    expect(callOrder).toEqual(["showStartOverlay", "requestRender"]);
  });

  it("snaps interpolation state when the countdown hands off to gameplay", () => {
    vi.useFakeTimers();
    const originalRequestAnimationFrame = global.requestAnimationFrame;
    let pendingFrame = null;
    global.requestAnimationFrame = vi.fn((callback) => {
      pendingFrame = callback;
      return 1;
    });

    const engine = {
      status: "ready",
      pos: { x: 10, y: 6 },
      prevPos: { x: 3, y: 2 },
      angle: 1.2,
      prevAngle: 0.4,
      accumulator: 0.012,
      activeRunId: 0,
      activeTimers: [],
      bestLapTime: null,
      frameSkip: 1,
      isPracticeMode: () => false,
      isDailyChallengeRun: () => false,
      activeDailyChallenge: { rulesRevision: 1 },
      currentRunPolicy: { requiredLaps: 3, rulesRevision: 0 },
      scoreboardReplay: { reset: vi.fn() },
      recordRunPoint: vi.fn(),
      snapRenderPoseToCurrentPose:
        RealTimeRacer.prototype.snapRenderPoseToCurrentPose,
      resetFrameTimingHistory: vi.fn(),
      updateDailyChallengeHud: vi.fn(),
      syncChallengeHudPrimaryStats: vi.fn(),
      syncChallengeHudSecondaryStats: vi.fn(),
      requestRender: vi.fn(),
      runHistory: {
        clear: vi.fn(),
      },
      hud: {
        setHudPersonalBestsOpenAllowed: vi.fn(),
        setPauseVisible: vi.fn(),
        setBestTime: vi.fn(),
        showStartLights: vi.fn(),
        turnOnCountdownLight: vi.fn(),
        hideStartLights: vi.fn(),
        showGoMessage: vi.fn(),
        resetCountdown: vi.fn(),
      },
      modal: {
        closeModal: vi.fn(),
      },
      startOverlay: {
        hideStartOverlay: vi.fn(),
      },
    };

    try {
      RealTimeRacer.prototype.startSequence.call(engine);
      vi.advanceTimersByTime(1500);
      expect(pendingFrame).toEqual(expect.any(Function));

      pendingFrame(2500);

      expect(engine.status).toBe("playing");
      expect(engine.prevPos).toEqual(engine.pos);
      expect(engine.prevAngle).toBe(engine.angle);
      expect(engine.accumulator).toBe(0);
      expect(engine.lastTime).toBe(2500);
      expect(engine.frameSkip).toBe(0);
      expect(engine.requestRender).toHaveBeenCalled();
      expect(engine.scoreboardReplay.reset).toHaveBeenCalledWith({
        maxFrames: 7500,
        targetLapNumber: 3,
        rulesRevision: 1,
      });
    } finally {
      global.requestAnimationFrame = originalRequestAnimationFrame;
      vi.useRealTimers();
    }
  });

  it("shows GHOST UNAVAILABLE only after GO clears", () => {
    vi.useFakeTimers();
    const originalRequestAnimationFrame = global.requestAnimationFrame;
    let pendingFrame = null;
    global.requestAnimationFrame = vi.fn((callback) => {
      pendingFrame = callback;
      return 1;
    });

    const showGhostUnavailableNotice = vi.fn(() => true);
    const resetCountdown = vi.fn();
    const engine = {
      status: "ready",
      pos: { x: 10, y: 6 },
      prevPos: { x: 3, y: 2 },
      angle: 1.2,
      prevAngle: 0.4,
      accumulator: 0.012,
      activeRunId: 0,
      activeTimers: [],
      bestLapTime: null,
      frameSkip: 1,
      isPracticeMode: () => false,
      isDailyChallengeRun: () => false,
      scoreboardReplay: { reset: vi.fn() },
      recordRunPoint: vi.fn(),
      snapRenderPoseToCurrentPose:
        RealTimeRacer.prototype.snapRenderPoseToCurrentPose,
      resetFrameTimingHistory: vi.fn(),
      updateDailyChallengeHud: vi.fn(),
      syncChallengeHudPrimaryStats: vi.fn(),
      syncChallengeHudSecondaryStats: vi.fn(),
      requestRender: vi.fn(),
      beginPersonalBestGhostRunAtGo: () => ({
        ghostActive: false,
        ghostExpected: true,
        noticeNeeded: true,
      }),
      runHistory: {
        clear: vi.fn(),
      },
      hud: {
        setHudPersonalBestsOpenAllowed: vi.fn(),
        setPauseVisible: vi.fn(),
        setBestTime: vi.fn(),
        showStartLights: vi.fn(),
        turnOnCountdownLight: vi.fn(),
        hideStartLights: vi.fn(),
        showGoMessage: vi.fn(),
        resetCountdown,
        showGhostUnavailableNotice,
      },
      modal: {
        closeModal: vi.fn(),
      },
      startOverlay: {
        hideStartOverlay: vi.fn(),
      },
    };

    try {
      RealTimeRacer.prototype.startSequence.call(engine);
      vi.advanceTimersByTime(1100);
      pendingFrame(2500);

      expect(showGhostUnavailableNotice).not.toHaveBeenCalled();
      expect(resetCountdown).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);

      expect(resetCountdown).toHaveBeenCalledTimes(1);
      expect(showGhostUnavailableNotice).toHaveBeenCalledTimes(1);
      expect(resetCountdown.mock.invocationCallOrder[0])
        .toBeLessThan(showGhostUnavailableNotice.mock.invocationCallOrder[0]);
    } finally {
      global.requestAnimationFrame = originalRequestAnimationFrame;
      vi.useRealTimers();
    }
  });

  it("resets the submitted replay when collision auto-restart starts a fresh attempt", () => {
    const engine = {
      status: "playing",
      currentTrack: {
        startPos: { x: 8, y: 4 },
        startAngle: 0,
      },
      runtimeConfig: { carRearAxleOffset: 0 },
      collisionRestartDelaySec: 0.5,
      scoreboardReplay: { reset: vi.fn() },
      resetRunToTrackStart: RealTimeRacer.prototype.resetRunToTrackStart,
      resetChallengeRunAfterCollisionRestart:
        RealTimeRacer.prototype.resetChallengeRunAfterCollisionRestart,
      armRelaunchDelay: RealTimeRacer.prototype.armRelaunchDelay,
      clearSteeringInput: vi.fn(),
      _resetLapTrailAfterIntermediateLap:
        RealTimeRacer.prototype._resetLapTrailAfterIntermediateLap,
      recordRunPoint: vi.fn(),
      routeTrace: { clear: vi.fn() },
      runHistory: { clear: vi.fn() },
      skidMarks: { clear: vi.fn() },
      modal: { closeModal: vi.fn() },
      hud: {
        setPauseVisible: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
        syncHud: vi.fn(),
      },
      updateDailyChallengeHud: vi.fn(),
      requestRender: vi.fn(),
      getNow: () => 1234,
    };

    RealTimeRacer.prototype.restartCurrentRunAfterCollision.call(engine);

    expect(engine.scoreboardReplay.reset).toHaveBeenCalledTimes(1);
    expect(engine.currentTime).toBe(0);
    expect(engine.relaunchDelayRemaining).toBe(0.5);
    expect(engine.status).toBe("playing");
  });

  it("resets multi-lap challenge progress when collision auto-restart starts a fresh attempt", () => {
    const engine = {
      status: "playing",
      currentTrack: {
        startPos: { x: 8, y: 4 },
        startAngle: 0,
      },
      runtimeConfig: { carRearAxleOffset: 0 },
      collisionRestartDelaySec: 0.5,
      currentChallengeRun: {
        objectiveType: "multi_lap_total",
        requiredLaps: 2,
        completedLaps: 1,
        lastLapAt: 20,
        bestLap: 20,
        bestLapSecBeforeLastLap: null,
        recentLaps: [20],
      },
      scoreboardReplay: { reset: vi.fn() },
      resetRunToTrackStart: RealTimeRacer.prototype.resetRunToTrackStart,
      resetChallengeRunAfterCollisionRestart:
        RealTimeRacer.prototype.resetChallengeRunAfterCollisionRestart,
      armRelaunchDelay: RealTimeRacer.prototype.armRelaunchDelay,
      clearSteeringInput: vi.fn(),
      _resetLapTrailAfterIntermediateLap:
        RealTimeRacer.prototype._resetLapTrailAfterIntermediateLap,
      recordRunPoint: vi.fn(),
      routeTrace: { clear: vi.fn() },
      runHistory: { clear: vi.fn() },
      skidMarks: { clear: vi.fn() },
      modal: { closeModal: vi.fn() },
      hud: {
        setPauseVisible: vi.fn(),
        setHudPersonalBestsOpenAllowed: vi.fn(),
        syncHud: vi.fn(),
      },
      updateDailyChallengeHud: vi.fn(),
      requestRender: vi.fn(),
      getNow: () => 1234,
    };

    RealTimeRacer.prototype.restartCurrentRunAfterCollision.call(engine);

    expect(engine.currentChallengeRun.completedLaps).toBe(0);
    expect(engine.currentChallengeRun.lastLapAt).toBe(0);
    expect(engine.currentChallengeRun.bestLap).toBe(null);
    expect(engine.currentChallengeRun.recentLaps).toEqual([]);
  });

  it("preserves cumulative checkpoint splits when resetting intermediate-lap trails", () => {
    const engine = {
      lapCheckpointTimesSec: [1.25, 2.5],
      routeTrace: { clear: vi.fn() },
      runHistory: { clear: vi.fn() },
      runHistoryTimer: 5,
      trailTimer: 5,
      recordRunPoint: vi.fn(),
      pos: { x: 2, y: 3 },
      angle: 0,
      runtimeConfig: { carRearAxleOffset: 0 },
    };

    RealTimeRacer.prototype._resetLapTrailAfterIntermediateLap.call(engine);

    expect(engine.lapCheckpointTimesSec).toEqual([1.25, 2.5]);
    expect(engine.routeTrace.clear).toHaveBeenCalledTimes(1);
    expect(engine.runHistory.clear).toHaveBeenCalledTimes(1);
  });

  it("starts on time and flags the unavailable notice when an enabled PB has no ghost at GO", () => {
    const challenge = { id: "daily-pending-pb", trackKey: "circuit" };
    const showGhostUnavailableNotice = vi.fn(() => true);
    const engine = {
      activeDailyChallenge: challenge,
      trackPersonalBestResult: {
        challengeId: challenge.id,
        trackKey: challenge.trackKey,
        bestTime: 42,
        ghostAvailable: true,
      },
      trackPersonalBestByTrackKey: Object.create(null),
      pbGhost: { enabled: true, beginRun: vi.fn(() => false) },
      hud: { showGhostUnavailableNotice },
    };

    expect(RealTimeRacer.prototype.beginPersonalBestGhostRunAtGo.call(engine))
      .toEqual({ ghostActive: false, ghostExpected: true, noticeNeeded: true });
    expect(showGhostUnavailableNotice).not.toHaveBeenCalled();
  });

  it("freezes the selected race PB pace baseline at GO", () => {
    const frozen = Object.freeze({
      finishTimeSec: 42,
      checkpointTimesSec: Object.freeze([10, 20]),
      lapCompletionTimesSec: Object.freeze([21, 42]),
    });
    const engine = {
      activeDailyChallenge: { id: "campaign-stage", trackKey: "circuit" },
      trackPersonalBestResult: {
        challengeId: "campaign-stage",
        trackKey: "circuit",
        bestTime: 42,
      },
      trackPersonalBestByTrackKey: Object.create(null),
      personalBestPaceBaselineByRaceId: { "campaign-stage": frozen },
      pbGhost: { enabled: true, beginRun: vi.fn(() => true) },
      hud: { showGhostUnavailableNotice: vi.fn() },
    };

    RealTimeRacer.prototype.beginPersonalBestGhostRunAtGo.call(engine);
    engine.personalBestPaceBaselineByRaceId["campaign-stage"] = {
      finishTimeSec: 40,
      checkpointTimesSec: [9, 19],
      lapCompletionTimesSec: [20, 40],
    };

    expect(engine.activePersonalBestPaceBaseline).toBe(frozen);
    expect(engine.activePersonalBestPaceBaseline.finishTimeSec).toBe(42);
  });

  it.each([
    [false, { trackKey: "circuit", bestTime: 42 }],
    [true, null],
  ])("does not need an unavailable notice when ghosts are disabled or no PB exists", (enabled, personalBest) => {
    const showGhostUnavailableNotice = vi.fn(() => true);
    const engine = {
      activeDailyChallenge: { id: "daily-no-notice", trackKey: "circuit" },
      trackPersonalBestResult: personalBest,
      trackPersonalBestByTrackKey: Object.create(null),
      pbGhost: { enabled, beginRun: vi.fn(() => false) },
      hud: { showGhostUnavailableNotice },
      getNow: () => 1400,
    };

    const result = RealTimeRacer.prototype.beginPersonalBestGhostRunAtGo.call(engine);

    expect(result.noticeNeeded).toBe(false);
    expect(showGhostUnavailableNotice).not.toHaveBeenCalled();
  });

  it("rejects a malformed canonical ghost without replacing the known PB", () => {
    const challenge = { id: "daily-malformed-ghost", trackKey: "circuit" };
    const existing = {
      challengeId: challenge.id,
      trackKey: "circuit",
      bestTime: 43,
      ghostAvailable: true,
    };
    const clearPrepared = vi.fn();
    const installForChallenge = vi.fn();
    const engine = {
      activeDailyChallenge: challenge,
      currentDailyChallenge: challenge,
      trackPersonalBestResult: existing,
      trackPersonalBestByTrackKey: { [challenge.id]: existing },
      pbGhostSelectionChallengeId: challenge.id,
      pbGhostSelectionGeneration: 1,
      pbGhostPrepareGenerationByChallengeId: { [challenge.id]: 1 },
      pendingPbGhostCandidateChallengeIds: new Set([challenge.id]),
      preparedPbGhostChallengeId: challenge.id,
      pbGhost: { clearPrepared },
      pbGhostService: { installForChallenge },
      resolveTrackPersonalBestGhostPending:
        RealTimeRacer.prototype.resolveTrackPersonalBestGhostPending,
    };

    const result = RealTimeRacer.prototype.installCanonicalTrackPersonalBestGhost.call(
      engine,
      challenge,
      {
        trackKey: challenge.trackKey,
        bestTimeMs: 42_000,
        checkpointTimesSec: null,
        updatedAt: "2026-07-17T20:00:00.000Z",
        ghost: {
          schemaVersion: 2,
          sampleIntervalMs: 50,
          finishTimeMs: 50,
          origin: [0, 0, 0],
          deltas: [],
        },
      },
    );

    expect(result).toBeNull();
    expect(engine.trackPersonalBestResult).toBe(existing);
    expect(engine.trackPersonalBestByTrackKey[challenge.id]).toBe(existing);
    expect(installForChallenge).not.toHaveBeenCalled();
    expect(clearPrepared).toHaveBeenCalledTimes(1);
  });

  it("restores the prior authoritative ghost for the attempt after a rejected PB", () => {
    const challenge = { id: "daily-rejected-pb", trackKey: "circuit" };
    const previous = {
      bestTimeMs: 43_000,
      samples: [
        { timeMs: 0, x: 0, y: 0, angle: 0 },
        { timeMs: 43_000, x: 1, y: 1, angle: 0 },
      ],
    };
    const prepare = vi.fn(() => true);
    const engine = {
      activeDailyChallenge: challenge,
      pbGhostSelectionChallengeId: challenge.id,
      pbGhostSelectionGeneration: 1,
      pendingPbGhostCandidateChallengeIds: new Set([challenge.id]),
      previousPreparedPbGhostByChallengeId: { [challenge.id]: previous },
      pbGhost: { prepare, clearPrepared: vi.fn() },
      preparedPbGhostChallengeId: null,
      resolveTrackPersonalBestGhostPending:
        RealTimeRacer.prototype.resolveTrackPersonalBestGhostPending,
    };

    expect(RealTimeRacer.prototype.restorePreviousTrackPersonalBestGhost.call(
      engine,
      challenge,
    )).toBe(true);
    expect(prepare).toHaveBeenCalledWith(previous);
    expect(engine.preparedPbGhostChallengeId).toBe(challenge.id);
    expect(engine.pendingPbGhostCandidateChallengeIds.has(challenge.id)).toBe(false);
  });
});
