import { CONFIG } from '../config.js';
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

function getTrackBoundsLayout(trackGeometry, width, height) {
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
    const usableWidth = width - padding * 2;
    const usableHeight = height - padding * 2;
    const scale = Math.min(usableWidth / Math.max(1, maxX - minX), usableHeight / Math.max(1, maxY - minY));
    const offsetX = padding + (usableWidth - (maxX - minX) * scale) / 2;
    const offsetY = padding + (usableHeight - (maxY - minY) * scale) / 2;

    return {
        scale,
        mapPoint: (point) => ({
            x: offsetX + (point.x - minX) * scale,
            y: offsetY + (point.y - minY) * scale
        })
    };
}

function getReplayLayout(payload, width, height) {
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
    const usableWidth = width - padding * 2;
    const usableHeight = height - padding * 2;
    const scale = Math.min(usableWidth / Math.max(1, maxX - minX), usableHeight / Math.max(1, maxY - minY));
    const offsetX = padding + (usableWidth - (maxX - minX) * scale) / 2;
    const offsetY = padding + (usableHeight - (maxY - minY) * scale) / 2;

    return {
        mapPoint: (point) => ({
            x: offsetX + (point.x - minX) * scale,
            y: offsetY + (point.y - minY) * scale
        })
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

const SCHEMATIC_POST_CAR_TRAIL_BEHIND = 48;

function schematicCarTravel(value) {
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(0, value));
}

function drawSchematicCarTrail(ctx, position, angle, scale = 1) {
    const s = scale;
    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-SCHEMATIC_POST_CAR_TRAIL_BEHIND * s, 0);
    ctx.lineTo(-14 * s, 0);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.78)';
    ctx.lineWidth = Math.max(1.5, 2.25 * s);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
}

function drawSchematicGhostPath(ctx, points, mapPoint, color, scale = 1) {
    if (!Array.isArray(points) || points.length < 2) return;
    const first = mapPoint(points[0]);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i += 1) {
        const point = mapPoint(points[i]);
        ctx.lineTo(point.x, point.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, 2.25 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
}

const SCHEMATIC_CAR_MARKER_SIZE = 36;
const SCHEMATIC_REPLAY_CAR_MARKER_SIZE = SCHEMATIC_CAR_MARKER_SIZE * 0.75;

function drawSchematicCarImage(
    ctx,
    image,
    position,
    angle,
    markerScale = 1,
    trackScale = null,
    carWorldSize = null,
    markerSize = SCHEMATIC_CAR_MARKER_SIZE
) {
    if (!image) return;
    const fallbackSize = markerSize * markerScale;
    const hasWorldSize = Number.isFinite(trackScale)
        && trackScale > 0
        && Number.isFinite(carWorldSize?.width)
        && carWorldSize.width > 0
        && Number.isFinite(carWorldSize?.height)
        && carWorldSize.height > 0;
    const width = hasWorldSize ? carWorldSize.width * trackScale : fallbackSize;
    const height = hasWorldSize ? carWorldSize.height * trackScale : fallbackSize;
    const shadowScale = Math.min(width, height) / 36;
    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.rotate(angle);
    ctx.shadowColor = 'rgba(2, 6, 23, 0.7)';
    ctx.shadowBlur = 5 * shadowScale;
    ctx.shadowOffsetX = 1.5 * shadowScale;
    ctx.shadowOffsetY = 2 * shadowScale;
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    ctx.restore();
}

function getSchematicCarPosition(startLine, startPos, startAngle, mapPoint, scale, movePastStartLine, useCarOffset) {
    if (!movePastStartLine || !startLine) {
        return startPos ? mapPoint(startPos) : null;
    }

    const p1 = mapPoint(startLine.p1);
    const p2 = mapPoint(startLine.p2);
    const forwardOffset = (useCarOffset ? 35 : 14) * scale;
    return {
        x: (p1.x + p2.x) / 2 + Math.cos(startAngle) * forwardOffset,
        y: (p1.y + p2.y) / 2 + Math.sin(startAngle) * forwardOffset
    };
}

function buildMappedRingPath(outerPoints, innerPoints, mapPoint) {
    const path = new Path2D();
    if (outerPoints.length >= 2) {
        const first = mapPoint(outerPoints[0]);
        path.moveTo(first.x, first.y);
        for (let i = 1; i < outerPoints.length; i += 1) {
            const point = mapPoint(outerPoints[i]);
            path.lineTo(point.x, point.y);
        }
        path.closePath();
    }
    if (innerPoints.length >= 2) {
        const last = mapPoint(innerPoints[innerPoints.length - 1]);
        path.moveTo(last.x, last.y);
        for (let i = innerPoints.length - 2; i >= 0; i -= 1) {
            const point = mapPoint(innerPoints[i]);
            path.lineTo(point.x, point.y);
        }
        path.closePath();
    }
    return path;
}

function drawSchematicTrackPreview(ctx, width, height, trackGeometry, mapPoint, {
    startLine,
    startPos,
    startAngle = 0,
    transparentBackground = false,
    showCarTrail = false,
    moveCarPastStartLine = false,
    carImage = null,
    carTravel = 1,
    reserveCarSlot = false,
    carWorldSize = null,
    trackScale = null,
    hideStartArrow = false,
    cars = [],
}) {
    const outer = trackGeometry.outer;
    const inner = trackGeometry.inner;
    const outerPath = buildMappedPath(outer, mapPoint);
    const innerPath = buildMappedPath(inner, mapPoint);
    const roadClipPath = buildMappedRingPath(outer, inner, mapPoint);

    const roadColor = '#475569';
    const edgeColor = '#f8fafc';

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Evenodd fills punch holes on @napi-rs/canvas.
    ctx.fillStyle = roadColor;
    ctx.fill(outerPath);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(innerPath);
    ctx.restore();

    if (startLine) {
        const p1 = mapPoint(startLine.p1);
        const p2 = mapPoint(startLine.p2);
        const bandWidth = Math.max(5, Math.min(width, height) * 0.045);
        ctx.save();
        ctx.clip(roadClipPath, 'evenodd');
        drawCheckeredLine(ctx, p1, p2, bandWidth, {
            primary: CONFIG.finishLineColor,
            secondary: CONFIG.finishLineDarkColor
        });
        ctx.restore();
    }

    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = Math.max(2.25, Math.min(width, height) * 0.012);
    ctx.stroke(outerPath);
    ctx.stroke(innerPath);

    if (Array.isArray(cars) && cars.length > 0) {
        const arrowScale = Math.min(width, height) / 420;
        for (const car of cars) {
            if (Array.isArray(car?.trail) && car.trail.length > 1) {
                drawSchematicGhostPath(ctx, car.trail, mapPoint, car.trailStyle || 'rgba(239, 68, 68, 0.78)', arrowScale);
            }
        }
        for (const car of cars) {
            if (!car?.image || !Number.isFinite(car.x) || !Number.isFinite(car.y)) continue;
            drawSchematicCarImage(
                ctx,
                car.image,
                mapPoint({ x: car.x, y: car.y }),
                Number.isFinite(car.angle) ? car.angle : 0,
                arrowScale,
                null,
                null,
                SCHEMATIC_REPLAY_CAR_MARKER_SIZE
            );
        }
        ctx.restore();
        return;
    }

    if (startPos || (moveCarPastStartLine && startLine)) {
        const arrowScale = Math.min(width, height) / 420;
        const markerPosition = getSchematicCarPosition(
            startLine,
            startPos,
            startAngle,
            mapPoint,
            arrowScale,
            moveCarPastStartLine,
            Boolean(carImage) || reserveCarSlot === true
        );
        if (markerPosition) {
            if (showCarTrail) {
                drawSchematicCarTrail(ctx, markerPosition, startAngle, arrowScale);
            }
            if (carImage) {
                const travel = schematicCarTravel(carTravel);
                const behind = SCHEMATIC_POST_CAR_TRAIL_BEHIND * (1 - travel) * arrowScale;
                drawSchematicCarImage(
                    ctx,
                    carImage,
                    {
                        x: markerPosition.x - Math.cos(startAngle) * behind,
                        y: markerPosition.y - Math.sin(startAngle) * behind,
                    },
                    startAngle,
                    arrowScale,
                    trackScale,
                    carWorldSize
                );
            } else if (!hideStartArrow) {
                drawSchematicStartArrow(ctx, markerPosition, startAngle, arrowScale);
            }
        }
    }

    ctx.restore();
}

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
            transparentBackground,
            showCarTrail: payload.showSchematicCarTrail === true,
            moveCarPastStartLine: payload.moveSchematicCarPastStartLine === true,
            carImage: payload.schematicCarImage || null,
            carTravel: payload.schematicCarTravel,
            reserveCarSlot: payload.schematicReserveCarSlot === true,
            carWorldSize: payload.schematicCarWorldSize || null,
            trackScale: boundsLayout.scale,
            hideStartArrow: payload.hideSchematicStartArrow === true,
            cars: Array.isArray(payload.schematicCars) ? payload.schematicCars : [],
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

    fillTrackPresentation(ctx, surfacePath, innerPath, outerPath, width, height, presentation);

    if (startLine) {
        const p1 = mapPoint(startLine.p1);
        const p2 = mapPoint(startLine.p2);
        ctx.save();
        ctx.clip(surfacePath, 'evenodd');
        drawTrackFinishLine(ctx, p1, p2, 6, presentation);
        ctx.restore();
    }

    if (presentation.showCurbs !== false) {
        drawCurbs(ctx, outerPath, presentation);
        drawCurbs(ctx, innerPath, presentation);
    }

    drawTrackBoundaries(ctx, outerPath, innerPath, presentation);

    if (runHistory.length > 1) {
        drawNeonRoute(ctx, runHistory, mapPoint);
    }

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
