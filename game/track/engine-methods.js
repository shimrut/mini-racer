import {
  getTrackCanvasAsset,
  getTrackRuntimeAsset,
} from "./assets.js";
import { getLoadedClientTrack, loadClientTrack, loadRaceDefinitions } from "./client-registry.js";
import { getTrackGround, getTrackGroundMaxSpeedKph } from "./grounds.js";
import {
  createDailyChallengePresentationEvent,
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "./presentation.js";
import { configureCanvasViewport } from "./canvas-resolution.js";
import {
  readCanvasDevicePixelRatio,
  isLocalEnvironment,
} from "./environment.js";
import { isTrackLayoutConfirmed } from './stored-track-service.js';
import { createRacePreparation, PREPARATION_SLOTS, raceAssetOptionsKey, resolveRacePresentation } from './race-preparation.js';
import { hasCurrentTrackDefinition } from './race-definition.js';
import { getPlayerProgressState } from "../player/progress-state.js";

const CANVAS_RESIZE_SETTLE_MS = 120;

export const trackEngineMethods = {
  // Community maps, local play and the mock Daily have no server layout.
  raceTrackNeedsConfirmation(trackKey, challenge = null) {
    return !(
      String(trackKey).startsWith('community:')
      || isLocalEnvironment()
      || challenge?.id === 'mock-daily-challenge-local'
    );
  },

  getRacePreparation() {
    if (!this._racePreparation) {
      this._racePreparation = createRacePreparation({
        getAssetOptions: () => ({ qualityLevel: this.qualityLevel, frameSkip: this.frameSkip }),
        needsConfirmation: (trackKey, challenge) => this.raceTrackNeedsConfirmation(trackKey, challenge),
      });
      this._racePreparation.subscribe(() => this.syncRaceStartReadiness?.());
    }
    return this._racePreparation;
  },

  // Prepares a race target in a slot. The promise gives the record, or null
  // when a newer target replaced it.
  prepareRaceTrack(slot, target) {
    return this.getRacePreparation().prepare(slot, target);
  },

  loadRaceDefinitions(trackKeys = [], { challenge = null } = {}) {
    return loadRaceDefinitions(trackKeys, {
      requireConfirmation: !isLocalEnvironment() && challenge?.id !== 'mock-daily-challenge-local',
    });
  },

  findPreparedRaceTrack(trackKey, challenge = null) {
    return this._racePreparation?.findRecord(trackKey, challenge) ?? null;
  },

  // Definitions are required before the menu becomes interactive. Other
  // tracks' walls and pictures can still build from the local asset caches.
  isRaceTrackReady(trackKey, challenge = null) {
    return Boolean(getLoadedClientTrack(trackKey))
      && (!this.raceTrackNeedsConfirmation(trackKey, challenge) || isTrackLayoutConfirmed(trackKey));
  },

  // All interactive tracks have a loaded authoritative definition. A picture
  // that is not cached yet builds locally while the lobby stays visible.
  canStartRaceTrack(trackKey, challenge = null) {
    return this.isRaceTrackReady(trackKey, challenge);
  },

  isInstalledRaceTrack(trackKey, challenge = null) {
    return hasCurrentTrackDefinition(this, trackKey)
      && this._installedRaceOptionsKey === raceAssetOptionsKey(this)
      && this.currentTrackPresentation?.key === resolveRacePresentation(trackKey, this.currentTrack, challenge).key;
  },

  // Start has no definition-loading fallback. Priority records retain their
  // assets; other tracks use the same local caches as before Redis.
  readyRaceTrack(slot, trackKey, challenge = null) {
    if (!this.isRaceTrackReady(trackKey, challenge)) {
      throw new Error('The race definitions are not loaded. Try the lobby again.');
    }
    return this.getRacePreparation().prepareLoaded(slot, { trackKey, challenge });
  },

  // Prepares the card that a lobby carousel stopped on, so that Start runs
  // with no drawing. A swipe to another card stops the build.
  prepareSelectedRaceTrack(mode, { trackKey, challenge = null, isStillSelected = () => true } = {}) {
    if (typeof trackKey !== 'string' || !trackKey) return;
    if (!this.canStartRaceTrack(trackKey, challenge)) return;
    const targetKey = `${mode}:${trackKey}:${challenge?.id ?? ''}:${challenge?.skin ?? 'default'}:${raceAssetOptionsKey(this)}`;
    if (this._selectedPreparation?.key === targetKey) {
      this._selectedPreparation.isStillSelected = isStillSelected;
      return this._selectedPreparation.promise;
    }
    const token = (this._selectedPreparationToken || 0) + 1;
    this._selectedPreparationToken = token;
    const selection = { key: targetKey, isStillSelected, promise: null };
    this._selectedPreparation = selection;
    const wanted = () => this._selectedPreparationToken === token && selection.isStillSelected();
    selection.promise = this.prepareRaceTrack(PREPARATION_SLOTS.SELECTED, {
      trackKey,
      challenge,
      beforeBuild: async () => {
        await new Promise((resolve) => {
          if (typeof requestIdleCallback === 'function') requestIdleCallback(resolve, { timeout: 500 });
          else setTimeout(resolve, 32);
        });
        return wanted();
      },
    }).catch((error) => {
      if (!wanted()) return;
      console.error('Could not prepare the selected race track:', error);
      this.lobbyUi?.setRaceStartError?.(mode, 'Track failed to load. Tap Retry Start.');
    }).finally(() => {
      if (this._selectedPreparation === selection) this._selectedPreparation = null;
    });
    return selection.promise;
  },

  cancelRacePreparation({ preservePrepared = false } = {}) {
    this._raceContinuationToken = (this._raceContinuationToken || 0) + 1;
    this._selectedPreparationToken = (this._selectedPreparationToken || 0) + 1;
    this._selectedPreparation = null;
    this._dailyPlaylistTrackPrewarmId = (this._dailyPlaylistTrackPrewarmId || 0) + 1;
    for (const slot of [PREPARATION_SLOTS.SELECTED, PREPARATION_SLOTS.NEXT]) {
      if (!preservePrepared || !this._racePreparation?.getSlotState(slot)?.ready) {
        this._racePreparation?.release(slot);
      }
    }
  },

  // Lobby buttons reflect definition availability, not asset-cache residency.
  syncRaceStartReadiness() {
    this.syncDailyStartReadiness?.();
    this.syncCampaignStartReadiness?.();
  },

  getTrackPresentation(
    trackKey = this.currentTrackKey,
    { surface = TRACK_PRESENTATION_SURFACES.RACE, challenge = this.activeDailyChallenge } = {},
  ) {
    const track = trackKey === this.currentTrackKey
      ? this.currentTrack
      : getLoadedClientTrack(trackKey);
    return resolveTrackPresentation(trackKey, {
      surface,
      event: createDailyChallengePresentationEvent(challenge),
      ground: track?.ground,
    });
  },

  async refreshTrackPresentation(challenge = this.activeDailyChallenge) {
    if (!this.currentTrackKey || !this.currentTrack) return;

    const presentation = this.getTrackPresentation(this.currentTrackKey, {
      surface: TRACK_PRESENTATION_SURFACES.RACE,
      challenge,
    });
    this.currentTrackPresentation = presentation;
    const trackCanvasRuntime = getTrackCanvasAsset(
      this.currentTrackKey,
      this.currentTrack,
      {
        qualityLevel: this.qualityLevel,
        frameSkip: this.frameSkip,
        presentation,
      },
    );
    this.trackCanvas = trackCanvasRuntime.canvas;
    this.trackCanvasOrigin = trackCanvasRuntime.origin;
    this._installedRaceOptionsKey = raceAssetOptionsKey(this);
    this.requestRender();
  },

  resetFrameTimingHistory() {
    this.frameTimeHistory = [];
    this.frameTimeHistoryIndex = 0;
    this.frameTimeTotal = 0;
  },

  scheduleResizeCommit() {
    this.isNarrowViewport = window.innerWidth <= 768;
    if (this.resizeCommitTimer !== null) {
      clearTimeout(this.resizeCommitTimer);
    }
    this.resizeCommitTimer = setTimeout(() => {
      this.resizeCommitTimer = null;
      this.resize();
    }, CANVAS_RESIZE_SETTLE_MS);
  },

  resize({ render = true } = {}) {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width <= 0 || height <= 0) return;

    const devicePixelRatio =
      typeof this.getCanvasDevicePixelRatio === "function"
        ? this.getCanvasDevicePixelRatio()
        : readCanvasDevicePixelRatio();
    const viewport = configureCanvasViewport(
      this.canvas,
      this.ctx,
      width,
      height,
      devicePixelRatio,
    );
    this.viewportWidth = viewport.cssWidth;
    this.viewportHeight = viewport.cssHeight;
    this.viewportDevicePixelRatio = viewport.devicePixelRatio;
    this.isNarrowViewport = window.innerWidth <= 768;
    if (render) {
      this.render(0, 1);
      this._needsRender = false;
    }
  },

  shouldAnimateFrame() {
    return this.status === "playing" || this.particles.length > 0;
  },

  requestFrame() {
    if (this._frameRequestId !== null) return;
    this._frameRequestId = requestAnimationFrame(this._boundLoop);
  },

  requestRender() {
    this._needsRender = true;
    this.requestFrame();
  },

  async loadTrack(
    trackKey,
    {
      loadPlayerProgress = true,
      preserveDailyChallengeContext = false,
      preserveDailyChallengeOnReset = false,
      preserveRaceComparisonTarget = false,
      showStartOverlayOnReset = true,
      prepared = null,
      keepScreen = false,
      loadedOnly = false,
      challenge = this.activeDailyChallenge,
      isStillCurrent = () => true,
    } = {},
  ) {
    if (!isStillCurrent()) return;
    const requestId = ++this.trackLoadRequestId;
    // A prepared record installs at once: no load, no build and no wait.
    const record = prepared?.trackKey === trackKey ? prepared : null;
    const nextTrack = record?.track ?? (loadedOnly ? getLoadedClientTrack(trackKey) : await loadClientTrack(trackKey));
    if (!nextTrack) throw new Error('The track layout could not be confirmed. Retry before racing.');
    if (requestId !== this.trackLoadRequestId || !isStillCurrent()) return;
    this.currentTrack = nextTrack;
    this.currentTrackKey = trackKey;
    if (this.hud && this.runtimeConfig?.maxSpeed) {
      this.hud.setMaxSpeed(getTrackGroundMaxSpeedKph(this.runtimeConfig.maxSpeed, nextTrack));
    }
    this.hud?.setGround?.(getTrackGround(nextTrack).key);
    // Each ground has its own car skin, so a new ground can need a new car.
    if (this.getSelectedCarAssetName?.() !== this.carSpriteAssetKey) {
      void this.syncCarSpriteAsset?.();
    }
    this.pbGhost?.clearTrack?.();
    this.preparedPbGhostChallengeId = null;
    if (!preserveDailyChallengeContext) {
      this.clearDailyChallengeRun();
    }


    const runtime = record?.runtime ?? getTrackRuntimeAsset(trackKey, this.currentTrack, {
      qualityLevel: this.qualityLevel,
      frameSkip: this.frameSkip,
    });
    this.activeGeometry.outer = runtime.outer;
    this.activeGeometry.inner = runtime.inner;
    this.collisionSegments = runtime.collisionSegments;
    this.collisionHash = runtime.collisionHash;
    if (record) {
      this.currentTrackPresentation = record.presentation;
      this.trackCanvas = record.canvasAsset.canvas;
      this.trackCanvasOrigin = record.canvasAsset.origin;
      this._installedRaceOptionsKey = record.optionsKey;
      this.requestRender();
    } else {
      await this.refreshTrackPresentation(challenge);
    }
    if (requestId !== this.trackLoadRequestId || !isStillCurrent()) return;

    this.bestLapTime = null;
    this.syncCurrentRunPolicy();

    this.hud.setBestTime(this.bestLapTime, {
      persistToTrackCard: false,
    });

    if (!loadPlayerProgress) {
      this.reset(false, {
        preserveDailyChallenge: preserveDailyChallengeOnReset,
        preserveRaceComparisonTarget,
        showStartOverlay: showStartOverlayOnReset,
        keepScreen,
      });
      if (
        document.activeElement &&
        typeof document.activeElement.blur === "function"
      ) {
        document.activeElement.blur();
      }
      return;
    }

    try {
      const { hasAnyData, isReturningPlayer } = await getPlayerProgressState();
      if (requestId !== this.trackLoadRequestId) return;
      this.hasAnyData = Boolean(hasAnyData);
      this.isReturningPlayer = Boolean(isReturningPlayer);
      this.hud.setBestTime(this.bestLapTime, {
        persistToTrackCard: false,
      });
    } catch (error) {
      console.error("Error loading track data:", error);
      if (requestId !== this.trackLoadRequestId) return;
      this.isReturningPlayer = false;
      this.hud.setBestTime(null);
    }

    this.reset(false, {
      preserveRaceComparisonTarget,
      preserveDailyChallenge: preserveDailyChallengeOnReset,
      keepScreen,
    });
    if (
      document.activeElement &&
      typeof document.activeElement.blur === "function"
    ) {
      document.activeElement.blur();
    }
  },

  drawVisibleTrackCanvas() {
    this.trackLayer.draw({
      camera: this.camera,
      zoom: this.zoom,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      devicePixelRatio: this.viewportDevicePixelRatio,
      trackCanvas: this.trackCanvas,
      trackCanvasOrigin: this.trackCanvasOrigin,
      presentation: this.currentTrackPresentation,
      container: this.container,
      fallbackWidth: this.canvas.width,
      fallbackHeight: this.canvas.height,
    });
  },
};
