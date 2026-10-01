import {
  getTrackCanvasAsset,
  getTrackRuntimeAsset,
} from "./assets.js";
import { getLoadedClientTrack, loadClientTrack } from "./client-registry.js";
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
import { ensureStoredTracks, isTrackLayoutConfirmed } from './stored-track-service.js';
import { createRacePreparation, PREPARATION_SLOTS } from './race-preparation.js';
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

  findPreparedRaceTrack(trackKey, challenge = null) {
    return this._racePreparation?.findRecord(trackKey, challenge) ?? null;
  },

  // A race can start at once with a prepared record, or with the installed
  // track while it is current and its layout is confirmed.
  isRaceTrackReady(trackKey, challenge = null) {
    if (this.findPreparedRaceTrack(trackKey, challenge)) return true;
    return hasCurrentTrackDefinition(this, trackKey)
      && (!this.raceTrackNeedsConfirmation(trackKey, challenge) || isTrackLayoutConfirmed(trackKey));
  },

  // Start is enabled as soon as the track's layout is checked. A track that
  // is not drawn yet is drawn when Start is pressed, while the lobby stays.
  canStartRaceTrack(trackKey, challenge = null) {
    return this.isRaceTrackReady(trackKey, challenge)
      || !this.raceTrackNeedsConfirmation(trackKey, challenge)
      || isTrackLayoutConfirmed(trackKey);
  },

  // A race start never asks the server for a ready track. A track that is not
  // ready is prepared first, while the current screen stays, so no race
  // starts on an unconfirmed layout. Gives the record to install, or null for
  // the installed track.
  async readyRaceTrack(slot, trackKey, challenge = null) {
    const record = this.findPreparedRaceTrack(trackKey, challenge);
    if (record) return record;
    if (this.isRaceTrackReady(trackKey, challenge)) return null;
    const prepared = await this.prepareRaceTrack(slot, { trackKey, challenge });
    if (!prepared) throw new Error('Another race replaced this one before its track was ready.');
    return prepared;
  },

  // Confirms the layouts of a lobby's tracks in one request, before its cards
  // load. Confirmed keys send nothing. Start never sends this request.
  confirmRaceTracks(trackKeys = []) {
    const keys = trackKeys.filter((trackKey) => typeof trackKey === 'string' && trackKey
      && !trackKey.startsWith('community:'));
    if (!keys.length || isLocalEnvironment()) return;
    void ensureStoredTracks(keys, { requireConfirmation: true })
      .catch((error) => {
        console.warn('The lobby tracks could not be confirmed:', error);
      })
      .finally(() => this.syncRaceStartReadiness?.());
  },

  // Prepares the card that a lobby carousel stopped on, so that Start runs
  // with no drawing. A swipe to another card stops the build.
  prepareSelectedRaceTrack(mode, { trackKey, challenge = null, isStillSelected = () => true } = {}) {
    if (typeof trackKey !== 'string' || !trackKey) return;
    const token = (this._selectedPreparationToken || 0) + 1;
    this._selectedPreparationToken = token;
    const wanted = () => this._selectedPreparationToken === token && isStillSelected();
    void this.prepareRaceTrack(PREPARATION_SLOTS.SELECTED, {
      trackKey,
      challenge,
      beforeBuild: () => wanted(),
    }).catch((error) => {
      if (!wanted()) return;
      console.error('Could not prepare the selected race track:', error);
      this.lobbyUi?.setRaceStartError?.(mode, 'Track failed to load. Tap Retry Start.');
    });
  },

  // Each lobby enables Start only when its selected race track is prepared.
  syncRaceStartReadiness() {
    this.syncDailyStartReadiness?.();
    this.syncCampaignStartReadiness?.();
  },

  getTrackPresentation(
    trackKey = this.currentTrackKey,
    { surface = TRACK_PRESENTATION_SURFACES.RACE } = {},
  ) {
    const track = trackKey === this.currentTrackKey
      ? this.currentTrack
      : getLoadedClientTrack(trackKey);
    return resolveTrackPresentation(trackKey, {
      surface,
      event: createDailyChallengePresentationEvent(this.activeDailyChallenge),
      ground: track?.ground,
    });
  },

  async refreshTrackPresentation() {
    if (!this.currentTrackKey || !this.currentTrack) return;

    const presentation = this.getTrackPresentation(this.currentTrackKey, {
      surface: TRACK_PRESENTATION_SURFACES.RACE,
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
    } = {},
  ) {
    const requestId = ++this.trackLoadRequestId;
    // A prepared record installs at once: no load, no build and no wait.
    const record = prepared?.trackKey === trackKey ? prepared : null;
    const nextTrack = record ? record.track : await loadClientTrack(trackKey);
    if (!nextTrack) throw new Error('The track layout could not be confirmed. Retry before racing.');
    if (requestId !== this.trackLoadRequestId) return;
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
      this.requestRender();
    } else {
      await this.refreshTrackPresentation();
    }
    if (requestId !== this.trackLoadRequestId) return;

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
