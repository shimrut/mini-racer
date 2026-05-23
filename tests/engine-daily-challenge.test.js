import { describe, expect, it, vi } from "vitest";
import { RealTimeRacer } from "../game/engine.js";
import { CarSpriteLoader, getCarAssetNameForPresetConfig, getCarAssetUrlCandidates } from "../game/car/sprite.js";

describe("RealTimeRacer daily challenge modal payload", () => {
  it("closes the main-menu garage when escape is pressed", () => {
    const setPanelVisible = vi.fn();
    const event = { key: "Escape", code: "Escape", preventDefault: vi.fn() };

    RealTimeRacer.prototype.handleKey.call(
      {
        status: "ready",
        startOverlay: { isStartOverlayVisible: () => true },
        skillPoints: {
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
      isCrashBudgetDailyChallenge: () => false,
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
      isCrashBudgetDailyChallenge: () => false,
      bestLapTime: 48.35,
      currentTime: 50.1,
      currentTrackKey: "circuit",
      activeDailyChallenge: { objectiveType: "multi_lap_total", skin: "default", trackKey: "circuit" },
      getSelectedCarAssetName: () => "assets/cars/mr_mr_red.webp",
      skillPoints: { getAllocation: () => ({ accel: 2, speed: 1, handling: 2 }) },
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
          skillAllocation: { accel: 2, speed: 1, handling: 2 },
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
        dailyGpRaceStats: { start: 0, crash: 0, win: 0 },
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
        isCrashBudgetDailyChallenge: () => false,
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
      dailyGpRaceStats: { start: 0, crash: 0, win: 0 },
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
      isCrashBudgetDailyChallenge: () => false,
    };

    RealTimeRacer.prototype.handleDailyChallengeLapCompleted.call(engine, 5.0);

    expect(engine.hasTrackMedalBeforeLastLapWrite).toBe(true);
    expect(engine.trackMedalBeforeLastLapWrite).toBe(null);

    RealTimeRacer.prototype.handleDailyChallengeWin.call(engine, {
      lapTime: 5.0,
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

  it("retries a completed daily run without falling back to the regular reset path", () => {
    const reset = vi.fn();
    const trackModeStart = vi.fn();
    const bumpDailyGpRaceStart = vi.fn();

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
      bumpDailyGpRaceStart,
      reset,
    });

    expect(trackModeStart).toHaveBeenCalledWith({
      trackKey: "harborParkLoop",
    });
    expect(bumpDailyGpRaceStart).toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith(true, { preserveDailyChallenge: true });
  });

  it("applies the garage skill allocation over the handling baseline for daily challenges", () => {
    const setRuntimeConfig = vi.fn();

    RealTimeRacer.prototype.applyDailyChallenge.call({
      createDailyChallengeRun: vi.fn(() => ({})),
      syncCurrentRunPolicy: vi.fn(),
      setRuntimeConfig,
      skillPoints: {
        getAllocation: vi.fn(() => ({ accel: 0, speed: 5, handling: 0 })),
      },
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
      physicsOverrides: {
        accel: 100,
        brakePower: 80,
        maxSpeed: 200,
        turnRate: 4,
        grip: 2,
      },
    });

    const tuned = setRuntimeConfig.mock.calls[0][0];
    expect(tuned.maxSpeed).toBe(390);
    expect(tuned.accel).toBe(270);
    expect(tuned.grip).toBeCloseTo(2.78);
    expect(tuned.brakePower).toBe(98);
    expect(tuned.skillPoints).toEqual({ accel: 0, speed: 5, handling: 0 });
  });

  it("prefetches the daily challenge car asset when the daily challenge is selected in the overlay", () => {
    const analytics = { trackModeSelected: vi.fn() };
    const prefetchCarSpriteAsset = vi.fn();

    RealTimeRacer.prototype.trackModeSelection.call(
      {
        analytics,
        getModeAnalyticsPayload:
          RealTimeRacer.prototype.getModeAnalyticsPayload,
        activeDailyChallenge: {
          physicsOverrides: {
            accel: 58,
            brakePower: 90,
            maxSpeed: 320,
            turnRate: 5.75,
            grip: 2.5,
          },
        },
        prefetchCarSpriteAsset,
        getDailyChallengeCarAssetName:
          RealTimeRacer.prototype.getDailyChallengeCarAssetName,
      },
    );

    expect(analytics.trackModeSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "daily",
      }),
    );
    expect(prefetchCarSpriteAsset).toHaveBeenCalledWith(
      "assets/cars/mr_mr_red.webp",
    );
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
      isCrashBudgetDailyChallenge: () => false,
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
});
