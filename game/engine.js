import { CONFIG } from "./config.js";
import { DEFAULT_TRACK_KEY } from "./track/catalog.js";
import { TRACKS } from "./track/tracks.js";
import {
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "./track/presentation.js";
import { RingBuffer } from "./race/ring-buffer.js";
import {
  getPlayerProgressState,
} from "./storage.js";
import { createRunPolicy } from "./race/run-policy.js";
import {
  detectDevicePerformance,
  shouldExposeDebugHooks,
  shouldUseTrackLayerWorker,
  readCanvasDevicePixelRatio,
} from "./track/environment.js";
import { ReplayRecorder } from "./race/replay.js";
import { SteeringInput } from "./race/steering-input.js";
import { getCarRearAxleWorldPoint } from "./race/simulation.js";
import { createCarSprite } from "./car/sprite.js";
import { CarSpriteLoader } from "./car/sprite.js";
import { normalizePhysicsConfig } from "./car/handling.js";
import { TrackLayerRenderer } from "./track/layer.js";
import { RaceHud } from "./race/ui-hud.js";
import { StartOverlay } from "./race/ui-start-overlay.js";
import { DailyChallengeUi } from "./daily-challenge/ui.js";
import { ModalContentUi } from "./race/ui-modal-content.js";
import { ModalShell } from "./race/ui-modal-shell.js";
import { LoadingScreen } from "./ui/loader.js";
import { InteractionsUi } from "./race/ui-interactions.js";
import { LeaderboardsUi } from "./scoreboard/ui.js";
import { SettingsUi } from "./settings/ui.js";
import { GarageUi } from "./settings/garage-ui.js";
import { readPlayerTrailStrokeStyle } from "./car/player-trail.js";
import { trackEngineMethods } from "./track/engine-methods.js";
import { raceEngineMethods } from "./race/engine-methods.js";
import { dailyChallengeEngineMethods } from "./daily-challenge/engine-methods.js";
import { scoreboardEngineMethods } from "./scoreboard/engine-methods.js";
import { createCarEffectsAudio } from "./audio/car-effects-audio.js";
import { createMedalEffectsAudio } from "./audio/medal-effects-audio.js";
import { createProceduralMusic } from "./audio/procedural-music.js";
import { getCollisionAutoRestartEnabled } from "./settings/collision-auto-restart-preference.js";
import { getCollisionRestartDelaySec } from "./settings/collision-restart-delay-preference.js";
import { getCarProceduralAudioEnabled } from "./settings/car-audio-preference.js";
import { getMusicEnabled } from "./settings/music-preference.js";
import { getPbGhostEnabled } from "./settings/pb-ghost-preference.js";
import { PbGhost } from "./ghost/pb-ghost.js";
import { PbGhostService } from "./ghost/pb-ghost-service.js";
import { JourneyService } from "./journeys/service.js";
import {
  applyPlayerPreferences,
  queuePlayerPreferencesSave,
} from "./player/preferences.js";
import {
  confirmDailyChallengeShare,
  previewDailyChallengeShare,
} from "./daily-challenge/service.js";

export class RealTimeRacer {
  constructor() {
    this.trackLayerCanvas = document.getElementById("trackLayerCanvas");
    this.canvas = document.getElementById("gameCanvas");
    this.setLoadingStatus(10, "Initializing Engine...");
    this.ctx =
      this.canvas.getContext("2d", { alpha: true }) ||
      this.canvas.getContext("2d");
    this.container = document.getElementById("game-container");
    this.isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    this.trackLayer = new TrackLayerRenderer(this.trackLayerCanvas);
    this.trackLayer.setup({ allowWorker: shouldUseTrackLayerWorker() });
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.viewportDevicePixelRatio = 1;

    this.carSprite = createCarSprite();
    this.carSpriteDrawWidth = 64;
    this.carSpriteDrawHeight = 32;
    this.carSpriteLoader = new CarSpriteLoader();
    this.carAssetPromise = this.syncCarSpriteAsset();

    this.currentTrack = TRACKS[DEFAULT_TRACK_KEY];
    this.currentTrackKey = DEFAULT_TRACK_KEY;
    this.currentTrackPresentation = resolveTrackPresentation(DEFAULT_TRACK_KEY, {
      surface: TRACK_PRESENTATION_SURFACES.RACE,
    });
    this.pos = { ...this.currentTrack.startPos };
    this.velocity = { x: 0, y: 0 };
    this.angle = this.currentTrack.startAngle;

    this.activeGeometry = { outer: [], inner: [] };
    this.collisionSegments = [];
    this.collisionHash = null;
    this.trackCanvasOrigin = { x: 0, y: 0 };

    this.status = "ready";
    this.currentTime = 0;
    this.nextCheckpointIndex = 0;
    this.bestLapTime = null;
    this.currentRunPolicy = createRunPolicy();
    this.runtimeConfig = { ...CONFIG };
    this.activeDailyChallenge = null;
    /** Last challenge raced this page session; home Start prefers this over featured daily. */
    this.lastPlayedDailyChallenge = null;
    this.currentChallengeRun = null;
    this.trackMedalBeforeLastLapWrite = null;
    this.hasTrackMedalBeforeLastLapWrite = false;
    /** Per-track fastest lap this page session (survives challenge retries). */
    this.sessionBestLapSecByTrackKey = Object.create(null);
    /** Per-track checkpoint split times (sec) for the session PB lap. */
    this.sessionBestCheckpointTimesByTrackKey = Object.create(null);
    this.dailyChallengeBestResult = null;
    this.trackPersonalBestResult = null;
    this.trackPersonalBestByTrackKey = Object.create(null);
    this.pbGhost = new PbGhost({ enabled: getPbGhostEnabled() });
    this.pbGhostService = new PbGhostService();
    this.journeys = new JourneyService();
    this.preparedPbGhostChallengeId = null;
    this.pbGhostSelectionChallengeId = null;
    this.pbGhostSelectionGeneration = 0;
    this.pbGhostPrepareGenerationByChallengeId = Object.create(null);
    this.pendingPbGhostCandidateChallengeIds = new Set();
    this.previousPreparedPbGhostByChallengeId = Object.create(null);
    this.unavailablePbGhostChallengeIds = new Set();
    this.verificationQueueTimer = null;
    this.isProcessingVerificationQueue = false;
    this.hasAnyData = false;
    this.isReturningPlayer = false;
    this.redditUsername = null;
    this.activeTimers = [];
    this.resizeCommitTimer = null;

    this.skidMarks = new RingBuffer(160, () => ({
      x: 0,
      y: 0,
      cos: 0,
      sin: 0,
    }));
    this.routeTrace = new RingBuffer(480, () => ({ x: 0, y: 0 }));
    this.routeTraceStrokeStyle = readPlayerTrailStrokeStyle();
    this.particles = [];
    this.trailTimer = 0;

    this.steeringInput = new SteeringInput();
    this.keys = this.steeringInput.keys;
    this.carEffectsAudio = createCarEffectsAudio();
    this.medalEffectsAudio = createMedalEffectsAudio();
    this.proceduralMusic = createProceduralMusic();

    this.carEffectsAudio?.syncFrame?.({
      status: this.status,
      speed: 0,
      maxSpeedKph: this.runtimeConfig.maxSpeed,
      slipRatio: 0,
      throttleBlocked: false,
    });
    this.proceduralMusic?.syncFrame?.({
      status: this.status,
      speed: 0,
      maxSpeedKph: this.runtimeConfig.maxSpeed,
    });

    this.camera = { x: 0, y: 0 };
    this.zoom = 1;
    this.isNarrowViewport = false;
    this._lookAheadX = 0;
    this._lookAheadY = 0;

    this.cachedSpeed = 0;
    this.angularVelocity = 0;
    this.frameSkip = 0;
    this.frameTimeHistory = [];
    this.frameTimeHistoryIndex = 0;
    this.frameTimeTotal = 0;

    this.FIXED_DT = 1 / 60;
    this.accumulator = 0;
    this.prevPos = { ...this.currentTrack.startPos };
    this.prevAngle = this.currentTrack.startAngle;
    this.timeOffsetMs = 0;
    this.loadingScreen = new LoadingScreen();

    this.qualityLevel = detectDevicePerformance();

    this.runHistory = new RingBuffer(1400, () => ({ x: 0, y: 0 }));
    this.runHistoryTimer = 0;

    this._displayPos = { x: 0, y: 0 };
    this._desiredLookAhead = { x: 0, y: 0 };
    this._boundLoop = (time) => this.loop(time);
    this._frameRequestId = null;
    this._needsRender = true;
    this.trackLoadRequestId = 0;
    this.pendingStartFrame = null;
    this.startButtonPending = false;
    this.relaunchDelayRemaining = 0;
    this.wallImpactCooldownRemaining = 0;
    this.wallContactActive = false;
    this.wallContactReleaseRemaining = 0;
    this.activeRunId = 0;
    this.scoreboardReplay = new ReplayRecorder();
    this.lapCheckpointTimesSec = [];
    this.runHadTimingAnomaly = false;
    this.rankedSubmissionBlockedReason = null;

    this._previewPresentationOpId = 0;
    this.dailyChallengeUi = new DailyChallengeUi({
      previewQualityLevel: this.qualityLevel,
      previewFrameSkip: this.frameSkip,
      onSummaryUpdated: () => {
        this.startOverlay?.updateStartOverlayMode(
          this.startOverlay.hasAnyData,
          this.startOverlay.isReturningPlayer,
        );
      },
      getModalShell: () => this.modal,
    });
    this.startOverlay = new StartOverlay({
      dailyChallengeUi: this.dailyChallengeUi,
    });
    this.hud = new RaceHud({
      getTrackPersonalBest: () => this.bestLapTime,
      getCurrentTrackKey: () => this.currentTrackKey,
      persistTrackPersonalBest: ({ bestLapTime }) => {
        this.bestLapTime = bestLapTime;
      },
    });
    this.modalContent = new ModalContentUi();
    this.trackReadyPromise = new Promise((resolve) => {
      if (this.trackLayer.workerActive || !this.trackLayer.workerReady) {
        resolve();
      } else {
        this.trackLayer.onTrackReady = resolve;
      }
    });
    this.fontsReadyPromise = document.fonts ? document.fonts.ready : Promise.resolve();
    this.modal = new ModalShell({
      content: this.modalContent,
      getLeaderboards: () => this.leaderboards,
      getCurrentTrackKey: () => this.currentTrackKey,
      getDefaultPrimaryAction: () => () => this.reset(true),
      cancelLeaderboardRequests: () => this.leaderboards?.cancelPendingRequests(),
      playUnlockSound: (tier) => this.medalEffectsAudio?.scheduleMedalUnlock?.(tier),
      getGarageUi: () => this.garage,
      getRedditUsername: () => this.redditUsername,
      previewShare: (payload) => previewDailyChallengeShare(payload),
      confirmShare: (shareToken) => confirmDailyChallengeShare(shareToken),
    });
    this.leaderboards = new LeaderboardsUi({
      showRunsModal: (...args) => this.modal.showRunsModal(...args),
      dailyChallengeUi: this.dailyChallengeUi,
      onStartDailyChallenge: (challenge, options = {}) => {
        void this.handleStartDailyChallenge(challenge, options);
      },
      isRunsViewActive: () => this.modal.isRunsViewActive?.(),
      updateModalScoreboardSnapshot: (snapshot) => this.modal.updateModalScoreboardSnapshot?.(snapshot),
      updateModalLeaderboardDayOptions: (options) => this.modal.updateModalLeaderboardDayOptions?.(options),
    });
    this.collisionAutoRestartEnabled = getCollisionAutoRestartEnabled();
    this.collisionRestartDelaySec = getCollisionRestartDelaySec();
    this.settings = new SettingsUi({
      modal: this.modal,
      onCollisionAutoRestartChanged: (value) => {
        this.collisionAutoRestartEnabled = value;
      },
      onCollisionRestartDelayChanged: (value) => {
        this.collisionRestartDelaySec = value;
      },
      onCarAudioChanged: (enabled) => {
        this.carEffectsAudio?.setEnabled?.(enabled);
        const cs = this.cachedSpeed;
        const vx = Math.cos(this.angle);
        const vy = Math.sin(this.angle);
        const sideSlip = Math.abs(-vy * this.velocity.x + vx * this.velocity.y);
        const slipRatio = cs > 0.001 ? sideSlip / cs : 0;
        this.carEffectsAudio?.syncFrame?.({
          status: this.status,
          speed: cs,
          maxSpeedKph: this.runtimeConfig.maxSpeed,
          slipRatio,
          throttleBlocked: this.relaunchDelayRemaining > 0,
        });
      },
      onMusicChanged: (enabled) => {
        this.proceduralMusic?.setEnabled?.(enabled);
        this.proceduralMusic?.syncFrame?.({
          status: this.status,
          speed: this.cachedSpeed,
          maxSpeedKph: this.runtimeConfig.maxSpeed,
        });
      },
      onPbGhostChanged: (enabled) => {
        this.pbGhost.setEnabled(enabled);
        this.requestRender();
      },
      onLeaderboardIdentityChanged: async () => {
        await this.refreshDailyChallengeSummary({ forceRefresh: true });
      },
      onPlayerPreferencesChanged: () => queuePlayerPreferencesSave(),
    });
    this.garage = new GarageUi({
      modal: this.modal,
      prefetchCarSpriteAsset: (name) => this.prefetchCarSpriteAsset(name),
      onCarSkinChanged: () => {
        void this.syncCarSpriteAsset();
        if (this.status === "ready") {
          this.requestRender();
        }
      },
      onTrailStrokeStyleChanged: (strokeStyle) => {
        this.routeTraceStrokeStyle = strokeStyle;
        this.routeTrace.clear();
        this.trailTimer = 0;
        if (strokeStyle) {
          const { x, y } = getCarRearAxleWorldPoint(
            this.pos,
            this.angle,
            this.runtimeConfig,
          );
          const slot = this.routeTrace.write();
          slot.x = x;
          slot.y = y;
        }
        this.requestRender();
      },
      onPlayerPreferencesChanged: () => queuePlayerPreferencesSave(),
    });
    this.interactions = new InteractionsUi({
      modal: this.modal,
      startOverlay: this.startOverlay,
      leaderboards: this.leaderboards,
      onStartDailyChallenge: () => this.handleStartDailyChallenge(null, {
        startSource: "main_menu",
      }),
      onOpenDailyPlaylist: () => this.openDailyChallengePlaylist(),
      onPauseRun: () => this.pauseActiveRun(),
    });
    this.interactions.bindModalViewToggles();
    this.interactions.bindModalActionRowPointerFocus();
    this.interactions.bindMenu();
    this.interactions.bindPrimaryActions();
    this.dailyChallengeUi.bindPlaylistModal();
    this.garage.bind();
    this.hud.setPauseVisible(false);

    this.setLoadingStatus(30, "Fetching Profile...");
    this.playerHistoryPromise = getPlayerProgressState()
      .then(async ({ hasAnyData, isReturningPlayer, playerPreferences, redditUsername }) => {
        this.setLoadingStatus(50, "Profile Loaded...");
        this.hasAnyData = Boolean(hasAnyData);
        this.isReturningPlayer = Boolean(isReturningPlayer);
        this.redditUsername = typeof redditUsername === "string" && redditUsername.trim()
          ? redditUsername.trim()
          : null;
        if (playerPreferences) {
          await this.applyPersistedPlayerPreferences(playerPreferences);
        } else {
          queuePlayerPreferencesSave();
        }
        return {
          hasAnyData,
          isReturningPlayer: this.isReturningPlayer,
        };
      })
      .catch((error) => {
        console.error("Error loading player history:", error);
        return {
          hasAnyData: false,
          isReturningPlayer: false,
        };
      });
    this.dailyChallengePromise = this.loadDailyChallengeCritical();
    this.initialPbGhostAssetPromise = this.loadInitialPersonalBestGhostAsset();
    Promise.allSettled([
      this.playerHistoryPromise,
      this.dailyChallengePromise,
      this.initialPbGhostAssetPromise,
      this.carAssetPromise,
      this.trackReadyPromise,
    ]).finally(async () => {
      this.loadingScreen.update(95, "Displaying Lobby...");

      this.startOverlay.showStartOverlay(
        this.hasAnyData,
        this.isReturningPlayer,
      );
      this.startOverlay.setReady(true);

      await this.loadingScreen.dismiss();
      this.startOverlay.setInteractive(true);
      void this.journeys.appReady();
      this.loadSecondaryStartupData();
    });

    new ResizeObserver(() => this.scheduleResizeCommit()).observe(
      this.container,
    );
    window.addEventListener("keydown", (event) => this.handleKey(event, true));
    window.addEventListener("keyup", (event) => this.handleKey(event, false));
    window.addEventListener("blur", () => this.clearSteeringInput());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clearSteeringInput();
      this.carEffectsAudio?.setTabHidden?.(document.hidden);
      this.medalEffectsAudio?.setTabHidden?.(document.hidden);
      this.proceduralMusic?.setTabHidden?.(document.hidden);
      if (!document.hidden) {
        const challengeId =
          this.currentDailyChallenge?.id ||
          this.activeDailyChallenge?.id ||
          this.dailyChallengeUi?.getSummary?.()?.challengeId ||
          null;
        void this.leaderboards?.refreshDailyChallengeAfterResume?.(challengeId);
      }
    });
    window.addEventListener("online", () => {
      this.scheduleVerificationQueueProcessing(0);
    });
    this.interactions.bindSteeringControls({
      onLeftDown: () => this.setTouchSteering("left", true),
      onLeftUp: () => this.setTouchSteering("left", false),
      onRightDown: () => this.setTouchSteering("right", true),
      onRightUp: () => this.setTouchSteering("right", false),
    });

    this.resize();
    if (shouldExposeDebugHooks()) {
      this.exposeTestHooks();
    } else {
      delete window.__RACER_DEBUG__;
      delete window.render_game_to_text;
      delete window.advanceTime;
    }

    this.lastTime = this.getNow();
    this.requestFrame();
  }

  get carSpriteAssetKey() {
    return this.carSpriteLoader.currentAssetKey;
  }

  async applyPersistedPlayerPreferences(playerPreferences) {
    if (!applyPlayerPreferences(playerPreferences)) return;

    this.collisionAutoRestartEnabled = getCollisionAutoRestartEnabled();
    this.collisionRestartDelaySec = getCollisionRestartDelaySec();
    this.carEffectsAudio?.setEnabled?.(getCarProceduralAudioEnabled());
    this.proceduralMusic?.setEnabled?.(getMusicEnabled());
    this.pbGhost.setEnabled(getPbGhostEnabled());
    this.routeTraceStrokeStyle = readPlayerTrailStrokeStyle();
    this.routeTrace.clear();
    this.trailTimer = 0;
    this.settings.refreshCarAudioPanel();
    this.settings.refreshMusicPanel();
    this.settings.refreshCollisionAutoRestartPanel();
    this.settings.refreshCollisionRestartDelayPanel();
    this.settings.refreshPbGhostPanel();
    this.garage.syncSkinSelection();
    this.garage.syncTrailSelection();
    await this.syncCarSpriteAsset();
    this.requestRender();
  }

  getNow() {
    return performance.now() + this.timeOffsetMs;
  }

  getCanvasDevicePixelRatio() {
    return readCanvasDevicePixelRatio();
  }

  setRuntimeConfig(overrides = null) {
    const normalizedPhysics = normalizePhysicsConfig(
      overrides && typeof overrides === "object" ? overrides : {},
    );
    this.runtimeConfig = {
      ...CONFIG,
      ...(overrides && typeof overrides === "object" ? overrides : {}),
      ...normalizedPhysics,
    };
    this.syncCarSpriteAsset();
    if (this.hud && this.runtimeConfig.maxSpeed) {
      this.hud.setMaxSpeed(this.runtimeConfig.maxSpeed);
    }
  }

  syncCurrentRunPolicy() {
    this.currentRunPolicy = createRunPolicy({
      challengeRun: this.currentChallengeRun,
    });
  }


  exposeTestHooks() {
    const renderGameToText = () => this.renderGameToText();
    const advanceTime = (ms) => this.advanceTime(ms);

    window.__RACER_DEBUG__ = Object.freeze({ renderGameToText, advanceTime });
    window.render_game_to_text = renderGameToText;
    window.advanceTime = advanceTime;
  }

  renderGameToText() {
    return JSON.stringify({
      coordinateSystem:
        "origin top-left, x increases right, y increases down, units are track-grid cells",
      mode: this.status,
      track: this.currentTrackKey,
      player: {
        x: Number(this.pos.x.toFixed(2)),
        y: Number(this.pos.y.toFixed(2)),
        angle: Number(this.angle.toFixed(3)),
        angularVelocity: Number(this.angularVelocity.toFixed(3)),
        velocityX: Number(this.velocity.x.toFixed(2)),
        velocityY: Number(this.velocity.y.toFixed(2)),
        speed: Number(this.cachedSpeed.toFixed(2)),
        wallImpactCooldownSec: Number((Number(this.wallImpactCooldownRemaining) || 0).toFixed(3)),
        wallContactActive: Boolean(this.wallContactActive),
        wallContactReleaseSec: Number((Number(this.wallContactReleaseRemaining) || 0).toFixed(3)),
      },
      lapTime: Number(this.currentTime.toFixed(2)),
      challenge: this.currentChallengeRun
        ? {
            completedLaps: this.currentChallengeRun.completedLaps || 0,
            requiredLaps: this.currentChallengeRun.requiredLaps || 1,
            currentLap: Math.min(
              (this.currentChallengeRun.completedLaps || 0) + 1,
              this.currentChallengeRun.requiredLaps || 1,
            ),
            intermediateMedalFlash:
              this.hud?.lapFlash?.classList?.contains?.("visible")
                ? this.hud?.lapFlashMedal?.dataset?.medal || null
                : null,
          }
        : null,
      startLine: this.currentTrack.startLine,
      routeTracePoints: this.routeTrace.length,
      liveParticles: this.particles.length,
    });
  }

  advanceTime(ms) {
    const totalSteps = Math.max(1, Math.round(ms / (this.FIXED_DT * 1000)));
    const stepMs = ms / totalSteps;

    for (let index = 0; index < totalSteps; index++) {
      this.timeOffsetMs += stepMs;
      this.prevPos.x = this.pos.x;
      this.prevPos.y = this.pos.y;
      this.prevAngle = this.angle;
      this.update(this.FIXED_DT);
    }

    if (this.status === "playing") {
      this.hud.syncHud({
        time: this.currentTime,
        speed: this.cachedSpeed,
        force: true,
      });
    }

    this.accumulator = 0;
    this.render(this.FIXED_DT, 1);
    this.lastTime = performance.now();
  }

  setLoadingStatus(progress, status) {
    this.loadingScreen?.update(progress, status);
  }

  loadSecondaryStartupData() {
    this.dailyChallengeSummaryPromise = this.refreshDailyChallengeSummary()
      .catch((error) => {
        console.error("Error loading daily challenge summary:", error);
        return null;
      })
      .finally(() => {
        this.dailyChallengeUi.refreshDailyChallengeVerificationState();
      });
    window.setTimeout(() => {
      this.prefetchDailyChallengePlaylist?.();
    }, 0);
    this.scheduleVerificationQueueProcessing(0);
  }
}

Object.assign(
  RealTimeRacer.prototype,
  trackEngineMethods,
  raceEngineMethods,
  dailyChallengeEngineMethods,
  scoreboardEngineMethods,
);
