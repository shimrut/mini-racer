import { drawViewportPresentationBackground } from "./canvas.js";

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
    container,
    fallbackWidth = 0,
    fallbackHeight = 0,
  }) {
    const ctx = this.ctx;
    if (!ctx) return;

    const worldLeft = camera.x;
    const worldTop = camera.y;

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
