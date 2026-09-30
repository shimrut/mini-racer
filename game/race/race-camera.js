// The race camera: its zoom, and how far it looks ahead of the car. The race
// and the Mapmaker Test Drive use this module, so both show the same view.

export const CAMERA_DT_MIN_S = 1 / 120;
export const CAMERA_DT_MAX_S = 1 / 45;
export const NARROW_VIEWPORT_MAX_WIDTH = 768;

export function isMobileCameraMode({ coarsePointer = false, narrowViewport = false } = {}) {
    return Boolean(coarsePointer || narrowViewport);
}

export function getCameraZoom(mobileCameraMode) {
    return mobileCameraMode ? 0.75 : 1.0;
}

// Writes the look-ahead that the camera moves to into `out`, in track-canvas pixels.
export function getDesiredLookAhead(out, velocity, speed, cw, ch, mobileCameraMode) {
    out.x = 0;
    out.y = 0;

    if (speed > 1) {
        const multiplier = mobileCameraMode ? 12 : 5;
        const maxOffset = mobileCameraMode
            ? Math.min(cw, ch) / 2.5
            : Math.min(cw, ch) / 5;

        out.x = velocity.x * multiplier;
        out.y = velocity.y * multiplier;

        const magnitude = Math.hypot(out.x, out.y);
        if (magnitude > maxOffset) {
            out.x = (out.x / magnitude) * maxOffset;
            out.y = (out.y / magnitude) * maxOffset;
        }
    }

    return out;
}

// How far the look-ahead moves toward its target in one frame (0 to 1).
export function getLookAheadLerpFactor(dt, mobileCameraMode) {
    const smoothSpeed = mobileCameraMode ? 2 : 4;
    const cameraDt = dt > 0 ? Math.min(Math.max(dt, CAMERA_DT_MIN_S), CAMERA_DT_MAX_S) : 0;
    return cameraDt > 0 ? 1 - Math.exp(-cameraDt * smoothSpeed) : 0;
}
