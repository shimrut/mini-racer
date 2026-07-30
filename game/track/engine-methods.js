import { CONFIG } from "../config.js";
import { TRACKS } from "./tracks.js";
import {
  getTrackCanvasAsset,
  getTrackRuntimeAsset,
} from "./assets.js";
import {
  createDailyChallengePresentationEvent,
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "./presentation.js";
import { configureCanvasViewport } from "./canvas-resolution.js";
import {
  readCanvasDevicePixelRatio,
} from "./environment.js";
import { getPlayerProgressState } from "../storage.js";

const CANVAS_RESIZE_SETTLE_MS = 120;

export const trackEngineMethods = {
  getTrackPresentation(
    trackKey = this.currentTrackKey,
    { surface = TRACK_PRESENTATION_SURFACES.RACE } = {},
  ) {
    return resolveTrackPresentation(trackKey, {
      surface,
      event: createDailyChallengePresentationEvent(this.activeDailyChallenge),
    });
  },

  async refreshTrackPresentation(trackLoadRequestId = this.trackLoadRequestId) {
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
    this.syncTrackLayerBitmap(trackLoadRequestId);
    this.requestRender();
  },

  resetFrameTimingHistory() {
    this.frameTimeHistory = [];
    this.frameTimeHistoryIndex = 0;
    this.frameTimeTotal = 0;
  },

  updateTrackLayerViewportSize(devicePixelRatio = null) {
    this.trackLayer.updateViewportSize(
      this.container,
      devicePixelRatio || readCanvasDevicePixelRatio(),
    );
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
    this.updateTrackLayerViewportSize(devicePixelRatio);
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
      preserveRaceComparisonTarget = false,
      showStartOverlayOnReset = true,
    } = {},
  ) {
    const nextTrack = TRACKS[trackKey];
    if (!nextTrack) return;

    const requestId = ++this.trackLoadRequestId;
    this.currentTrack = nextTrack;
    this.currentTrackKey = trackKey;
    this.pbGhost?.clearTrack?.();
    this.preparedPbGhostChallengeId = null;
    if (!preserveDailyChallengeContext) {
      this.clearDailyChallengeRun();
    }


    const runtime = getTrackRuntimeAsset(trackKey, this.currentTrack, {
      qualityLevel: this.qualityLevel,
      frameSkip: this.frameSkip,
    });
    this.setLoadingStatus(60, "Building Track...");
    this.activeGeometry.outer = runtime.outer;
    this.activeGeometry.inner = runtime.inner;
    this.collisionSegments = runtime.collisionSegments;
    this.collisionHash = runtime.collisionHash;
    this.setLoadingStatus(75, "Syncing Graphics...");
    await this.refreshTrackPresentation(requestId);

    this.bestLapTime = null;
    this.syncCurrentRunPolicy();

    this.hud.setBestTime(this.bestLapTime, {
      persistToTrackCard: false,
    });

    if (!loadPlayerProgress) {
      this.reset(false, {
        preserveRaceComparisonTarget,
        showStartOverlay: showStartOverlayOnReset,
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

    this.reset(false, { preserveRaceComparisonTarget });
    if (
      document.activeElement &&
      typeof document.activeElement.blur === "function"
    ) {
      document.activeElement.blur();
    }
  },

  resetCanvasPresentation() {
    [this.trackLayerCanvas, this.canvas].forEach((canvas) => {
      if (!canvas) return;
      canvas.classList.remove("canvas-opacity-instant");
      canvas.style.transition = "";
      canvas.style.opacity = "1";
    });
  },


  async syncTrackLayerBitmap(trackLoadRequestId = this.trackLoadRequestId) {
    if (!this.trackCanvas) return;
    await this.trackLayer.syncBitmap({
      trackCanvas: this.trackCanvas,
      trackCanvasOrigin: this.trackCanvasOrigin,
      offTrackColor:
        this.currentTrackPresentation?.offTrackColor || CONFIG.offTrackColor,
      presentation: this.currentTrackPresentation || null,
      trackLoadRequestId,
      currentTrackLoadRequestId: this.trackLoadRequestId,
    });
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
