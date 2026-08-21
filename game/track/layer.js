import { drawViewportPresentationBackground } from "./canvas.js";

/**
 * Blits the visible slice of the pre-rendered track bitmap into the race canvas.
 *
 * The race used to own a second full-viewport canvas underneath the game canvas,
 * optionally driven from a worker through an OffscreenCanvas. Both are gone:
 *
 * - The extra layer forced the game canvas to stay `alpha: true` and cost a
 *   full-viewport composite every frame while saving no drawing, because render()
 *   calls drawVisibleTrackCanvas() unconditionally. Chrome's Graphite backend
 *   stuttered on it where Safari did not, and collapsing the layers cleared that.
 * - The worker never presented reliably inside Devvit's Android WebView, which
 *   showed the car over a blank white background; Android had already been forced
 *   onto this main-thread path, and then so was everyone else, because the layer
 *   draws in ~5us and the worker only bought a postMessage per frame plus a second
 *   resident thread.
 *
 * So there is one canvas, the engine owns it and its backing store, and this class
 * draws into the context the engine hands it.
 */
export class TrackLayerRenderer {
  constructor(ctx) {
    this.ctx = ctx;
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
    backdrop = null,
    detailTier = 2,
    container,
    fallbackWidth = 0,
    fallbackHeight = 0,
  }) {
    const ctx = this.ctx;
    if (!ctx) return;

    const worldLeft = camera.x;
    const worldTop = camera.y;

    // The engine's canvas is already sized; fall back to its backing store only for
    // the startup frame where the container has not been measured yet.
    const fallbackCssWidth =
      fallbackWidth > 0 ? fallbackWidth / Math.max(devicePixelRatio || 1, 1) : 0;
    const fallbackCssHeight =
      fallbackHeight > 0 ? fallbackHeight / Math.max(devicePixelRatio || 1, 1) : 0;

    const canvasWidth =
      viewportWidth || container.clientWidth || fallbackCssWidth;
    const canvasHeight =
      viewportHeight || container.clientHeight || fallbackCssHeight;

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
      backdrop,
      detailTier,
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
