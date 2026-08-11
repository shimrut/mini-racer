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
import { createCarEffectsAudio } from "./audio/car-effects-audio.js";
import { createMedalEffectsAudio } from "./audio/medal-effects-audio.js";
import { createProceduralMusic } from "./audio/procedural-music.js";
import { getCollisionAutoRestartEnabled } from "./settings/collision-auto-restart-preference.js";
import { getCollisionRestartDelaySec } from "./settings/collision-restart-delay-preference.js";
import { getCarProceduralAudioEnabled } from "./settings/car-audio-preference.js";
import { getMusicEnabled } from "./settings/music-preference.js";
import { getPbGhostEnabled } from "./settings/pb-ghost-preference.js";
import { selectModeCriticalStartupPromises, selectModeSecondaryStartupTasks } from "./startup/coordinator.js";
import { PbGhost } from "./ghost/pb-ghost.js";
import { PbGhostService } from "./ghost/pb-ghost-service.js";
import {
  getLargestPbGhostSizeReport,
  PB_GHOST_SIZE_ENABLED_STORAGE_KEY,
  PbGhostSizeCapture,
  shouldCapturePbGhostSize,
} from "./ghost/pb-ghost-size-debug.js";
import { JourneyService } from "./journeys/service.js";
import {
  applyPlayerPreferences,
  queuePlayerPreferencesSave,
} from "./player/preferences.js";
import {
  confirmDailyChallengeShare,
  previewDailyChallengeShare,
} from "./daily-challenge/service.js";

// The legacy Daily mixin remains available to unit tests that exercise the
// prototype directly. Production loads it through runtime-loader.js so Daily
// is not part of the first mode chunk for Campaign or Head-to-Head launches.
const legacyDailyChallengeEngineMethods = import.meta.env.MODE === "test"
  ? (await import("./daily-challenge/engine-methods.js")).dailyChallengeEngineMethods
  : {};

export const STARTUP_GATE_TIMEOUT_MS = 20_000;

export function waitForStartupGate(
  startupPromises,
  timeoutMs = STARTUP_GATE_TIMEOUT_MS,
) {
  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });

  return Promise.race([
    Promise.allSettled(startupPromises),
    timeout,
  ]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

export function addCampaignBootstrapToStartupGate(
  startupPromises,
  launchTarget,
  ensureCampaignBootstrap,
  playerHistoryPromise = startupPromises[0],
) {
  if (
    launchTarget?.mode !== "campaign"
    || typeof ensureCampaignBootstrap !== "function"
  ) {
    return startupPromises;
  }

  const initialBootstrap = ensureCampaignBootstrap({ forceRefresh: true });
  const identitySafeBootstrap = Promise.resolve(initialBootstrap).then(async (bootstrap) => {
    if (bootstrap?.authoritative !== false) return bootstrap;
    await playerHistoryPromise;
    return ensureCampaignBootstrap({ forceRefresh: true });
  });

  return [...startupPromises, identitySafeBootstrap];
}

export function startInitialHeadToHeadLaunch(
  launchTarget,
  loadChallengeLobby,
) {
  if (
    launchTarget?.mode !== "challenge"
    || !launchTarget.challengeId
    || typeof loadChallengeLobby !== "function"
  ) {
    return null;
  }
  return loadChallengeLobby(launchTarget.challengeId);
}

export function selectStartupGateForLaunch(
  startupPromises,
  launchTarget,
  initialChallengeLobbyPromise,
  challengeDependencies = [],
) {
  if (launchTarget?.mode !== "challenge" || !initialChallengeLobbyPromise) {
    return startupPromises;
  }
  return [initialChallengeLobbyPromise, ...challengeDependencies];
}

export class RealTimeRacer {
  constructor({ launchTarget = null, ensureModeRuntime = null, initialTrack = null } = {}) {
    this.canvas = document.getElementById("gameCanvas");
    this.setLoadingStatus(10, "Initializing Engine...");
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
    this.carAssetPromise = this.syncCarSpriteAsset();
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
    this.campaignLobbyState = null;
    this._campaignBootstrapReady = false;
    this._campaignBootstrapPromise = null;
    this._campaignBootstrapRequestId = 0;
    this.launchTarget = launchTarget || resolveGameLaunchTarget();
    this.ensureModeRuntime = typeof ensureModeRuntime === "function"
      ? ensureModeRuntime
      : async () => null;
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
    this.selectedDailyChallengeId = null;
    this.dailyCarousel = new TrackCarousel({
      idPrefix: "daily-carousel",
      onSelect: (challenge, card) => this.handleDailyCarouselSelect(challenge, card),
      onOpenLeaderboard: (challenge) => this.openDailyCarouselStandings(challenge),
      onSettle: (card) => this.handleDailyCarouselSettled(card),
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
    // Nothing to wait for since the track draws on the main thread into the race
    // canvas; the gate keeps the slot so startup ordering stays explicit.
    this.trackReadyPromise = Promise.resolve();
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
          return this.previewHeadToHead(payload);
        }
        if (payload?.kind === "challenge-brag") {
          return this.previewHeadToHeadBrag(payload);
        }
        return previewDailyChallengeShare(payload);
      },
      confirmShare: (shareToken, request) => {
        if (request?.kind === "head-to-head") {
          return this.confirmHeadToHead(shareToken, request);
        }
        if (request?.kind === "challenge-brag") {
          return this.confirmHeadToHeadBrag(shareToken);
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
      onStartDailyChallenge: () => this.invokeModeMethod(
        "daily",
        "handleStartDailyChallenge",
        this.dailyCarousel.getSelectedChallenge(),
        { startSource: "main_menu" },
      ),
      onPauseRun: () => this.pauseActiveRun(),
    });
    this.interactions.bindModalViewToggles();
    this.interactions.bindModalActionRowPointerFocus();
    this.interactions.bindPrimaryActions();
    this.dailyChallengeUi.bindPlaylistModal();
    this.dailyCarousel.bind();
    this.campaignCarousel.bind();
    this.lobbyUi.bind();
    this.garage.bind();
    this.hud.setPauseVisible(false);

    this.setLoadingStatus(30, "Fetching Profile...");
    this.playerHistoryPromise = getPlayerProgressState()
      .then(async ({
        hasAnyData,
        isReturningPlayer,
        playerPreferences,
        redditUsername,
        carUnlocks,
      }) => {
        this.setLoadingStatus(50, "Profile Loaded...");
        this.hasAnyData = Boolean(hasAnyData);
        this.isReturningPlayer = Boolean(isReturningPlayer);
        this.redditUsername = typeof redditUsername === "string" && redditUsername.trim()
          ? redditUsername.trim()
          : null;
        this.applyCarUnlockSnapshot(carUnlocks);
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
    if (this.launchTarget.mode === "challenge") {
      this.setLoadingStatus(70, "Loading Challenge...");
    }
    const initialChallengeLobbyPromise = startInitialHeadToHeadLaunch(
      this.launchTarget,
      (challengeId) => typeof this.loadChallengeLobby === "function"
        ? this.loadChallengeLobby(challengeId)
        : Promise.resolve(null),
    );
    this.initialChallengeLobbyPromise = initialChallengeLobbyPromise?.catch((error) => {
      console.error("Error displaying initial Head to Head lobby:", error);
      this.activeHeadToHead = null;
      this.showHomeLobby();
    }) ?? null;
    this.dailyChallengePromise = this.launchTarget.mode === "daily"
      && typeof this.loadDailyChallengeCritical === "function"
      ? this.loadDailyChallengeCritical()
      : Promise.resolve(null);
    this.initialPbGhostAssetPromise = this.launchTarget.mode === "daily"
      && typeof this.loadInitialPersonalBestGhostAsset === "function"
      ? this.loadInitialPersonalBestGhostAsset()
      : Promise.resolve(null);
    this.initialCampaignLaunchPromise = this.launchTarget.mode === "campaign"
      && typeof this.prepareInitialCampaignLaunch === "function"
      ? this.prepareInitialCampaignLaunch()
      : Promise.resolve(null);
    if (this.launchTarget.mode === "campaign") {
      this.setLoadingStatus(70, "Loading Campaign...");
    }
    const startupPromises = selectModeCriticalStartupPromises(this.launchTarget.mode, {
      playerHistory: this.playerHistoryPromise,
      carAsset: this.carAssetPromise,
      trackReady: this.trackReadyPromise,
      dailyChallenge: this.dailyChallengePromise,
      personalBestGhost: this.initialPbGhostAssetPromise,
      campaignLaunch: this.initialCampaignLaunchPromise,
      challengeLobby: this.initialChallengeLobbyPromise,
    });
    waitForStartupGate(startupPromises).finally(async () => {
      this.loadingScreen.update(95, "Displaying Lobby...");
      try {
        if (this.launchTarget.mode === "challenge") {
          if (!this.initialChallengeLobbyPromise) this.showHomeLobby();
        } else {
          this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        }
        if (this.launchTarget.mode === "daily") {
          this.showDailyLobby();
        } else if (this.launchTarget.mode === "campaign") {
          this.showCampaignLobby({ refresh: false });
        } else if (this.launchTarget.mode !== "challenge") {
          this.showHomeLobby();
        }
      } catch (error) {
        console.error("Error displaying initial lobby:", error);
        try {
          this.activeHeadToHead = null;
          this.showHomeLobby();
        } catch (fallbackError) {
          console.error("Error displaying fallback lobby:", fallbackError);
        }
      } finally {
        try {
          this.startOverlay.setReady(true);
        } catch (error) {
          console.error("Error marking lobby ready:", error);
        }
        try {
          await this.loadingScreen.dismiss();
        } catch (error) {
          console.error("Error dismissing loading screen:", error);
        }
        try {
          this.startOverlay.setInteractive(true);
        } catch (error) {
          console.error("Error enabling lobby interaction:", error);
        }
        try {
          void this.journeys.appReady();
        } catch (error) {
          console.error("Error reporting app readiness:", error);
        }
        try {
          this.loadSecondaryStartupData();
        } catch (error) {
          console.error("Error loading secondary startup data:", error);
        }
      }
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
    this.exposePbGhostSizeDebugHooks();
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

  applyCarUnlockSnapshot(snapshot) {
    setPlayerCarUnlockSnapshot(snapshot);
    this.garage?.refreshCarUnlocks?.();
  }

  getNow() {
    return performance.now() + this.timeOffsetMs;
  }

  async activateMode(mode, options = {}) {
    await this.ensureModeRuntime(mode);
    if (mode === "daily") return this.showDailyLobby(options);
    if (mode === "campaign") return this.showCampaignLobby(options);
    if (mode === "challenge") {
      return this.loadChallengeLobby(options.challengeId || this.launchTarget?.challengeId || null);
    }
    return this.showHomeLobby();
  }

  async invokeModeMethod(mode, method, ...args) {
    await this.ensureModeRuntime(mode);
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


  exposeTestHooks() {
    const renderGameToText = () => this.renderGameToText();
    const advanceTime = (ms) => this.advanceTime(ms);
    const getPbGhostSizeReports = () => (
      this.pbGhostSizeCapture?.getReports?.() || []
    );
    const getLastPbGhostSizeReport = () => (
      this.pbGhostSizeCapture?.getLastReport?.() || null
    );
    const getLargestPbGhostSizeReportForDebug = () => (
      getLargestPbGhostSizeReport(this.pbGhostSizeCapture?.getReports?.() || [])
    );

    window.__RACER_DEBUG__ = Object.freeze({
      renderGameToText,
      advanceTime,
      getPbGhostSizeReports,
      getLastPbGhostSizeReport,
      getLargestPbGhostSizeReport: getLargestPbGhostSizeReportForDebug,
    });
    window.render_game_to_text = renderGameToText;
    window.advanceTime = advanceTime;
  }

  exposePbGhostSizeDebugHooks() {
    window.__PB_GHOST_SIZE_DEBUG__ = Object.freeze({
      enabled: () => Boolean(this.pbGhostSizeCapture),
      enable: () => {
        try {
          window.localStorage?.setItem(PB_GHOST_SIZE_ENABLED_STORAGE_KEY, '1');
        } catch (_error) {
        }
        this.pbGhostSizeCapture ??= new PbGhostSizeCapture();
        return true;
      },
      getReports: () => this.pbGhostSizeCapture?.getReports?.() || [],
      getLastReport: () => this.pbGhostSizeCapture?.getLastReport?.() || null,
      getLargestReport: () => getLargestPbGhostSizeReport(
        this.pbGhostSizeCapture?.getReports?.() || [],
      ),
    });
  }

  renderGameToText() {
    return JSON.stringify({
      coordinateSystem:
        "origin top-left, x increases right, y increases down, units are track-grid cells",
      mode: this.status,
      lobbyMode: this.lobbyUi?.getMode?.() || null,
      raceMode: this.activeRaceMode,
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
      lapTime: Number(this.currentTime.toFixed(3)),
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
      campaignRaceId: this.activeCampaignStage?.raceId || null,
      playerChallengeId: this.activeHeadToHead?.challengeId || null,
      raceComparison: this.raceComparisonTarget
        ? {
            displayName: this.raceComparisonTarget.displayName,
            finishTimeSec: this.raceComparisonTarget.finishTimeSec,
            rank: this.raceComparisonTarget.rank,
            carAssetName: this.raceComparisonTarget.carAssetName,
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
    const secondaryModes = selectModeSecondaryStartupTasks(this.launchTarget.mode);
    this.dailyChallengeSummaryPromise = Promise.resolve(this.ensureModeRuntime("daily"))
      .then(() => this.refreshDailyChallengeSummary?.())
      .catch((error) => {
        console.error("Error loading daily challenge summary:", error);
        return null;
      })
      .finally(() => {
        this.dailyChallengeUi.refreshDailyChallengeVerificationState();
      });
    window.setTimeout(() => {
      for (const mode of secondaryModes) {
        void this.ensureModeRuntime(mode)
          .then(() => {
            if (mode === "daily") return this.prefetchDailyChallengePlaylist?.();
            if (mode === "campaign") return this.ensureCampaignBootstrap?.();
            return null;
          })
          .catch((error) => {
            console.error(`Error warming the ${mode} runtime:`, error);
          });
      }
    }, 0);
    this.scheduleVerificationQueueProcessing(0);
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
);
