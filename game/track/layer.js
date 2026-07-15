import { configureCanvasViewport } from "./canvas-resolution.js";
import { drawViewportPresentationBackground } from "./canvas.js";

/**
 * Manages the two-canvas track-layer rendering system.
 *
 * On capable browsers the track is rendered into an OffscreenCanvas
 * on a dedicated worker thread so the main thread never blocks on large blits.
 * When OffscreenCanvas is unavailable the renderer falls back to a regular
 * main-thread 2D context.
 *
 * The engine holds one instance and delegates setup, viewport resizing,
 * bitmap sync, and per-frame drawing through this class.
 */
export class TrackLayerRenderer {
  constructor(canvas) {
    /** The DOM trackLayerCanvas element. */
    this.canvas = canvas;
    /** Main-thread 2D context used when the worker path is unavailable. */
    this.ctx = null;
    /** OffscreenCanvas worker (null when running main-thread fallback). */
    this.worker = null;
    /** True once the worker has been successfully initialised. */
    this.workerReady = false;
    /** True once the worker has confirmed initialization. */
    this.workerActive = false;
    /** Monotonically-increasing counter; used to discard stale bitmaps. */
    this.bitmapVersion = 0;
    /** The current in-flight createImageBitmap promise (or null). */
    this.bitmapPromise = null;
    /** Callback for when the worker has received the track bitmap. */
    this.onTrackReady = null;
    this.renderMessage = {
      type: "render",
      camera: { x: 0, y: 0 },
      zoom: 1,
      viewport: {
        width: 0,
        height: 0,
        devicePixelRatio: 1,
      },
    };
  }

  /**
   * Initialises the renderer — either spawns an OffscreenCanvas worker or
   * falls back to a regular 2D context on the main thread.
   * Must be called once during engine construction.
   *
   * @param {{allowWorker?: boolean}} [options]
   */
  setup({ allowWorker = true } = {}) {
    const canUseOffscreenWorker = Boolean(
      allowWorker &&
        this.canvas &&
        typeof Worker !== "undefined" &&
        typeof this.canvas.transferControlToOffscreen === "function" &&
        typeof createImageBitmap === "function",
    );

    if (!canUseOffscreenWorker) {
      this.ctx =
        this.canvas?.getContext("2d", {
          alpha: false,
        }) ||
        this.canvas?.getContext("2d") ||
        null;
      return;
    }

    try {
      const offscreenCanvas = this.canvas.transferControlToOffscreen();
      this.worker = new Worker(
        new URL("./layer-worker.js", import.meta.url),
        { type: "module" },
      );
      this.worker.postMessage(
        { type: "init", canvas: offscreenCanvas },
        [offscreenCanvas],
      );
      this.worker.onmessage = (event) => {
        if (event.data?.type === "init-complete") {
          this.workerActive = true;
          this.onTrackReady?.(); // Resolve if already waiting
        }
        if (event.data?.type === "track-ready") {
          this.onTrackReady?.();
        }
      };
      this.worker.onerror = (error) => {
        console.error("Track layer worker error:", error);
        this.workerReady = false;
        this.workerActive = false;
        this.onTrackReady?.();
      };
      this.workerReady = true;
    } catch (error) {
      console.error("Error initializing track-layer worker:", error);
      this.worker = null;
      this.workerReady = false;
      this.ctx =
        this.canvas?.getContext("2d", {
          alpha: false,
        }) ||
        this.canvas?.getContext("2d") ||
        null;
    }
  }

  /**
   * Resizes the main-thread canvas to match the container.
   * For worker-backed renderers this is a no-op — the viewport is updated
   * inline with the render message in draw() so the clear and repaint happen
   * as one visible update.
   *
   * @param {HTMLElement} container - The game container element.
   * @param {number} devicePixelRatio
   */
  updateViewportSize(container, devicePixelRatio) {
    if (this.workerReady && this.worker) return;
    if (this.canvas && this.ctx) {
      configureCanvasViewport(
        this.canvas,
        this.ctx,
        container.clientWidth,
        container.clientHeight,
        devicePixelRatio,
      );
    }
  }

  /**
   * Creates an ImageBitmap from the pre-rendered track canvas and transfers it
   * to the worker. Aborts silently if the trackLoadRequestId no longer matches
   * (another track started loading while the bitmap was being created).
   *
   * @param {object} options
   * @param {HTMLCanvasElement} options.trackCanvas
   * @param {{x:number,y:number}} options.trackCanvasOrigin
   * @param {string} options.offTrackColor
   * @param {object|null} options.presentation
   * @param {number} options.trackLoadRequestId - ID of the load that produced trackCanvas.
   * @param {number} options.currentTrackLoadRequestId - Engine's current load ID (stale-check).
   */
  async syncBitmap({
    trackCanvas,
    trackCanvasOrigin,
    offTrackColor,
    presentation,
    trackLoadRequestId,
    currentTrackLoadRequestId,
  }) {
    if (
      !trackCanvas ||
      !this.worker ||
      !this.workerReady ||
      typeof createImageBitmap !== "function"
    ) {
      return;
    }

    const bitmapVersion = ++this.bitmapVersion;
    const bitmapPromise = createImageBitmap(trackCanvas);
    this.bitmapPromise = bitmapPromise;

    try {
      const bitmap = await bitmapPromise;
      if (
        trackLoadRequestId !== currentTrackLoadRequestId ||
        bitmapVersion !== this.bitmapVersion ||
        !this.worker
      ) {
        bitmap.close?.();
        return;
      }
      this.worker.postMessage(
        {
          type: "track",
          bitmap,
          origin: trackCanvasOrigin,
          offTrackColor,
          presentation,
        },
        [bitmap],
      );
    } catch (error) {
      console.error("Error syncing track-layer bitmap:", error);
    } finally {
      if (this.bitmapPromise === bitmapPromise) {
        this.bitmapPromise = null;
      }
    }
  }

  /**
   * Draws the visible portion of the track for one frame.
   *
   * Worker path: posts a render message so the worker composites the bitmap
   * at the right viewport offset.
   *
   * Main-thread path: blits the visible source rect from the pre-rendered
   * track canvas, preceded by a background fill for off-track areas.
   *
   * @param {object} options
   * @param {{x:number,y:number}} options.camera
   * @param {number} options.zoom
   * @param {number} options.viewportWidth  - CSS-pixel viewport width.
   * @param {number} options.viewportHeight - CSS-pixel viewport height.
   * @param {number} options.devicePixelRatio
   * @param {HTMLCanvasElement|null} options.trackCanvas
   * @param {{x:number,y:number}} options.trackCanvasOrigin
   * @param {object|null} options.presentation
   * @param {HTMLElement} options.container
   * @param {number} [options.fallbackWidth=0]  - Game canvas width; used when viewport dims are 0.
   * @param {number} [options.fallbackHeight=0] - Game canvas height; used when viewport dims are 0.
   */
  draw({
    camera,
    zoom,
    viewportWidth,
    viewportHeight,
    devicePixelRatio,
    trackCanvas,
    trackCanvasOrigin,
    presentation,
    container,
    fallbackWidth = 0,
    fallbackHeight = 0,
  }) {
    const worldLeft = camera.x;
    const worldTop = camera.y;

    const fallbackCssWidth =
      fallbackWidth > 0 ? fallbackWidth / Math.max(devicePixelRatio || 1, 1) : 0;
    const fallbackCssHeight =
      fallbackHeight > 0 ? fallbackHeight / Math.max(devicePixelRatio || 1, 1) : 0;

    const canvasWidth = this.workerReady
      ? viewportWidth || container.clientWidth
      : viewportWidth || container.clientWidth || fallbackCssWidth;
    const canvasHeight = this.workerReady
      ? viewportHeight || container.clientHeight
      : viewportHeight || container.clientHeight || fallbackCssHeight;

    if (this.workerReady && this.worker) {
      const message = this.renderMessage;
      message.camera.x = worldLeft;
      message.camera.y = worldTop;
      message.zoom = zoom;
      message.viewport.width = canvasWidth;
      message.viewport.height = canvasHeight;
      message.viewport.devicePixelRatio = devicePixelRatio;
      this.worker.postMessage(message);
      return;
    }

    const ctx = this.ctx;
    if (!ctx || !trackCanvas) return;

    const worldWidth = canvasWidth / zoom;
    const worldHeight = canvasHeight / zoom;
    const sourceLeft = Math.max(0, worldLeft - trackCanvasOrigin.x);
    const sourceTop = Math.max(0, worldTop - trackCanvasOrigin.y);
    const sourceRight = Math.min(
      trackCanvas.width,
      worldLeft + worldWidth - trackCanvasOrigin.x,
    );
    const sourceBottom = Math.min(
      trackCanvas.height,
      worldTop + worldHeight - trackCanvasOrigin.y,
    );
    const sourceWidth = sourceRight - sourceLeft;
    const sourceHeight = sourceBottom - sourceTop;

    drawViewportPresentationBackground(
      ctx,
      canvasWidth,
      canvasHeight,
      { x: worldLeft, y: worldTop },
      zoom,
      presentation || {},
    );
    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    const destX = (trackCanvasOrigin.x + sourceLeft - worldLeft) * zoom;
    const destY = (trackCanvasOrigin.y + sourceTop - worldTop) * zoom;

    ctx.drawImage(
      trackCanvas,
      sourceLeft,
      sourceTop,
      sourceWidth,
      sourceHeight,
      destX,
      destY,
      sourceWidth * zoom,
      sourceHeight * zoom,
    );
  }
}
