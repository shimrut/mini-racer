import { TRACKS } from './tracks.js';
import { renderTrackPreviewCanvas } from './preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './presentation.js';

// Draws a track and its car on a post's canvas, sized to the canvas on screen.
export function renderPosterTrack(canvas, trackKey, carImage = null, carTravel = 1) {
    const track = TRACKS[trackKey];
    if (!canvas || !track) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (width < 2 || height < 2) return;
    canvas.width = width;
    canvas.height = height;
    renderTrackPreviewCanvas(canvas, {
        trackGeometry: { outer: track.outer, inner: track.inner },
        cornerRadius: track.cornerRadius,
        presentation: resolveTrackPresentation(trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            ground: track.ground,
        }),
        startLine: track.startLine,
        startPos: track.startPos,
        startAngle: track.startAngle ?? 0,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        showSchematicCarTrail: true,
        moveSchematicCarPastStartLine: true,
        schematicCarImage: carImage,
        schematicCarTravel: carTravel,
        schematicReserveCarSlot: true,
        hideSchematicStartArrow: true,
        runHistory: [],
    });
}
