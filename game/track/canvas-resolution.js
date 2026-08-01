const MAX_DEVICE_PIXEL_RATIO = 2;

function normalizeCssPixels(value) {
    return Math.max(1, Math.round(Number(value) || 0));
}

function normalizeDevicePixelRatio(devicePixelRatio) {
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
    return Math.min(devicePixelRatio, MAX_DEVICE_PIXEL_RATIO);
}

export function resolveCanvasViewport(width, height, devicePixelRatio) {
    const cssWidth = normalizeCssPixels(width);
    const cssHeight = normalizeCssPixels(height);
    const normalizedDevicePixelRatio = normalizeDevicePixelRatio(devicePixelRatio);

    return {
        cssWidth,
        cssHeight,
        devicePixelRatio: normalizedDevicePixelRatio,
        pixelWidth: Math.max(1, Math.round(cssWidth * normalizedDevicePixelRatio)),
        pixelHeight: Math.max(1, Math.round(cssHeight * normalizedDevicePixelRatio))
    };
}

export function configureCanvasViewport(canvas, ctx, width, height, devicePixelRatio) {
    const viewport = resolveCanvasViewport(width, height, devicePixelRatio);
    if (canvas) {
        canvas.width = viewport.pixelWidth;
        canvas.height = viewport.pixelHeight;
    }
    if (ctx?.setTransform) {
        ctx.setTransform(viewport.devicePixelRatio, 0, 0, viewport.devicePixelRatio, 0, 0);
    }
    return viewport;
}
