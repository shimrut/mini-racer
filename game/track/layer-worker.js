import { configureCanvasViewport } from './canvas-resolution.js?v=1.91';
import { drawViewportPresentationBackground } from './canvas.js?v=1.91';

let canvas = null;
let ctx = null;
let trackBitmap = null;
let trackOrigin = { x: 0, y: 0 };
let offTrackColor = '#0f172a';
let presentation = {};
let viewportWidth = 0;
let viewportHeight = 0;
let viewportDevicePixelRatio = 1;

function resize(width, height, devicePixelRatio = viewportDevicePixelRatio) {
    if (!canvas) return;
    const viewport = configureCanvasViewport(canvas, ctx, width, height, devicePixelRatio);
    viewportWidth = viewport.cssWidth;
    viewportHeight = viewport.cssHeight;
    viewportDevicePixelRatio = viewport.devicePixelRatio;
}

function render(camera, zoom, viewport) {
    if (!ctx || !canvas) return;

    const width = Math.max(1, Math.round(viewport?.width || viewportWidth || canvas.width));
    const height = Math.max(1, Math.round(viewport?.height || viewportHeight || canvas.height));
    const devicePixelRatio = viewport?.devicePixelRatio || viewportDevicePixelRatio || 1;
    const expectedPixelWidth = Math.max(1, Math.round(width * devicePixelRatio));
    const expectedPixelHeight = Math.max(1, Math.round(height * devicePixelRatio));
    if (
        canvas.width !== expectedPixelWidth
        || canvas.height !== expectedPixelHeight
        || viewportDevicePixelRatio !== devicePixelRatio
    ) {
        resize(width, height, devicePixelRatio);
    }

    drawViewportPresentationBackground(ctx, viewportWidth, viewportHeight, camera, zoom, presentation);
    if (!trackBitmap || !camera || !zoom) return;

    const worldLeft = camera.x;
    const worldTop = camera.y;
    const worldWidth = viewportWidth / zoom;
    const worldHeight = viewportHeight / zoom;
    const sourceLeft = Math.max(0, worldLeft - trackOrigin.x);
    const sourceTop = Math.max(0, worldTop - trackOrigin.y);
    const sourceRight = Math.min(trackBitmap.width, (worldLeft + worldWidth) - trackOrigin.x);
    const sourceBottom = Math.min(trackBitmap.height, (worldTop + worldHeight) - trackOrigin.y);
    const sourceWidth = sourceRight - sourceLeft;
    const sourceHeight = sourceBottom - sourceTop;

    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    const destX = (trackOrigin.x + sourceLeft - worldLeft) * zoom;
    const destY = (trackOrigin.y + sourceTop - worldTop) * zoom;

    ctx.drawImage(
        trackBitmap,
        sourceLeft,
        sourceTop,
        sourceWidth,
        sourceHeight,
        destX,
        destY,
        sourceWidth * zoom,
        sourceHeight * zoom
    );
}

self.onmessage = (event) => {
    const data = event.data || {};

    switch (data.type) {
    case 'init':
        canvas = data.canvas || null;
        ctx = canvas?.getContext('2d', { alpha: false, desynchronized: true })
            || canvas?.getContext('2d')
            || null;
        viewportWidth = canvas?.width || 0;
        viewportHeight = canvas?.height || 0;
        viewportDevicePixelRatio = 1;
        self.postMessage({ type: 'init-complete' });
        break;
    case 'resize':
        resize(data.width, data.height, data.devicePixelRatio);
        break;
    case 'track':
        trackBitmap?.close?.();
        trackBitmap = data.bitmap || null;
        trackOrigin = data.origin || { x: 0, y: 0 };
        offTrackColor = data.offTrackColor || offTrackColor;
        presentation = data.presentation || presentation;
        self.postMessage({ type: 'track-ready' });
        break;
    case 'render':
        render(data.camera, data.zoom, data.viewport);
        break;
    default:
        break;
    }
};
