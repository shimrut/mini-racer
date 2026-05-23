import { CONFIG } from '../config.js?v=1.91';
import {
    drawCheckeredLine,
    drawPresentationBackground,
    drawTrackBoundaries,
    drawTrackFinishLine,
    fillTrackPresentation
} from './canvas.js';

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
    const padding = 24;
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
    if (points.length === 2) {
        const p0 = mapPoint(points[0]);
        const p1 = mapPoint(points[1]);
        path.moveTo(p0.x, p0.y);
        path.lineTo(p1.x, p1.y);
        return path;
    }

    const p0 = mapPoint(points[0]);
    const p1 = mapPoint(points[1]);
    path.moveTo(p0.x, p0.y);

    for (let i = 1; i < points.length - 1; i++) {
        const curr = mapPoint(points[i]);
        const next = mapPoint(points[i + 1]);
        const midX = (curr.x + next.x) / 2;
        const midY = (curr.y + next.y) / 2;
        path.quadraticCurveTo(curr.x, curr.y, midX, midY);
    }

    const last = mapPoint(points[points.length - 1]);
    const secondLast = mapPoint(points[points.length - 2]);
    const lastMidX = (secondLast.x + last.x) / 2;
    const lastMidY = (secondLast.y + last.y) / 2;
    path.quadraticCurveTo(secondLast.x, secondLast.y, lastMidX, lastMidY);

    path.lineTo(last.x, last.y);

    const firstPoint = mapPoint(points[0]);
    const lastPoint = mapPoint(points[points.length - 1]);
    const closingMidX = (lastPoint.x + firstPoint.x) / 2;
    const closingMidY = (lastPoint.y + firstPoint.y) / 2;
    path.quadraticCurveTo(lastPoint.x, lastPoint.y, closingMidX, closingMidY);
    path.quadraticCurveTo(firstPoint.x, firstPoint.y, p0.x, p0.y);

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
    const infieldColor = transparentBackground ? '#0f172a' : '#1e293b';
    const edgeColor = '#f8fafc';

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.fillStyle = roadColor;
    ctx.fill(outerPath);

    ctx.fillStyle = infieldColor;
    ctx.fill(innerPath);

    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = Math.max(2.25, Math.min(width, height) * 0.012);
    ctx.stroke(outerPath);
    ctx.stroke(innerPath);

    if (startLine) {
        const p1 = mapPoint(startLine.p1);
        const p2 = mapPoint(startLine.p2);
        const bandWidth = Math.max(5, Math.min(width, height) * 0.045);
        drawCheckeredLine(ctx, p1, p2, bandWidth, {
            primary: CONFIG.finishLineColor,
            secondary: CONFIG.finishLineDarkColor
        });
    }

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

    if (transparentBackground) {
        ctx.clearRect(0, 0, width, height);
    } else {
        drawPresentationBackground(ctx, width, height, presentation);
    }

    if (previewRenderMode === 'schematic') {
        const boundsLayout = getTrackBoundsLayout(trackGeometry, width, height);
        drawSchematicTrackPreview(ctx, width, height, trackGeometry, boundsLayout.mapPoint, {
            startLine,
            startPos,
            startAngle,
            transparentBackground
        });
        return;
    }

    const layout = getReplayLayout(payload, width, height);
    const mapPoint = layout.mapPoint;

    const outerPath = buildMappedPath(trackGeometry.outer, mapPoint);
    const innerPath = buildMappedPath(trackGeometry.inner, mapPoint);
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

    // 4. Track boundary strokes (rails / canyon / default edge)
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

