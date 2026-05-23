const DEFAULT_MAX_DEVICE_PIXEL_RATIO = 2;

function normalizeCssPixels(value) {
    return Math.max(1, Math.round(Number(value) || 0));
}

function normalizeDevicePixelRatio(devicePixelRatio, maxDevicePixelRatio = DEFAULT_MAX_DEVICE_PIXEL_RATIO) {
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
    if (!Number.isFinite(maxDevicePixelRatio) || maxDevicePixelRatio <= 0) return 1;
    return Math.min(devicePixelRatio, maxDevicePixelRatio);
}

export function resolveCanvasViewport(width, height, devicePixelRatio, options = {}) {
    const cssWidth = normalizeCssPixels(width);
    const cssHeight = normalizeCssPixels(height);
    const normalizedDevicePixelRatio = normalizeDevicePixelRatio(
        devicePixelRatio,
        options.maxDevicePixelRatio
    );

    return {
        cssWidth,
        cssHeight,
        devicePixelRatio: normalizedDevicePixelRatio,
        pixelWidth: Math.max(1, Math.round(cssWidth * normalizedDevicePixelRatio)),
        pixelHeight: Math.max(1, Math.round(cssHeight * normalizedDevicePixelRatio))
    };
}

export function configureCanvasViewport(canvas, ctx, width, height, devicePixelRatio, options = {}) {
    const viewport = resolveCanvasViewport(width, height, devicePixelRatio, options);
    if (canvas) {
        canvas.width = viewport.pixelWidth;
        canvas.height = viewport.pixelHeight;
    }
    if (ctx?.setTransform) {
        ctx.setTransform(viewport.devicePixelRatio, 0, 0, viewport.devicePixelRatio, 0, 0);
    }
    return viewport;
}
