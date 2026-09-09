import { CONFIG } from "./config.js";
import { DEFAULT_TRACK_KEY } from "./track/catalog.js";
import { getLoadedClientTrack } from "./track/client-registry.js";
import {
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "./track/presentation.js";
import { RingBuffer } from "./race/ring-buffer.js";
import {
  getPlayerProgressState,
} from "./storage.js";
import { isVerificationQueueSubmissionBlocked } from "./scoreboard/verification-queue.js";
import { createRunPolicy } from "./race/run-policy.js";
import {
  detectDevicePerformance,
  shouldExposeDebugHooks,
  readCanvasDevicePixelRatio,
} from "./track/environment.js";
import { ReplayRecorder } from "./race/replay.js";
import { SteeringInput } from "./race/steering-input.js";
import { getCarRearAxleWorldPoint } from "./race/simulation.js";
import { createCarSprite } from "./car/sprite.js";
import { CarSpriteLoader } from "./car/sprite.js";
import { normalizePhysicsConfig } from "./car/handling.js";
import { setPlayerCarUnlockSnapshot } from "./car/player-car-skin.js";
import { TrackLayerRenderer } from "./track/layer.js";
import { RaceHud } from "./race/ui-hud.js";
import { StartOverlay } from "./race/ui-start-overlay.js";
import { DailyChallengeUi } from "./daily-challenge/ui.js";
import {
  fitTrackPreviewCanvas,
  getTrackAspectRatio,
  TrackCarousel,
} from "./ui/track-carousel.js";
import { ModalContentUi } from "./race/ui-modal-content.js";
import { ModalShell } from "./race/ui-modal-shell.js";
import { LoadingScreen } from "./ui/loader.js";
import { InteractionsUi } from "./race/ui-interactions.js";
import { LeaderboardsUi } from "./scoreboard/ui.js";
import { SettingsUi } from "./settings/ui.js";
import { GarageUi } from "./settings/garage-ui.js";
import { LobbyUi } from "./lobby/ui.js";
import { resolveGameLaunchTarget } from "./modes/launch-target.js";
import { readPlayerTrailStrokeStyle } from "./car/player-trail.js";
import { trackEngineMethods } from "./track/engine-methods.js";
import { raceEngineMethods } from "./race/engine-methods.js";
import { scoreboardEngineMethods } from "./scoreboard/engine-methods.js";
import { opponentRaceEngineMethods } from "./scoreboard/opponent-race-engine-methods.js";
import { modeRouterEngineMethods } from "./modes/engine-methods.js";
import { playerProfileEngineMethods } from "./player/engine-methods.js";
import { createCarEffectsAudio } from "./audio/car-effects-audio.js";
import { createMedalEffectsAudio } from "./audio/medal-effects-audio.js";
import { createProceduralMusic } from "./audio/procedural-music.js";
import { getCollisionAutoRestartEnabled } from "./settings/collision-auto-restart-preference.js";
import { getCollisionRestartDelaySec } from "./settings/collision-restart-delay-preference.js";
import { getCarProceduralAudioEnabled } from "./settings/car-audio-preference.js";
import { getMusicEnabled } from "./settings/music-preference.js";
import { getPbGhostEnabled } from "./settings/pb-ghost-preference.js";
import {
  MODE_LABELS,
  runInitialStartupPlan,
  selectModeSecondaryStartupTasks,
} from "./startup/coordinator.js";
import { PbGhost } from "./ghost/pb-ghost.js";
import { PbGhostService } from "./ghost/pb-ghost-service.js";
import {
  exposePbGhostSizeDebugHooks,
  PbGhostSizeCapture,
  shouldCapturePbGhostSize,
} from "./ghost/pb-ghost-size-debug.js";
import { exposeTestHooks } from "./debug/test-hooks.js";
import { JourneyService } from "./journeys/service.js";
import {
  applyPlayerPreferences,
  queuePlayerPreferencesSave,
} from "./player/preferences.js";
import {
  clearDailyChallengeSnapshotFreshness,
  confirmDailyChallengeShare,
  getActiveDailyChallenge,
  getDailyChallengeExpiry,
  getDailyChallengeSnapshot,
  previewDailyChallengeShare,
  subscribeToDailyChallengeSnapshots,
} from "./daily-challenge/service.js";
import {
  confirmHeadToHeadComment,
  confirmHeadToHeadBrag,
  createHeadToHead,
  getHeadToHead,
  previewHeadToHeadComment,
  previewHeadToHead,
  previewHeadToHeadBrag,
} from "./head-to-head/service.js";

// The legacy Daily mixin remains available to unit tests that exercise the
// prototype directly. Production loads it through runtime-loader.js so Daily
// is not part of the first mode chunk for Campaign or Head-to-Head launches.
const legacyDailyChallengeEngineMethods = import.meta.env.MODE === "test"
  ? (await import("./daily-challenge/engine-methods.js")).dailyChallengeEngineMethods
  : {};

export class RealTimeRacer {
  constructor({
    launchTarget = null,
    modeRuntimeController = null,
    ensureModeRuntime = null,
    initialTrack = null,
    autoStart = true,
  } = {}) {
    this.canvas = document.getElementById("gameCanvas");
    this.loadingScreen = new LoadingScreen();
    this.initialStartupPromise = null;
    this.initialContractPromise = null;
    this.initialDailyChallengeRequestPromise = null;
    this.initialHeadToHeadRequestPromise = null;
    // The track and the car share this one canvas, so nothing renders beneath it and
    // the context can be opaque: the per-pixel blend a transparent canvas costs every
    // frame would buy nothing. render() draws the track first, before it transforms
    // for the world, which is what keeps the draw order right.
    this.ctx =
      this.canvas.getContext("2d", { alpha: false }) ||
      this.canvas.getContext("2d");
    this.container = document.getElementById("game-container");
    this.isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    this.trackLayer = new TrackLayerRenderer(this.ctx);
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.viewportDevicePixelRatio = 1;

    this.carSprite = createCarSprite();
    this.carSpriteDrawWidth = 64;
    this.carSpriteDrawHeight = 32;
    this.carSpriteLoader = new CarSpriteLoader();
    this.carAssetPromise = Promise.resolve(this.carSprite);
    this.opponentCarSprite = createCarSprite();
    this.opponentCarSpriteLoader = new CarSpriteLoader();
    this.raceComparisonTarget = null;

    this.currentTrack = initialTrack || getLoadedClientTrack(DEFAULT_TRACK_KEY) || {
      name: "Loading Track",
      outer: [],
      inner: [],
      startLine: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
      startPos: { x: 0, y: 0 },
      startAngle: 0,
      checkpoints: [],
    };
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
    this.activeRaceMode = "home";
    this.activeCampaignStage = null;
    this.activeHeadToHead = null;
    this.headToHeadChallengeId = null;
    this.headToHeadLoadPending = false;
    this.campaignBootstrap = null;
    this.campaignVerifiedBootstrap = null;
    this.campaignLobbyState = null;
    this._campaignBootstrapReady = false;
    this._campaignBootstrapPromise = null;
    this._campaignBootstrapRequestId = 0;
    this.launchTarget = launchTarget || resolveGameLaunchTarget();
    this.modeRuntimeController = modeRuntimeController;
    if (typeof ensureModeRuntime === "function") {
      this.ensureModeRuntime = ensureModeRuntime;
      this.installModeRuntime = (mode) => {
        if (this.modeRuntimeController) {
          return this.modeRuntimeController.ensure(mode);
        }
        return this.ensureModeRuntime(mode);
      };
      this.prefetchModeRuntime = async (mode) => {
        if (this.modeRuntimeController) {
          return this.modeRuntimeController.prefetch(mode);
        }
        return this.ensureModeRuntime(mode);
      };
    } else if (modeRuntimeController) {
      this.ensureModeRuntime = (mode) => modeRuntimeController.ensure(
        mode,
        this.activeRaceMode,
        this.launchTarget?.mode,
      );
      this.installModeRuntime = (mode) => modeRuntimeController.ensure(mode);
      this.prefetchModeRuntime = (mode) => modeRuntimeController.prefetch(mode);
    } else {
      this.ensureModeRuntime = async () => null;
      this.installModeRuntime = async () => null;
      this.prefetchModeRuntime = async () => null;
    }
    this.lastPlayedDailyChallenge = null;
    this.currentChallengeRun = null;
    this.trackMedalBeforeLastLapWrite = null;
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.sessionBestLapSecByTrackKey = Object.create(null);
    this.sessionBestCheckpointTimesByTrackKey = Object.create(null);
    this.dailyChallengeBestResult = null;
    this.trackPersonalBestResult = null;
    this.trackPersonalBestByTrackKey = Object.create(null);
    this.personalBestPaceBaselineByRaceId = Object.create(null);
    this.activePersonalBestPaceBaseline = null;
    this.pbGhost = new PbGhost({ enabled: getPbGhostEnabled() });
    this.pbGhostService = new PbGhostService();
    this.pbGhostSizeCapture = (shouldExposeDebugHooks() || shouldCapturePbGhostSize())
      ? new PbGhostSizeCapture()
      : null;
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
    /** colour -> per-alpha-step particle lists, reused every frame to avoid render churn. */
    this._particleBuckets = new Map();
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
      onTracksTabChange: (tab) => {
        if (tab === "campaign") {
          void this.invokeModeMethod("campaign", "openCampaignTracks");
          return;
        }
        void this.invokeModeMethod("daily", "openDailyChallengePlaylist");
      },
      getModalShell: () => this.modal,
    });
    this.startOverlay = new StartOverlay({
      dailyChallengeUi: this.dailyChallengeUi,
    });
    this.selectedDailyChallengeId = null;
    this.dailyCarousel = new TrackCarousel({
      idPrefix: "daily-carousel",
      onSelect: (challenge, card) => this.handleDailyCarouselSelect(challenge, card),
      onOpenLeaderboard: (challenge) => this.openDailyCarouselStandings(challenge),
      onSettle: (card) => this.handleDailyCarouselSettled(card),
      resolveExpiry: (card) => getDailyChallengeExpiry(card?.challenge),
      getPreviewCarImage: () => (
        this.carSpriteAssetKey ? this.carSprite : null
      ),
      getPreviewCarAssetKey: () => this.carSpriteAssetKey || "loading",
      getPreviewCarWorldSize: () => ({
        width: (
          this.carSpriteDrawWidth * (CONFIG.carSpriteRenderScale ?? 1)
        ) / CONFIG.gridSize,
        height: (
          this.carSpriteDrawHeight * (CONFIG.carSpriteRenderScale ?? 1)
        ) / CONFIG.gridSize,
      }),
    });
    // The rail paints the rank it was given, so a day that takes a new snapshot --
    // from the standings, from a verified run, from a swipe -- repaints here. The
    // paint itself is dropped unless the Daily lobby is the visible screen.
    subscribeToDailyChallengeSnapshots(() => {
      if (this.activeRaceMode !== "daily") return;
      void this.invokeModeMethod("daily", "repaintDailyCarouselFromCache");
    });
    this.campaignCarousel = new TrackCarousel({
      idPrefix: "campaign-carousel",
      onSelect: (stage) => this.handleCampaignCarouselSelect(stage),
      onOpenLeaderboard: (stage) => void this.openCampaignStandings(stage, {
        returnMode: "close",
      }),
      onSettle: (card) => this.handleCampaignCarouselSettled(card),
      getPreviewCarImage: () => (
        this.carSpriteAssetKey ? this.carSprite : null
      ),
      getPreviewCarAssetKey: () => this.carSpriteAssetKey || "loading",
      getPreviewCarWorldSize: () => ({
        width: (
          this.carSpriteDrawWidth * (CONFIG.carSpriteRenderScale ?? 1)
        ) / CONFIG.gridSize,
        height: (
          this.carSpriteDrawHeight * (CONFIG.carSpriteRenderScale ?? 1)
        ) / CONFIG.gridSize,
      }),
    });
    this.lobbyUi = new LobbyUi({
      onSelectDaily: () => void this.activateMode("daily"),
      onCarouselNavigate: (mode, direction) => (
        mode === "campaign"
          ? this.campaignCarousel.handleNavDirection(direction)
          : this.dailyCarousel.handleNavDirection(direction)
      ),
      onSelectCampaign: () => void this.activateMode("campaign"),
      onBack: () => this.showHomeLobby(),
      onOpenStandings: (mode) => this.openVisibleLobbyStandings(mode),
      onOpenTracks: (mode) => {
        if (mode === "campaign") {
          this.invokeModeMethod("campaign", "openCampaignTracks");
          return;
        }
        if (mode === "daily") {
          void this.openDailyChallengePlaylist();
        }
      },
      onStartCampaign: () => void this.invokeModeMethod(
        "campaign",
        "startCampaignStage",
        this.campaignCarousel.getSelectedChallenge(),
      ),
      onAcceptChallenge: () => void this.invokeModeMethod("challenge", "startHeadToHead"),
      onRetryChallenge: () => void this.invokeModeMethod("challenge", "retryHeadToHead"),
      onRenderChallengePreview: (canvas, card, options) => {
        const aspect = getTrackAspectRatio(card.trackKey);
        if (canvas?.parentElement && aspect) {
          canvas.parentElement.style.setProperty(
            "--challenge-track-aspect",
            String(aspect),
          );
        }
        return fitTrackPreviewCanvas(canvas, card, {
          ...options,
          cacheNamespace: "challenge-poster",
          carImage: this.carSpriteAssetKey ? this.carSprite : null,
          carAssetKey: this.carSpriteAssetKey || "loading",
          carWorldSize: {
            width: (
              this.carSpriteDrawWidth * (CONFIG.carSpriteRenderScale ?? 1)
            ) / CONFIG.gridSize,
            height: (
              this.carSpriteDrawHeight * (CONFIG.carSpriteRenderScale ?? 1)
            ) / CONFIG.gridSize,
          },
        });
      },
    });
    this.hud = new RaceHud({
      getTrackPersonalBest: () => this.bestLapTime,
      getCurrentTrackKey: () => this.currentTrackKey,
      persistTrackPersonalBest: ({ bestLapTime }) => {
        this.bestLapTime = bestLapTime;
      },
    });
    this.modalContent = new ModalContentUi();
    this.trackReadyPromise = Promise.resolve(null);
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
      previewShare: (payload) => {
        if (payload?.kind === "head-to-head") {
          return previewHeadToHead(payload);
        }
        if (payload?.kind === "challenge-brag") {
          return previewHeadToHeadBrag(payload);
        }
        if (payload?.kind === "challenge-comment") {
          return previewHeadToHeadComment(payload);
        }
        return previewDailyChallengeShare(payload);
      },
      confirmShare: async (shareToken, request) => {
        if (request?.kind === "head-to-head") {
          const response = await createHeadToHead(
            shareToken,
            request?.source === "daily" ? { replay: request.replay } : {},
          );
          if (response?.ok) this.applyCarUnlockSnapshot?.(response.body?.carUnlocks);
          return response;
        }
        if (request?.kind === "challenge-brag") {
          return confirmHeadToHeadBrag(shareToken);
        }
        if (request?.kind === "challenge-comment") {
          return confirmHeadToHeadComment(shareToken);
        }
        return confirmDailyChallengeShare(shareToken);
      },
    });
    this.leaderboards = new LeaderboardsUi({
      showRunsModal: (...args) => this.modal.showRunsModal(...args),
      dailyChallengeUi: this.dailyChallengeUi,
      onStartDailyChallenge: (challenge, options = {}) => {
        void this.invokeModeMethod("daily", "handleStartDailyChallenge", challenge, options);
      },
      onRaceOpponent: (challenge, entry) => this.prepareAndStartLeaderboardOpponent({
        mode: "daily",
        competitionId: challenge?.id,
        entry,
      }),
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
      onPausePlacementChanged: () => {
        this.hud.syncPauseControls();
      },
      onHideHudChanged: () => {
        this.hud.syncPauseControls();
      },
      onPbGhostChanged: (enabled) => {
        this.pbGhost.setEnabled(enabled);
        this.requestRender();
      },
      onLeaderboardIdentityChanged: async () => {
        await this.invokeModeMethod("daily", "refreshDailyChallengeSummary", {
          forceRefresh: true,
        });
      },
      onPlayerPreferencesChanged: () => queuePlayerPreferencesSave(),
    });
    this.garage = new GarageUi({
      modal: this.modal,
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
      onStartDailyChallenge: () => this.handleDailyLobbyPrimaryAction(),
      onPauseRun: () => this.pauseActiveRun(),
    });
    this.interactions.bindModalViewToggles();
    this.interactions.bindModalActionRowPointerFocus();
    this.interactions.bindPrimaryActions();
    this.dailyChallengeUi.bindPlaylistModal();
    this.dailyCarousel.bind();
    const openDailyTracks = () => void this.openDailyChallengePlaylist();
    this.dailyCarousel.expiryLine?.addEventListener("click", openDailyTracks);
    this.dailyCarousel.navigation?.addEventListener("click", openDailyTracks);
    this.campaignCarousel.bind();
    const openCampaignTracks = () => void this.invokeModeMethod(
      "campaign",
      "openCampaignTracks",
    );
    this.campaignCarousel.navigation?.addEventListener("click", openCampaignTracks);
    this.lobbyUi.bind();
    this.garage.bind();
    this.hud.setPauseVisible(false);

    this.playerHistoryPromise = null;
    this.dailyChallengePromise = Promise.resolve(null);
    this.initialPbGhostAssetPromise = Promise.resolve(null);
    this.initialCampaignLaunchPromise = Promise.resolve(null);
    this.initialChallengeLobbyPromise = null;

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
        // Standings move while the app sits in the background, so every saved
        // snapshot needs the server again before it can stand in for a request.
        clearDailyChallengeSnapshotFreshness();
        void this.leaderboards?.refreshDailyChallengeAfterResume?.(challengeId);
        const visibleChallengeId =
          this.dailyCarousel?.getSelectedChallengeId?.() || challengeId;
        if (this.activeRaceMode === "daily" && visibleChallengeId) {
          void this.invokeModeMethod(
            "daily",
            "ensureDailyCarouselRank",
            visibleChallengeId,
          );
        }
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
    // Both are no-op stubs in the shipped build; see `vite.config.js`.
    exposePbGhostSizeDebugHooks(this);
    if (shouldExposeDebugHooks()) {
      exposeTestHooks(this);
    }

    this.lastTime = this.getNow();
    this.requestFrame();
    if (autoStart) {
      queueMicrotask(() => {
        void this.startInitialStartup().catch((error) => {
          console.error("Initial startup failed:", error);
        });
      });
    }
  }

  get carSpriteAssetKey() {
    return this.carSpriteLoader.currentAssetKey;
  }

  async displayInitialModeReady(mode) {
    if (mode === "daily") {
      this.showDailyLobby();
    } else if (mode === "campaign") {
      this.showCampaignLobby({ refresh: false });
    } else if (mode !== "challenge") {
      // The Head to Head pane is already painted by the challenge load itself.
      this.showHomeLobby();
    }
    this.startOverlay.setReady(true);
    this.startOverlay.setInteractive(true);
  }

  startInitialStartup({ retry = false } = {}) {
    if (this.initialStartupPromise) return this.initialStartupPromise;
    this._initialStartupFailed = false;
    this.startInitialModeFetches({ retry });

    const startupPromise = runInitialStartupPlan({
      mode: this.launchTarget.mode,
      prepareRuntime: (mode) => this.installModeRuntime(mode),
      startGraphics: (mode, phases) => this.loadStartupGraphics(mode, phases),
      startRaceData: (mode) => this.loadStartupRaceData(mode, { retry }),
      onPhase: ({ progress, label }) => this.loadingScreen.showPhase({ progress, label }),
      onReady: async ({ mode }) => {
        await this.displayInitialModeReady(mode);
        await this.loadingScreen.dismiss();
        void this.journeys.appReady();
        this.loadSecondaryStartupData();
      },
      onError: ({ mode, error }) => {
        this._initialStartupFailed = true;
        console.error(`Error preparing initial ${mode} mode:`, error);
        // Name the mode and the reason: "could not load" alone tells a player
        // nothing about whether waiting, retrying, or coming back later helps.
        const reason = typeof error?.message === "string" && error.message.trim()
          ? error.message.trim()
          : "";
        this.loadingScreen.showError(
          [`Could not load ${MODE_LABELS[mode] ?? "the game"}.`, reason].filter(Boolean).join(" "),
          () => this.retryInitialStartup(),
        );
      },
    });

    this.initialStartupPromise = startupPromise.finally(() => {
      if (this._initialStartupFailed) this.initialStartupPromise = null;
    });
    return this.initialStartupPromise;
  }

  /**
   * The mode's contract names the track to draw, so both startup groups share one
   * request: whichever asks first creates it.
   */
  ensureInitialContract(mode) {
    this.initialContractPromise ??= Promise.resolve().then(() => {
      if (mode === "daily") {
        this.dailyChallengePromise = this.loadDailyChallengeCritical({
          prepareTrack: false,
          loadPersonalBest: false,
          throwOnError: true,
        });
        return this.dailyChallengePromise;
      }
      if (mode === "campaign") {
        // Campaign progress decides the stage, so identity has to settle first.
        this.initialCampaignLaunchPromise = this.loadStartupPlayer()
          .then(() => this.prepareInitialCampaignLaunch({
            prepareTrack: false,
            loadPersonalBest: false,
          }));
        return this.initialCampaignLaunchPromise;
      }
      if (mode === "challenge") {
        if (!this.launchTarget.challengeId) {
          throw new Error("Head to Head challenge is missing.");
        }
        this.initialChallengeLobbyPromise = Promise.resolve(
          this.loadChallengeLobby(this.launchTarget.challengeId),
        );
        return this.initialChallengeLobbyPromise;
      }
      return null;
    });
    return this.initialContractPromise;
  }

  async resolveInitialTrackKey(mode) {
    if (mode === "home") return DEFAULT_TRACK_KEY;
    // Head to Head prepares its target track and opponent ghost inside its own load.
    if (mode === "challenge") return null;
    const contract = await this.ensureInitialContract(mode);
    const trackKey = mode === "daily" ? contract?.trackKey : contract?.stage?.trackKey;
    if (!trackKey) throw new Error(`The ${mode} launch has no playable track.`);
    return trackKey;
  }

  /** Track and fonts. The car starts here but does not hold the splash. */
  async loadStartupGraphics(mode, { onContractPhase, onTrackPhase } = {}) {
    // The car is named by local preferences and the fonts are already in flight, so
    // neither has to queue behind the round trips the track key waits on. A profile
    // that names a different skin supersedes this load rather than racing it.
    this.carAssetPromise = this.syncCarSpriteAsset();
    const fontsReadyPromise = globalThis.document?.fonts?.ready;

    onContractPhase?.();
    const trackKey = await this.resolveInitialTrackKey(mode);

    onTrackPhase?.();
    this.trackReadyPromise = trackKey
      ? this.loadTrack(trackKey, {
        loadPlayerProgress: false,
        showStartOverlayOnReset: false,
        preserveDailyChallengeContext: mode !== "home",
      })
      : this.ensureInitialContract(mode);
    await Promise.all([
      this.trackReadyPromise,
      fontsReadyPromise,
    ]);
  }

  /** Account plus the selected mode's contract. Ghosts start here; they do not hold the splash. */
  async loadStartupRaceData(mode, { retry = false } = {}) {
    const [result] = await Promise.all([
      this.ensureInitialContract(mode),
      this.loadStartupPlayer({ retry }),
    ]);
    if (mode === "daily") {
      this.initialPbGhostAssetPromise = this.loadInitialPersonalBestGhostAsset();
      // The rank of the day the player lands on, asked for while the track is still
      // loading, so the first card carries a real number. The splash never waits on
      // it: a late answer repaints the card through the snapshot subscription.
      if (result?.id) {
        void getDailyChallengeSnapshot({ challengeId: result.id }).catch((error) => {
          console.error("Error loading the opening daily challenge standings:", error);
        });
      }
    } else if (mode === "campaign" && result?.stage) {
      this.initialPbGhostAssetPromise = this.loadInitialCampaignPersonalBest?.(result.stage);
    }
    return result;
  }

  /** Starts Daily/Head to Head and account requests while the selected mode file is still arriving. */
  startInitialModeFetches({ retry = false } = {}) {
    const mode = this.launchTarget?.mode;
    this.loadStartupPlayer({ retry });
    if (mode === "daily") {
      this.initialDailyChallengeRequestPromise ??= getActiveDailyChallenge();
      return;
    }
    if (mode === "challenge" && this.launchTarget?.challengeId) {
      this.initialHeadToHeadRequestPromise ??= getHeadToHead(this.launchTarget.challengeId);
    }
  }

  loadStartupPlayer({ retry = false } = {}) {
    if (this.playerHistoryPromise && !retry) return this.playerHistoryPromise;
    this.playerHistoryPromise = getPlayerProgressState({ promptOnSyncFailure: true }).then(async (progressState) => {
      const result = await this.applyPlayerProgressState(progressState);
      if (progressState.authoritative === false) this.schedulePlayerProfileRecovery();
      return result;
    });
    return this.playerHistoryPromise;
  }

  retryInitialStartup() {
    if (!this._initialStartupFailed) return this.initialStartupPromise;
    this.initialStartupPromise = null;
    this.initialContractPromise = null;
    this.initialDailyChallengeRequestPromise = null;
    this.initialHeadToHeadRequestPromise = null;
    return this.startInitialStartup({ retry: true });
  }

  handleDailyLobbyPrimaryAction() {
    return this.invokeModeMethod(
      "daily",
      "handleStartDailyChallenge",
      this.dailyCarousel.getSelectedChallenge(),
      { startSource: "main_menu" },
    );
  }

  async applyPersistedPlayerPreferences(playerPreferences, { loadCar = true } = {}) {
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
    this.settings.refreshPausePlacementPanel();
    this.settings.refreshHideHudPanel();
    this.settings.refreshPbGhostPanel();
    this.hud.syncPauseControls();
    this.garage.syncSkinSelection();
    this.garage.syncTrailSelection();
    if (loadCar) await this.syncCarSpriteAsset();
    this.requestRender();
  }

  applyCarUnlockSnapshot(snapshot, { authoritative = true } = {}) {
    // A missing snapshot is a response that never carried unlocks, not a claim that everything is locked.
    if (!snapshot) return;
    setPlayerCarUnlockSnapshot(snapshot, { authoritative });
    this.garage?.refreshCarUnlocks?.();
  }

  getNow() {
    return performance.now() + this.timeOffsetMs;
  }

  async activateMode(mode, options = {}) {
    await this.installModeRuntime(mode);
    if (mode === "daily") return this.showDailyLobby(options);
    if (mode === "campaign") return this.showCampaignLobby(options);
    if (mode === "challenge") {
      return this.loadChallengeLobby(options.challengeId || this.launchTarget?.challengeId || null);
    }
    return this.showHomeLobby();
  }

  async invokeModeMethod(mode, method, ...args) {
    const startsRace = [
      "handleStartDailyChallenge",
      "startCampaignStage",
      "startHeadToHead",
      "retryHeadToHead",
    ].includes(method);
    if (startsRace && isVerificationQueueSubmissionBlocked()) return null;
    await this.ensureModeRuntime(mode);
    if (startsRace && isVerificationQueueSubmissionBlocked()) return null;
    const handler = this[method];
    if (typeof handler !== "function") return null;
    return handler.call(this, ...args);
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
      mode: this.activeRaceMode === "home" ? "daily" : this.activeRaceMode,
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

  loadSecondaryStartupData() {
    if (this._secondaryStartupStarted) return;
    this._secondaryStartupStarted = true;
    const secondaryModes = selectModeSecondaryStartupTasks(this.launchTarget.mode);
    this.dailyChallengeSummaryPromise = Promise.resolve(this.prefetchModeRuntime("daily"))
      .then(() => this.invokeModeMethod("daily", "refreshDailyChallengeSummary"))
      .catch((error) => {
        console.error("Error loading daily challenge summary:", error);
        return null;
      })
      .finally(() => {
        this.dailyChallengeUi.refreshDailyChallengeVerificationState();
      });
    window.setTimeout(() => {
      for (const mode of secondaryModes) {
        void this.prefetchModeRuntime(mode)
          .then(() => {
            if (mode === "daily") {
              return this.invokeModeMethod("daily", "prefetchDailyChallengePlaylist");
            }
            if (mode === "campaign") {
              return this.invokeModeMethod("campaign", "ensureCampaignBootstrap");
            }
            return null;
          })
          .catch((error) => {
            console.error(`Error warming the ${mode} runtime:`, error);
          });
      }
    }, 0);
    if (this.playerProfileAuthoritative) {
      this.scheduleVerificationQueueProcessing(0);
    }
  }
}

Object.assign(
  RealTimeRacer.prototype,
  trackEngineMethods,
  raceEngineMethods,
  legacyDailyChallengeEngineMethods,
  scoreboardEngineMethods,
  opponentRaceEngineMethods,
  modeRouterEngineMethods,
  playerProfileEngineMethods,
);
