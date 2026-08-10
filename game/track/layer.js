import { configureCanvasViewport } from "./canvas-resolution.js";
import { drawViewportPresentationBackground } from "./canvas.js";

export class TrackLayerRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = null;
    this.worker = null;
    this.workerReady = false;
    this.workerActive = false;
    this.bitmapVersion = 0;
    this.bitmapPromise = null;
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
          this.onTrackReady?.();
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
    if (!ctx) return;

    // The worker's render() re-syncs its backing store every frame; the main-thread
    // path used to rely on resize() having already landed, which leaves the canvas at
    // its 300x150 default whenever the container was unmeasured at setup time.
    const pixelRatio = Math.max(devicePixelRatio || 1, 1);
    const targetPixelWidth = Math.max(1, Math.round(canvasWidth * pixelRatio));
    const targetPixelHeight = Math.max(1, Math.round(canvasHeight * pixelRatio));
    if (
      this.canvas &&
      (this.canvas.width !== targetPixelWidth ||
        this.canvas.height !== targetPixelHeight)
    ) {
      configureCanvasViewport(
        this.canvas,
        ctx,
        canvasWidth,
        canvasHeight,
        devicePixelRatio,
      );
    }

    if (!trackCanvas) return;

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
