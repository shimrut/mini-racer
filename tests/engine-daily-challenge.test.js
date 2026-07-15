import { describe, expect, it, vi } from "vitest";
import { RealTimeRacer } from "../game/engine.js";
import { CarSpriteLoader, getCarAssetNameForPresetConfig, getCarAssetUrlCandidates } from "../game/car/sprite.js";
import { readTrackLastLapMedal } from "../game/medals/last-lap-medal-storage.js";

describe("RealTimeRacer daily challenge modal payload", () => {
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
      resumeActiveRun: vi.fn(),
      reset: vi.fn(),
    });

    expect(showModal).toHaveBeenCalledWith(
      "PAUSED",
      null,
      expect.objectContaining({
        variant: "daily-pause",
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
  });

  it("keeps leaderboard-open enabled for completed daily runs", () => {
    const showModal = vi.fn();

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

    RealTimeRacer.prototype.handleDailyChallengeLapCompleted.call(engine, 5.1);

    expect(engine.hasTrackMedalBeforeLastLapWrite).toBe(true);
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
    const trackModeStart = vi.fn();

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
      trackModeStart,
      reset,
    });

    expect(trackModeStart).toHaveBeenCalledWith({
      trackKey: "harborParkLoop",
    });
    expect(reset).toHaveBeenCalledWith(true, { preserveDailyChallenge: true });
  });

  it("clears daily challenge race context when leaving a challenge run", () => {
    const engine = {
      currentDailyChallenge: { id: "daily-today", trackKey: "circuit" },
      activeDailyChallenge: { id: "daily-today", trackKey: "circuit" },
      currentChallengeRun: { challengeId: "daily-today", trackKey: "circuit" },
      syncCurrentRunPolicy: vi.fn(),
      setRuntimeConfig: vi.fn(),
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
      resetCanvasPresentation: vi.fn(),
      reset: vi.fn(function reset() {
        this.status = "ready";
      }),
      loadTrack: vi.fn(),
      applyDailyChallenge: vi.fn(),
      trackModeStart: vi.fn(),
      startSequence: vi.fn(function startSequence() {
        if (this.status === "ready") {
          this.status = "starting";
        }
      }),
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(engine.reset).toHaveBeenCalledWith(false);
    expect(engine.applyDailyChallenge).toHaveBeenCalledWith(challenge);
    expect(engine.trackModeStart).toHaveBeenCalledWith({
      trackKey: "harborParkLoop",
    });
    expect(engine.startSequence).toHaveBeenCalled();
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
      resetCanvasPresentation: vi.fn(),
      reset: vi.fn(),
      loadTrack: vi.fn(async function loadTrack(trackKey) {
        this.currentTrackKey = trackKey;
        this.status = "ready";
      }),
      applyDailyChallenge: vi.fn(),
      trackModeStart: vi.fn(),
      startSequence: vi.fn(),
    };

    await RealTimeRacer.prototype.handleStartDailyChallenge.call(engine, challenge);

    expect(engine.loadTrack).toHaveBeenCalledWith("blueSector", {
      loadPlayerProgress: false,
      preserveDailyChallengeContext: true,
    });
    expect(engine.applyDailyChallenge).toHaveBeenCalledWith(challenge);
    expect(engine.startSequence).toHaveBeenCalled();
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

  it("uses the single stock car asset for any physics overrides", () => {
    expect(
      getCarAssetNameForPresetConfig({
        accel: 30,
        brakePower: 52,
        maxSpeed: 280,
        turnRate: 5.25,
        grip: 1.1,
      }),
    ).toBe("assets/cars/mr_mr_red.webp");
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
    expect(imageInstances[0].src).toBe("assets/cars/mr_mr_red.webp");

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
    expect(imageInstances[0].src).toBe("public/assets/cars/mr_mr_red.webp");
    imageInstances[0].listeners.load();
    await expect(record.promise).resolves.toBe(imageInstances[0]);

    global.Image = originalImage;
  });

  it("exposes built and source-local car asset URL candidates", () => {
    expect(getCarAssetUrlCandidates("assets/cars/mr_mr_red.webp")).toEqual([
      "assets/cars/mr_mr_red.webp",
      "public/assets/cars/mr_mr_red.webp",
      "./assets/cars/mr_mr_red.webp",
    ]);
  });

  it("centers the ready-state map after the start overlay settles the page layout", () => {
    const originalWindow = global.window;
    global.window = { innerWidth: 1024 };
    let containerHeight = 900;
    const callOrder = [];
    const canvas = { width: 1000, height: 900 };
    const trackLayerCanvas = { width: 1000, height: 900 };

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
        trackLayerCanvas,
        resize: RealTimeRacer.prototype.resize,
        resetCanvasPresentation: vi.fn(),
        container: {
          clientWidth: 1000,
          get clientHeight() {
            return containerHeight;
          },
        },
        updateTrackLayerViewportSize: vi.fn(
          function updateTrackLayerViewportSize() {
            trackLayerCanvas.width = this.container.clientWidth;
            trackLayerCanvas.height = this.container.clientHeight;
          },
        ),
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
    expect(trackLayerCanvas.height).toBe(820);
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
      resetCanvasPresentation: vi.fn(),
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
    } finally {
      global.requestAnimationFrame = originalRequestAnimationFrame;
      vi.useRealTimers();
    }
  });

  it("resets the submitted replay when crash auto-restart starts a fresh attempt", () => {
    const engine = {
      status: "crashed",
      currentTrack: {
        startPos: { x: 8, y: 4 },
        startAngle: 0,
      },
      runtimeConfig: { carRearAxleOffset: 0 },
      crashRestartDelaySec: 0.5,
      scoreboardReplay: { reset: vi.fn() },
      resetRunToTrackStart: RealTimeRacer.prototype.resetRunToTrackStart,
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

    RealTimeRacer.prototype.restartCurrentRunAfterHardCrash.call(engine);

    expect(engine.scoreboardReplay.reset).toHaveBeenCalledTimes(1);
    expect(engine.currentTime).toBe(0);
    expect(engine.relaunchDelayRemaining).toBe(0.5);
    expect(engine.status).toBe("playing");
  });
});
