import { CONFIG } from '../config.js?v=2.09';
import {
    drawCheckeredLine,
    drawPresentationBackground,
    drawTrackBoundaries,
    drawTrackFinishLine,
    fillTrackPresentation
} from './canvas.js';
import { buildTrackGeometry } from './runtime.js';

const previewGeometryCache = new WeakMap();
const previewCanvasCache = new Map();
const PREVIEW_CANVAS_CACHE_LIMIT = 48;

function getPreviewGeometry(trackGeometry, cornerRadius) {
    const outer = trackGeometry?.outer;
    const inner = trackGeometry?.inner;
    if (!outer || !inner) return null;

    let innerCache = previewGeometryCache.get(outer);
    if (!innerCache) {
        innerCache = new WeakMap();
        previewGeometryCache.set(outer, innerCache);
    }

    let radiusCache = innerCache.get(inner);
    if (!radiusCache) {
        radiusCache = new Map();
        innerCache.set(inner, radiusCache);
    }

    const radiusKey = Number.isFinite(cornerRadius) ? cornerRadius : 3;
    let geometry = radiusCache.get(radiusKey);
    if (!geometry) {
        geometry = buildTrackGeometry({
            outer,
            inner,
            cornerRadius: radiusKey
        });
        radiusCache.set(radiusKey, geometry);
    }
    return geometry;
}

function touchPreviewCanvasCache(key, value) {
    if (previewCanvasCache.has(key)) {
        previewCanvasCache.delete(key);
    }
    previewCanvasCache.set(key, value);
    while (previewCanvasCache.size > PREVIEW_CANVAS_CACHE_LIMIT) {
        const oldestKey = previewCanvasCache.keys().next().value;
        previewCanvasCache.delete(oldestKey);
    }
}

function getPreviewCanvasCacheKey(canvas, payload) {
    if (!payload?.cacheKey) return null;
    return [
        payload.cacheKey,
        canvas.width,
        canvas.height,
        payload.previewRenderMode || 'full',
        payload.transparentBackground ? 'transparent' : 'solid',
        payload.presentation?.key || 'default',
        payload.cornerRadius ?? 3
    ].join(':');
}

function drawCurbs(ctx, path, presentation) {
    ctx.save();
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.setLineDash([12, 12]);
    ctx.strokeStyle = presentation.curbRed || CONFIG.curbRed;
    ctx.stroke(path);
    ctx.lineDashOffset = 12;
    ctx.strokeStyle = presentation.curbWhite || CONFIG.curbWhite;
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.restore();
}

function getTrackBoundsLayout(trackGeometry, width, height, topInset = 0, bottomInset = 0, sideInset = 0) {
    const padding = 16;
    const trackOuter = trackGeometry?.outer ?? [];
    const trackInner = trackGeometry?.inner ?? [];
    const points = [...trackOuter, ...trackInner];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const usableWidth = width - padding * 2 - sideInset * 2;
    const usableHeight = height - topInset - bottomInset - padding * 2;
    const scale = Math.min(usableWidth / Math.max(1, maxX - minX), usableHeight / Math.max(1, maxY - minY));
    const offsetX = sideInset + padding + (usableWidth - (maxX - minX) * scale) / 2;
    const offsetY = topInset + padding + (usableHeight - (maxY - minY) * scale) / 2;

    return {
        mapPoint: (point) => ({
            x: offsetX + (point.x - minX) * scale,
            y: offsetY + (point.y - minY) * scale
        })
    };
}

function getReplayLayout(payload, width, height, topInset = 0, bottomInset = 0, sideInset = 0) {
    const padding = 28;
    const trackOuter = payload.trackGeometry?.outer ?? [];
    const trackInner = payload.trackGeometry?.inner ?? [];
    const runHistory = payload.runHistory ?? [];
    const startPos = payload.startPos ?? trackOuter[0] ?? { x: 0, y: 0 };
    const endPos = runHistory[runHistory.length - 1] ?? startPos;
    const run = runHistory.length > 1 ? runHistory : [startPos, endPos];
    const points = [...trackOuter, ...trackInner, ...run];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const usableWidth = width - padding * 2 - sideInset * 2;
    const usableHeight = height - topInset - bottomInset - padding * 2;
    const scale = Math.min(usableWidth / Math.max(1, maxX - minX), usableHeight / Math.max(1, maxY - minY));
    const offsetX = sideInset + padding + (usableWidth - (maxX - minX) * scale) / 2;
    const offsetY = topInset + padding + (usableHeight - (maxY - minY) * scale) / 2;

    return {
        bottomInset,
        run,
        mapPoint: (point) => ({
            x: offsetX + (point.x - minX) * scale,
            y: offsetY + (point.y - minY) * scale
        })
    };
}

function getReplayProgressPoint(run, progress) {
    if (run.length === 1) {
        return run[0];
    }

    const scaledIndex = progress * (run.length - 1);
    const baseIndex = Math.floor(scaledIndex);
    const nextIndex = Math.min(run.length - 1, baseIndex + 1);
    const t = scaledIndex - baseIndex;
    const start = run[baseIndex];
    const end = run[nextIndex];

    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t
    };
}

function traceMappedPath(ctx, points, mapPoint, closePath = false) {
    if (!points.length) return;

    const first = mapPoint(points[0]);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
        const point = mapPoint(points[i]);
        ctx.lineTo(point.x, point.y);
    }
    if (closePath) {
        ctx.closePath();
    }
}

function buildMappedPath(points, mapPoint) {
    const path = new Path2D();
    if (points.length < 2) return path;

    const first = mapPoint(points[0]);
    path.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
        const pt = mapPoint(points[i]);
        path.lineTo(pt.x, pt.y);
    }
    path.closePath();
    return path;
}

function drawNeonRoute(ctx, points, mapPoint) {
    if (points.length < 2) return;

    const strokePass = (width, color, blur, shadowRgb) => {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        if (blur > 0) {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        } else {
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            ctx.shadowColor = "transparent";
        }
        traceMappedPath(ctx, points, mapPoint, false);
        ctx.stroke();
    };

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    strokePass(18, 'rgba(239, 68, 68, 0.12)', 22, 'rgba(239, 68, 68, 0.75)');
    strokePass(10, 'rgba(239, 68, 68, 0.22)', 14, 'rgba(248, 113, 113, 0.65)');
    strokePass(4, 'rgba(252, 165, 165, 0.85)', 6, 'rgba(254, 202, 202, 0.45)');
    strokePass(2, '#fecaca', 0, 'transparent');
    strokePass(1.25, CONFIG.curbRed, 0, 'transparent');

    ctx.restore();
}

function drawDirectionMarker(ctx, position, angle) {
    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
}

function drawSchematicStartArrow(ctx, position, angle, scale = 1) {
    const s = scale;
    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(7 * s, 0);
    ctx.lineTo(-5 * s, -4.5 * s);
    ctx.lineTo(-5 * s, 4.5 * s);
    ctx.closePath();
    ctx.fillStyle = CONFIG.curbRed;
    ctx.fill();
    ctx.restore();
}

function drawSchematicTrackPreview(ctx, width, height, trackGeometry, mapPoint, {
    startLine,
    startPos,
    startAngle = 0,
    transparentBackground = false
}) {
    const outer = trackGeometry.outer;
    const inner = trackGeometry.inner;
    const outerPath = buildMappedPath(outer, mapPoint);
    const innerPath = buildMappedPath(inner, mapPoint);

    const roadColor = '#475569';
    const edgeColor = '#f8fafc';

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 1. Fill track surface (asphalt) only using 'evenodd' (leaves infield transparent)
    const surfacePath = new Path2D();
    surfacePath.addPath(outerPath);
    surfacePath.addPath(innerPath);

    ctx.fillStyle = roadColor;
    ctx.fill(surfacePath, 'evenodd');

    // 2. Start/finish line (clipped to road surface so it doesn't draw over the edges)
    if (startLine) {
        const p1 = mapPoint(startLine.p1);
        const p2 = mapPoint(startLine.p2);
        const bandWidth = Math.max(5, Math.min(width, height) * 0.045);
        ctx.save();
        ctx.clip(surfacePath, 'evenodd');
        drawCheckeredLine(ctx, p1, p2, bandWidth, {
            primary: CONFIG.finishLineColor,
            secondary: CONFIG.finishLineDarkColor
        });
        ctx.restore();
    }

    // 3. Draw track boundary borders
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = Math.max(2.25, Math.min(width, height) * 0.012);
    ctx.stroke(outerPath);
    ctx.stroke(innerPath);

    // 4. Direction marker
    if (startPos) {
        const mappedStart = mapPoint(startPos);
        const arrowScale = Math.min(width, height) / 420;
        drawSchematicStartArrow(ctx, mappedStart, startAngle, arrowScale);
    }

    ctx.restore();
}

/**
 * Renders a compact track preview onto a canvas.
 * Used for track selection cards and daily challenge previews.
 */
export function renderTrackPreviewCanvas(canvas, payload) {
    if (!canvas || !payload) return;

    const { width, height } = canvas;
    const ctx = canvas.getContext('2d');
    const {
        trackGeometry,
        presentation,
        startLine,
        startPos,
        startAngle,
        runHistory = [],
        transparentBackground = false,
        previewRenderMode
    } = payload;

    if (!trackGeometry?.outer || !trackGeometry?.inner) return;

    // Smooth the track geometry so it matches the game's actual smooth curves.
    const smoothedGeometry = getPreviewGeometry(trackGeometry, payload.cornerRadius ?? 3);
    if (!smoothedGeometry) return;

    if (transparentBackground) {
        ctx.clearRect(0, 0, width, height);
    } else {
        drawPresentationBackground(ctx, width, height, presentation);
    }

    if (previewRenderMode === 'schematic') {
        const boundsLayout = getTrackBoundsLayout(smoothedGeometry, width, height);
        drawSchematicTrackPreview(ctx, width, height, smoothedGeometry, boundsLayout.mapPoint, {
            startLine,
            startPos,
            startAngle,
            transparentBackground
        });
        return;
    }

    const layout = getReplayLayout({ ...payload, trackGeometry: smoothedGeometry }, width, height);
    const mapPoint = layout.mapPoint;

    const outerPath = buildMappedPath(smoothedGeometry.outer, mapPoint);
    const innerPath = buildMappedPath(smoothedGeometry.inner, mapPoint);
    const surfacePath = new Path2D();
    surfacePath.addPath(outerPath);
    surfacePath.addPath(innerPath);

    // 1. Fill track surface and infield
    fillTrackPresentation(ctx, surfacePath, innerPath, outerPath, width, height, presentation);

    // 2. Start/finish line (clipped to asphalt so dashed kerb gaps do not reveal it)
    if (startLine) {
        const p1 = mapPoint(startLine.p1);
        const p2 = mapPoint(startLine.p2);
        ctx.save();
        ctx.clip(surfacePath, 'evenodd');
        drawTrackFinishLine(ctx, p1, p2, 6, presentation);
        ctx.restore();
    }

    // 3. Draw curbs (kerbs)
    if (presentation.showCurbs !== false) {
        drawCurbs(ctx, outerPath, presentation);
        drawCurbs(ctx, innerPath, presentation);
    }

    // 4. Track boundary strokes (canyon / default edge)
    drawTrackBoundaries(ctx, outerPath, innerPath, presentation);

    // 5. Draw run history (the neon line)
    if (runHistory.length > 1) {
        drawNeonRoute(ctx, runHistory, mapPoint);
    }

    // 6. Draw direction marker (the starting arrow)
    if (startPos) {
        const mappedStart = mapPoint(startPos);
        drawDirectionMarker(ctx, mappedStart, startAngle);
    }
}

export function renderCachedTrackPreviewCanvas(canvas, payload) {
    const cacheKey = getPreviewCanvasCacheKey(canvas, payload);
    if (!cacheKey) {
        renderTrackPreviewCanvas(canvas, payload);
        return;
    }

    let cachedCanvas = previewCanvasCache.get(cacheKey);
    if (!cachedCanvas) {
        cachedCanvas = document.createElement('canvas');
        cachedCanvas.width = canvas.width;
        cachedCanvas.height = canvas.height;
        renderTrackPreviewCanvas(cachedCanvas, payload);
        touchPreviewCanvasCache(cacheKey, cachedCanvas);
    } else {
        touchPreviewCanvasCache(cacheKey, cachedCanvas);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cachedCanvas, 0, 0);
}
