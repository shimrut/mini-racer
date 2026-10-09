import { CONFIG } from "./config.js";
import { DEFAULT_TRACK_KEY } from "./track/catalog.js";
import { getLoadedClientTrack } from "./track/client-registry.js";
import {
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "./track/presentation.js";
import { RingBuffer } from "./race/ring-buffer.js";
import { createTyreTrackBuffer } from "./race/ground-effects.js";
import {
  getPlayerProgressState,
} from "./player/progress-state.js";
import { isVerificationQueueSubmissionBlocked } from "./scoreboard/verification-queue.js";
import { getActivePlayerOwnerId } from "./player/active-owner.js";
import { confirmCampaignResultsShare, previewCampaignResultsShare, readSelectedCampaignSeriesId } from "./campaign/service.js";
import { createRunPolicy } from "./race/run-policy.js";
import {
  detectDevicePerformance,
  shouldExposeDebugHooks,
  readCanvasDevicePixelRatio,
} from "./track/environment.js";
import { ReplayRecorder } from "./race/replay.js";
import { SteeringInput } from "./race/steering-input.js";
import { createCarSprite } from "./car/sprite.js";
import { CarSpriteLoader, getCarSpriteCacheKey } from "./car/sprite.js";
import { normalizePhysicsConfig } from "./car/handling.js";
import { getTrackGround, getTrackGroundMaxSpeedKph } from "./track/grounds.js";
import { readPlayerCarSkinAssetName, setPlayerCarUnlockSnapshot } from "./car/player-car-skin.js";
import { readPlayerCarPaint } from "./car/player-car-paint.js";
import { readPlayerCarDecalStyle } from "./car/player-car-decals.js";
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
import { PREPARATION_SLOTS, plainRaceChallenge } from "./track/race-preparation.js";
import { raceEngineMethods } from "./race/engine-methods.js";
import { scoreboardEngineMethods } from "./scoreboard/engine-methods.js";
import { opponentRaceEngineMethods } from "./scoreboard/opponent-race-engine-methods.js";
import { modeRouterEngineMethods } from "./modes/engine-methods.js";
import { communityEngineMethods } from "./community/engine-methods.js";
import { playerProfileEngineMethods } from "./player/engine-methods.js";
import { createCarEffectsAudio } from "./audio/car-effects-audio.js";
import { createMedalEffectsAudio } from "./audio/medal-effects-audio.js";
import { createProceduralMusic } from "./audio/procedural-music.js";
import { getCollisionAutoRestartEnabled } from "./settings/collision-auto-restart-preference.js";
import { getCollisionRestartDelaySec } from "./settings/collision-restart-delay-preference.js";
import { isQuickRestartActive } from "./settings/quick-restart-preference.js";
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
  isDailyRaceWarmupCurrent,
  previewDailyChallengeShare,
  subscribeToDailyChallengeSnapshots,
} from "./daily-challenge/service.js";
import {
  concedesHeadToHead,
  confirmHeadToHeadComment,
  confirmHeadToHeadBrag,
  createHeadToHead,
  getHeadToHead,
  getNextHeadToHead,
  previewHeadToHeadComment,
  previewHeadToHead,
  previewHeadToHeadBrag,
} from "./head-to-head/service.js";

const testDailyRuntimeEngineMethods = import.meta.env.MODE === "test"
  ? {
    ...(await import("./challenge-run/engine-methods.js")).challengeRunEngineMethods,
    ...(await import("./daily-challenge/engine-methods.js")).dailyChallengeEngineMethods,
  }
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
    this.drawnCar = null;
    this.carSpriteLoader = new CarSpriteLoader();
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
      ground: this.currentTrack.ground,
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
    this.campaignSeriesId = this.launchTarget.mode === 'campaign'
      ? this.launchTarget.seriesId || null
      : null;
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
    this.tyreTracks = createTyreTrackBuffer();
    this.routeTrace = new RingBuffer(480, () => ({ x: 0, y: 0 }));
    this.routeTraceStrokeStyle = readPlayerTrailStrokeStyle(this.getSelectedCarAssetName());
    this.particles = [];
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
      maxSpeedKph: getTrackGroundMaxSpeedKph(this.runtimeConfig.maxSpeed, this.currentTrack),
      slipRatio: 0,
      throttleBlocked: false,
    });
    this.proceduralMusic?.syncFrame?.({
      status: this.status,
      speed: 0,
      maxSpeedKph: getTrackGroundMaxSpeedKph(this.runtimeConfig.maxSpeed, this.currentTrack),
      ground: getTrackGround(this.currentTrack).key,
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
    const previewCarOptions = {
      getPreviewCarImage: (card) => this.getPreviewCar(card?.trackKey).image,
      getPreviewCarAssetKey: (card) => this.getPreviewCar(card?.trackKey).key,
      getPreviewCarWorldSize: () => ({
        width: (
          this.carSpriteDrawWidth * (CONFIG.carSpriteRenderScale ?? 1)
        ) / CONFIG.gridSize,
        height: (
          this.carSpriteDrawHeight * (CONFIG.carSpriteRenderScale ?? 1)
        ) / CONFIG.gridSize,
      }),
    };
    this.dailyCarousel = new TrackCarousel({
      idPrefix: "daily-carousel",
      onSelect: (challenge, card) => this.handleDailyCarouselSelect(challenge, card),
      onOpenLeaderboard: (challenge) => this.openDailyCarouselStandings(challenge),
      onSettle: (card) => this.handleDailyCarouselSettled(card),
      resolveExpiry: (card) => getDailyChallengeExpiry(card?.challenge),
      ...previewCarOptions,
    });
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
      ...previewCarOptions,
    });
    this.lobbyUi = new LobbyUi({
      onSelectDaily: () => void this.activateMode("daily"),
      onSelectCommunity: () => this.showCommunityLobby(),
      onLoadMoreCommunity: () => void this.loadCommunityMaps({ more: true }),
      onRefreshCommunity: () => void this.loadCommunityMaps(),
      onStartCommunity: (mapId) => void this.startCommunityMap(mapId),
      onCarouselNavigate: (mode, direction) => (
        mode === "campaign"
          ? this.campaignCarousel.handleNavDirection(direction)
          : this.dailyCarousel.handleNavDirection(direction)
      ),
      onSelectCampaign: () => void this.activateMode("campaign", { view: "series" }),
      onOpenCampaignSeries: (seriesId) => void this.invokeModeMethod(
        "campaign",
        "openCampaignSeries",
        seriesId,
      ),
      onBackToCampaignSeries: () => void this.invokeModeMethod("campaign", "backToCampaignSeries"),
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
          carImage: this.getPreviewCar(card?.trackKey).image,
          carAssetKey: this.getPreviewCar(card?.trackKey).key,
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
    this.modal = new ModalShell({
      content: this.modalContent,
      getLeaderboards: () => this.leaderboards,
      getCurrentTrackKey: () => this.currentTrackKey,
      getDefaultPrimaryAction: () => () => this.reset(true),
      cancelLeaderboardRequests: () => this.leaderboards?.cancelPendingRequests(),
      playUnlockSound: (tier) => this.medalEffectsAudio?.scheduleMedalUnlock?.(tier),
      getGarageUi: () => this.garage,
      getRedditUsername: () => this.redditUsername,
      previewShare: async (payload) => {
        if (payload?.kind === "campaign-finished") {
          if (payload.ownerPlayerId !== getActivePlayerOwnerId()) {
            return { ok: false, body: { error: 'Your account changed. Reopen the Campaign to share.' } };
          }
          return previewCampaignResultsShare(payload);
        }
        if (payload?.kind === "head-to-head") {
          return previewHeadToHead(payload);
        }
        if (payload?.kind === "challenge-brag") {
          return previewHeadToHeadBrag(payload);
        }
        if (payload?.kind === "challenge-comment") {
          const response = await previewHeadToHeadComment(payload);
          if (concedesHeadToHead(payload, response?.body)) this.recordHeadToHeadConcede?.();
          return response;
        }
        return previewDailyChallengeShare(payload);
      },
      confirmShare: async (shareToken, request) => {
        if (request?.kind === "campaign-finished") {
          if (request.ownerPlayerId !== getActivePlayerOwnerId()) {
            return { ok: false, body: { error: 'Your account changed. Reopen the Campaign to share.' } };
          }
          return confirmCampaignResultsShare(shareToken);
        }
        if (request?.kind === "head-to-head") {
          const response = await createHeadToHead(shareToken, { replay: request.replay });
          if (response?.ok) this.applyCarUnlockSnapshot?.(response.body?.carUnlocks);
          return response;
        }
        if (request?.kind === "challenge-brag") {
          return confirmHeadToHeadBrag(shareToken);
        }
        if (request?.kind === "challenge-comment") {
          const response = await confirmHeadToHeadComment(shareToken);
          if (concedesHeadToHead(request, response?.body)) this.recordHeadToHeadConcede?.();
          return response;
        }
        return confirmDailyChallengeShare(shareToken);
      },
      getNextChallenge: async ({ challengeId } = {}) => getNextHeadToHead({ challengeId }),
    });
    this.leaderboards = new LeaderboardsUi({
      showRunsModal: (...args) => this.modal.showRunsModal(...args),
      dailyChallengeUi: this.dailyChallengeUi,
      onStartDailyChallenge: (challenge, options = {}) => {
        void this.invokeModeMethod("daily", "handleStartDailyChallenge", challenge, options);
      },
      onRaceOpponent: (challenge, entry, options) => this.prepareAndStartLeaderboardOpponent({
        mode: "daily",
        competitionId: challenge?.id,
        entry,
        watch: options?.watch === true,
      }),
      isRunsViewActive: () => this.modal.isRunsViewActive?.(),
      updateModalScoreboardSnapshot: (snapshot) => this.modal.updateModalScoreboardSnapshot?.(snapshot),
      updateModalLeaderboardDayOptions: (options) => this.modal.updateModalLeaderboardDayOptions?.(options),
    });
    this.collisionAutoRestartEnabled = getCollisionAutoRestartEnabled();
    this.quickRestartEnabled = isQuickRestartActive();
    this.pauseTapTimer = null;
    this.quickRestartTapListener = null;
    this.collisionRestartDelaySec = getCollisionRestartDelaySec();
    this.settings = new SettingsUi({
      modal: this.modal,
      onCollisionAutoRestartChanged: (value) => {
        this.collisionAutoRestartEnabled = value;
      },
      onQuickRestartChanged: (value) => {
        this.quickRestartEnabled = value;
      },
      onCollisionRestartDelayChanged: (value) => {
        this.collisionRestartDelaySec = value;
      },
      onCarAudioChanged: (enabled) => {
        this.carEffectsAudio?.setEnabled?.(enabled);
        this.syncCarEffectsAudioFrame();
      },
      onMusicChanged: (enabled) => {
        this.proceduralMusic?.setEnabled?.(enabled);
        this.proceduralMusic?.syncFrame?.({
          status: this.status,
          speed: this.cachedSpeed,
          maxSpeedKph: getTrackGroundMaxSpeedKph(this.runtimeConfig.maxSpeed, this.currentTrack),
          ground: getTrackGround(this.currentTrack).key,
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
      onTrailStrokeStyleChanged: () => {
        this.syncCarTrailStyle();
        this.requestRender();
      },
      onPlayerPreferencesChanged: () => queuePlayerPreferencesSave(),
    });
    this.interactions = new InteractionsUi({
      modal: this.modal,
      startOverlay: this.startOverlay,
      leaderboards: this.leaderboards,
      onStartDailyChallenge: () => this.handleDailyLobbyPrimaryAction(),
      onPauseRun: (event) => this.handlePauseTap(event),
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

  // The car a track card shows: the player's skin for that track's ground.
  // Skins other than the one in the race load once and then repaint cards.
  getPreviewCar(trackKey) {
    const track = trackKey === this.currentTrackKey
      ? this.currentTrack
      : getLoadedClientTrack(trackKey);
    const assetName = readPlayerCarSkinAssetName(getTrackGround(track).key);
    const paint = readPlayerCarPaint(assetName);
    const decalStyle = readPlayerCarDecalStyle(assetName);
    const visualKey = getCarSpriteCacheKey(assetName, { paint, decalStyle });
    if (visualKey === this.carSpriteLoader.currentVisualKey) {
      return { image: this.carSprite, key: visualKey };
    }
    if (!this.previewCarSprites) this.previewCarSprites = new Map();
    let entry = this.previewCarSprites.get(assetName);
    if (!entry || entry.key !== visualKey) {
      entry = { image: null, key: visualKey };
      this.previewCarSprites.set(assetName, entry);
      new CarSpriteLoader().load(assetName, {
        paint,
        decalStyle,
        onLoaded: (image) => {
          entry.image = image;
          this.dailyCarousel?.refreshPreviews?.();
          this.campaignCarousel?.refreshPreviews?.();
        },
        onError: () => {
          this.previewCarSprites.delete(assetName);
        },
      });
    }
    return entry.image
      ? { image: entry.image, key: visualKey }
      : { image: null, key: "loading" };
  }

  async displayInitialModeReady(mode) {
    if (mode === "daily") {
      this.rememberRaceModeWarmup(mode, {
        challenge: this.currentDailyChallenge,
        playlist: this._loadedDailyPlaylist,
      });
      this.showDailyLobby();
    } else if (mode === "campaign") {
      this.rememberRaceModeWarmup(mode, {
        bootstrap: this.campaignVerifiedBootstrap ?? this.campaignBootstrap,
        stage: this.activeCampaignStage,
      });
      this.showCampaignLobby({
        refresh: false,
        view: this.launchTarget?.seriesId ? "stages" : "series",
      });
    } else if (mode !== "challenge") {
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

  getRaceModeWarmupKey(mode) {
    return JSON.stringify([
      getActivePlayerOwnerId(),
      this._raceModeProfileRevision || 0,
      this.playerProfileAuthoritative !== false,
      mode === "campaign" ? this.campaignSeriesId || readSelectedCampaignSeriesId() : null,
      mode === "daily" ? Math.floor(Date.now() / 86_400_000) : null,
    ]);
  }

  getRaceModeWarmup(mode) {
    const state = this._raceModeWarmups?.get(mode);
    if (!state || state.key !== this.getRaceModeWarmupKey(mode)) return null;
    if (mode === "daily" && state.result
      && !isDailyRaceWarmupCurrent(state.result.challenge, state.loadedAt)) return null;
    return state;
  }

  rememberRaceModeWarmup(mode, result) {
    this._raceModeWarmups ??= new Map();
    this._raceModeWarmups.set(mode, {
      key: this.getRaceModeWarmupKey(mode), result, loadedAt: Date.now(),
    });
    return result;
  }

  getReadyRaceMode(mode) {
    const result = this.getRaceModeWarmup(mode)?.result;
    if (!result) return null;
    if (mode === "campaign" && (
      !this._campaignBootstrapReady
      || this._campaignBootstrapContextKey !== this.getRaceModeWarmupKey(mode)
      || result.bootstrap !== this.campaignVerifiedBootstrap
      || result.bootstrap?.authoritative === false
      || result.bootstrap?.availability === "unavailable"
    )) return null;
    const challenge = mode === "daily" ? result.challenge : plainRaceChallenge(result.stage?.trackKey);
    const trackKey = challenge?.trackKey;
    const choices = mode === "daily" ? result.playlist : result.bootstrap?.stages;
    if (!trackKey || !Array.isArray(choices) || !choices.length
      || !choices.every((choice) => this.isRaceTrackReady(choice.trackKey, mode === "daily" ? choice : null))) return null;
    const prepared = this.findPreparedRaceTrack(trackKey, challenge);
    return prepared ? { ...result, prepared } : null;
  }

  // Retain completed contracts as well as pending work. Assets are checked
  // separately, so a changed layout/options rebuilds locally without refetching
  // an otherwise current contract. Background warming never selects a mode.
  warmRaceMode(mode) {
    this._raceModeWarmups ??= new Map();
    const current = this.getRaceModeWarmup(mode);
    if (current?.promise) return current.promise;
    const ready = this.getReadyRaceMode(mode);
    if (ready) return Promise.resolve(ready);
    const key = this.getRaceModeWarmupKey(mode);
    const loadedAt = Date.now();
    const method = mode === "daily" ? "warmDailyRaceDefinitions" : "warmCampaignRaceDefinitions";
    const promise = Promise.resolve(this.prefetchModeRuntime(mode))
      .then((runtime) => {
        const warm = runtime?.methods?.[method] ?? this[method];
        return typeof warm === "function" ? warm.call(this, {
          challenge: mode === "daily" ? current?.result?.challenge : null,
        }) : null;
      })
      .then((result) => {
        if (key !== this.getRaceModeWarmupKey(mode)) return this.warmRaceMode(mode);
        if (mode === "daily" && result
          && !isDailyRaceWarmupCurrent(result.challenge, loadedAt)) {
          throw new Error("The Daily changed while loading. Retry before racing.");
        }
        if (this._raceModeWarmups.get(mode)?.promise === promise && result) {
          this.rememberRaceModeWarmup(mode, result);
        }
        return result;
      })
      .catch((error) => {
        if (key !== this.getRaceModeWarmupKey(mode)) return this.warmRaceMode(mode);
        throw error;
      })
      .finally(() => {
        if (this._raceModeWarmups.get(mode)?.promise !== promise) return;
        if (current?.result) this._raceModeWarmups.set(mode, current);
        else this._raceModeWarmups.delete(mode);
      });
    this._raceModeWarmups.set(mode, { ...current, key, promise });
    return promise;
  }

  // The races that each entry point prepares before its loader closes. The
  // first one becomes the track on screen.
  async resolveInitialRaceTargets(mode) {
    if (mode === "challenge" || mode === "home") return [];
    const contract = await this.ensureInitialContract(mode);
    if (mode === "daily") {
      if (!contract?.trackKey) throw new Error("The daily launch has no playable track.");
      return [{ slot: PREPARATION_SLOTS.DAILY, trackKey: contract.trackKey, challenge: contract }];
    }
    if (mode === "campaign") {
      const stage = contract?.stage;
      if (!stage?.trackKey) throw new Error("The campaign launch has no playable track.");
      return [{
        slot: PREPARATION_SLOTS.CAMPAIGN,
        trackKey: stage.trackKey,
        challenge: plainRaceChallenge(stage.trackKey),
      }];
    }
    return [];
  }

  // Prepares every target at the same time, then puts the first one on
  // screen. A target that cannot be prepared fails the loader, which offers
  // Retry.
  async prepareInitialRaceTracks(mode, targets) {
    const records = await Promise.all(
      targets.map((target) => this.prepareRaceTrack(target.slot, target)),
    );
    await this.loadTrack(targets[0]?.trackKey ?? DEFAULT_TRACK_KEY, {
      loadPlayerProgress: false,
      showStartOverlayOnReset: false,
      preserveDailyChallengeContext: mode !== "home",
      prepared: records[0] ?? null,
    });
  }

  async loadStartupGraphics(mode, { onContractPhase, onTrackPhase } = {}) {
    void this.syncCarSpriteAsset();
    const fontsReadyPromise = globalThis.document?.fonts?.ready;

    onContractPhase?.();
    const targets = await this.resolveInitialRaceTargets(mode);

    onTrackPhase?.();
    this.trackReadyPromise = mode === "challenge"
      ? this.ensureInitialContract(mode)
      : this.prepareInitialRaceTracks(mode, targets);
    await Promise.all([
      this.trackReadyPromise,
      fontsReadyPromise,
    ]);
  }

  async loadStartupRaceData(mode, { retry = false } = {}) {
    const [result] = await Promise.all([
      this.ensureInitialContract(mode),
      this.loadStartupPlayer({ retry }),
    ]);
    if (mode === "daily") {
      void this.loadInitialPersonalBestGhostAsset();
      if (result?.id) {
        void getDailyChallengeSnapshot({ challengeId: result.id }).catch((error) => {
          console.error("Error loading the opening daily challenge standings:", error);
        });
      }
    } else if (mode === "campaign" && result?.stage) {
      void this.loadInitialCampaignPersonalBest?.(result.stage);
    }
    return result;
  }

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
    );
  }

  async applyPersistedPlayerPreferences(playerPreferences, { loadCar = true } = {}) {
    if (!applyPlayerPreferences(playerPreferences)) return;

    this.collisionAutoRestartEnabled = getCollisionAutoRestartEnabled();
    this.quickRestartEnabled = isQuickRestartActive();
    this.collisionRestartDelaySec = getCollisionRestartDelaySec();
    this.carEffectsAudio?.setEnabled?.(getCarProceduralAudioEnabled());
    this.proceduralMusic?.setEnabled?.(getMusicEnabled());
    this.pbGhost.setEnabled(getPbGhostEnabled());
    raceEngineMethods.syncCarTrailStyle.call(this, { resetTrace: true, seedTrace: false });
    this.settings.refreshCarAudioPanel();
    this.settings.refreshMusicPanel();
    this.settings.refreshCollisionAutoRestartPanel();
    this.settings.refreshQuickRestartPanel();
    this.settings.refreshCollisionRestartDelayPanel();
    this.settings.refreshPausePlacementPanel();
    this.settings.refreshHideHudPanel();
    this.settings.refreshPbGhostPanel();
    this.hud.syncPauseControls();
    this.garage.syncSkinSelection();
    if (loadCar) await this.syncCarSpriteAsset();
    this.requestRender();
  }

  applyCarUnlockSnapshot(snapshot, { authoritative = true } = {}) {
    if (!snapshot) return;
    setPlayerCarUnlockSnapshot(snapshot, { authoritative });
    this.garage?.refreshCarUnlocks?.();
  }

  getNow() {
    return performance.now() + this.timeOffsetMs;
  }

  async activateMode(mode, options = {}) {
    if (mode === "home") return this.showHomeLobby();
    const token = (this._modeEntryToken || 0) + 1;
    this._modeEntryToken = token;
    this._modeEntryPending = true;
    this.cancelRacePreparation?.();
    let ready = this.getReadyRaceMode(mode);
    let showingLoader = !ready;
    const showLoader = () => this.loadingScreen?.begin?.(`Loading ${MODE_LABELS[mode] ?? "the game"}…`);
    if (showingLoader) showLoader();
    try {
      // Import first so an entry cancelled during the download cannot install
      // its runtime over the mode the player chose afterward.
      await this.prefetchModeRuntime?.(mode);
      if (token !== this._modeEntryToken) return null;
      await this.installModeRuntime(mode);
      if (token !== this._modeEntryToken) return null;
      if (mode === "challenge") {
        await this.loadChallengeLobby(options.challengeId || this.launchTarget?.challengeId || null);
      } else {
        let warmed;
        let contextKey;
        do {
          contextKey = this.getRaceModeWarmupKey(mode);
          ready = this.getReadyRaceMode(mode);
          if (!ready && !showingLoader) {
            showingLoader = true;
            showLoader();
          }
          warmed = ready ?? await this.warmRaceMode(mode);
          if (token !== this._modeEntryToken) return null;
        } while (contextKey !== this.getRaceModeWarmupKey(mode)
          || (mode === "campaign" && this.campaignVerifiedBootstrap
            && warmed?.bootstrap !== this.campaignVerifiedBootstrap));
        if (mode === "daily") {
          if (!warmed?.challenge) throw new Error("No playable Daily is available.");
          this.currentDailyChallenge = warmed.challenge;
          this.setDailyChallengeLobbySummary(warmed.challenge);
          this.showDailyLobby(options);
        } else if (mode === "campaign") {
          if (!warmed?.stage) throw new Error("Campaign progress is not authoritative.");
          if (this.campaignVerifiedBootstrap !== warmed.bootstrap) {
            this.applyCampaignLobbyBootstrap(warmed.bootstrap, { paint: false });
          }
          this.showCampaignLobby({ ...options, refresh: false });
        }
      }
      if (token !== this._modeEntryToken) return null;
      this._modeEntryPending = false;
      await this.loadingScreen?.dismiss?.();
    } catch (error) {
      if (token !== this._modeEntryToken) return null;
      console.error(`Could not enter ${mode}:`, error);
      if (!showingLoader) showLoader();
      this.loadingScreen?.showError?.(
        `Could not load ${MODE_LABELS[mode] ?? "the game"}. Retry before racing.`,
        () => void this.activateMode(mode, options),
      );
    }
  }

  reportRaceBlockedByTransfer(mode) {
    this.lobbyUi?.setRaceStartError?.(
      mode,
      "Finishing your progress transfer. Racing continues once it is done.",
    );
  }

  async invokeModeMethod(mode, method, ...args) {
    const startsRace = [
      "handleStartDailyChallenge",
      "startCampaignStage",
      "startHeadToHead",
      "retryHeadToHead",
    ].includes(method);
    if (startsRace && isVerificationQueueSubmissionBlocked()) {
      this.reportRaceBlockedByTransfer(mode);
      return null;
    }
    await this.ensureModeRuntime(mode);
    if (startsRace && isVerificationQueueSubmissionBlocked()) {
      this.reportRaceBlockedByTransfer(mode);
      return null;
    }
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
      this.hud.setMaxSpeed(getTrackGroundMaxSpeedKph(this.runtimeConfig.maxSpeed, this.currentTrack));
    }
    this.hud?.setGround?.(getTrackGround(this.currentTrack).key);
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
    void Promise.resolve()
      .then(() => {
        // A summary updates race context, so refresh it only for the visible
        // Daily. Home/background warming only populates definition/asset caches.
        if (this.activeRaceMode !== "daily") return null;
        return this.invokeModeMethod("daily", "refreshDailyChallengeSummary");
      })
      .catch((error) => {
        console.error("Error loading daily challenge summary:", error);
        return null;
      })
      .finally(() => {
        this.dailyChallengeUi.refreshDailyChallengeVerificationState();
      });
    window.setTimeout(() => {
      for (const mode of secondaryModes) {
        void this.warmRaceMode(mode)
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
  testDailyRuntimeEngineMethods,
  scoreboardEngineMethods,
  opponentRaceEngineMethods,
  modeRouterEngineMethods,
  communityEngineMethods,
  playerProfileEngineMethods,
);
