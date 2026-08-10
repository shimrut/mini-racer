import { CONFIG } from '../config.js';

function createSeededRandom(seedInput = 'default') {
    let hash = 2166136261;
    const text = String(seedInput);
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return () => {
        hash += 0x6D2B79F5;
        let t = hash;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function drawDesertBackdrop(ctx, width, height, presentation = {}) {
    ctx.fillStyle = presentation.offTrackColor || '#8d6a3b';
    ctx.fillRect(0, 0, width, height);
}

export function drawCheckeredLine(ctx, p1, p2, width, colors = {}) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;

    const tx = dx / length;
    const ty = dy / length;
    const nx = -ty;
    const ny = tx;
    const rows = 2;
    const columns = Math.max(2, Math.ceil(length / Math.max(6, width * 0.8)));
    const cellLength = length / columns;
    const rowHeight = width / rows;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    for (let row = 0; row < rows; row++) {
        const innerOffset = -width / 2 + row * rowHeight;
        const outerOffset = innerOffset + rowHeight;

        for (let col = 0; col < columns; col++) {
            const startDist = col * cellLength;
            const endDist = (col + 1) * cellLength;
            const sx = p1.x + tx * startDist;
            const sy = p1.y + ty * startDist;
            const ex = p1.x + tx * endDist;
            const ey = p1.y + ty * endDist;

            ctx.fillStyle = (row + col) % 2 === 0
                ? (colors.primary || CONFIG.finishLineColor)
                : (colors.secondary || CONFIG.finishLineDarkColor);
            ctx.beginPath();
            ctx.moveTo(sx + nx * innerOffset, sy + ny * innerOffset);
            ctx.lineTo(ex + nx * innerOffset, ey + ny * innerOffset);
            ctx.lineTo(ex + nx * outerOffset, ey + ny * outerOffset);
            ctx.lineTo(sx + nx * outerOffset, sy + ny * outerOffset);
            ctx.closePath();
            ctx.fill();
        }
    }

    ctx.restore();
}

function drawTireBarrier(ctx, x, y, angle, presentation) {
    const tireOffsets = [-12, 0, 12];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    for (let i = 0; i < tireOffsets.length; i++) {
        const offset = tireOffsets[i];
        const yOffset = i === 1 ? 0 : 2;

        ctx.fillStyle = presentation.tireWallColor || '#111827';
        ctx.beginPath();
        ctx.ellipse(offset, yOffset, 7.5, 6, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = presentation.tireWallInnerStrokeColor || 'rgba(248, 250, 252, 0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(offset, yOffset, 5.5, 4.4, 0, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = presentation.tireWallCoreColor || '#020617';
        ctx.beginPath();
        ctx.ellipse(offset, yOffset, 2.2, 1.8, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = presentation.tireWallTreadColor || 'rgba(248, 250, 252, 0.1)';
        ctx.lineWidth = 1;
        for (let tread = -3; tread <= 3; tread += 3) {
            ctx.beginPath();
            ctx.moveTo(offset + tread, yOffset - 4.8);
            ctx.lineTo(offset + tread, yOffset + 4.8);
            ctx.stroke();
        }
    }

    ctx.restore();
}

function buildClosedPath(points, mapPoint) {
    const path = new Path2D();
    let mappedPoint = mapPoint(points[0]);
    path.moveTo(mappedPoint.x, mappedPoint.y);
    for (let i = 1; i < points.length; i++) {
        mappedPoint = mapPoint(points[i]);
        path.lineTo(mappedPoint.x, mappedPoint.y);
    }
    path.closePath();
    return path;
}

export function drawPresentationBackground(ctx, width, height, presentation = {}, seed = 'default') {
    if (presentation.backgroundStyle === 'desert') {
        drawDesertBackdrop(ctx, width, height, presentation);
        return;
    }

    ctx.fillStyle = presentation.offTrackColor || CONFIG.offTrackColor;
    ctx.fillRect(0, 0, width, height);
}

export function drawViewportPresentationBackground(ctx, width, height, camera = { x: 0, y: 0 }, zoom = 1, presentation = {}) {
    if (presentation.backgroundStyle === 'desert') {
        drawDesertBackdrop(ctx, width, height, presentation, { camera, zoom });
        return;
    }

    ctx.fillStyle = presentation.offTrackColor || CONFIG.offTrackColor;
    ctx.fillRect(0, 0, width, height);
}

function drawBoundaryDebris(ctx, points, mapTrackPoint, presentation, {
    inward = false,
    seedSuffix = 'outer',
    clusters = []
} = {}) {
    if (presentation.debrisStyle !== 'outer-drift' || points.length < 3) return;

    const seedSource = `${presentation.key || 'track'}:${seedSuffix}:${points.length}`;
    const random = createSeededRandom(seedSource);
    const centroid = points.reduce((acc, point) => ({
        x: acc.x + point.x,
        y: acc.y + point.y
    }), { x: 0, y: 0 });
    centroid.x /= points.length;
    centroid.y /= points.length;

    ctx.save();
    ctx.lineWidth = Math.max(0.5, presentation.debrisStrokeWidth || 1.2);
    ctx.lineJoin = presentation.debrisLineJoin || 'round';
    ctx.strokeStyle = presentation.debrisColor || 'rgba(226, 232, 240, 0.75)';
    ctx.fillStyle = presentation.debrisAccentColor || 'rgba(125, 211, 252, 0.28)';
    const minRadius = Math.max(1, presentation.debrisMinRadius || 2);
    const maxRadius = Math.max(minRadius, presentation.debrisMaxRadius || 10);
    const sidesMin = Math.max(3, Math.floor(presentation.debrisSidesMin || 5));
    const sidesMax = Math.max(sidesMin, Math.floor(presentation.debrisSidesMax || 7));
    const stretchMin = Math.max(1, presentation.debrisStretchMin || 1);
    const stretchMax = Math.max(stretchMin, presentation.debrisStretchMax || stretchMin);
    const fillProbability = typeof presentation.debrisFillProbability === 'number'
        ? Math.max(0, Math.min(1, presentation.debrisFillProbability))
        : 0.55;

    for (const cluster of clusters) {
        const startIndex = Math.floor(points.length * cluster.start);
        const endIndex = Math.max(startIndex + 1, Math.floor(points.length * cluster.end));
        for (let i = 0; i < cluster.count; i += 1) {
            const index = startIndex + Math.floor(random() * Math.max(1, endIndex - startIndex));
            const point = points[index];
            const outwardX = point.x - centroid.x;
            const outwardY = point.y - centroid.y;
            const outwardLength = Math.hypot(outwardX, outwardY) || 1;
            const direction = inward ? -1 : 1;
            const normalX = (outwardX / outwardLength) * direction;
            const normalY = (outwardY / outwardLength) * direction;
            const tangentX = -normalY;
            const tangentY = normalX;
            const offset = 18 + random() * 54;
            const along = (random() - 0.5) * 26;
            const screenPoint = mapTrackPoint(point);
            const debrisX = screenPoint.x + normalX * offset + tangentX * along;
            const debrisY = screenPoint.y + normalY * offset + tangentY * along;
            const radius = minRadius + random() * (maxRadius - minRadius);
            const sides = sidesMin + Math.floor(random() * (sidesMax - sidesMin + 1));
            const stretch = stretchMin + random() * (stretchMax - stretchMin);
            const majorRadius = radius * stretch;
            const minorRadius = radius * (0.42 + random() * 0.16);
            const rotation = Math.atan2(tangentY, tangentX) + (random() - 0.5) * 0.32;
            const rotationCos = Math.cos(rotation);
            const rotationSin = Math.sin(rotation);

            ctx.beginPath();
            for (let side = 0; side < sides; side += 1) {
                const angle = (Math.PI * 2 * side) / sides;
                const distance = 0.8 + random() * 0.26;
                const localX = Math.cos(angle) * majorRadius * distance;
                const localY = Math.sin(angle) * minorRadius * distance;
                const x = debrisX + localX * rotationCos - localY * rotationSin;
                const y = debrisY + localX * rotationSin + localY * rotationCos;
                if (side === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            if (random() < fillProbability) ctx.fill();
            ctx.stroke();
        }
    }

    ctx.restore();
}

export function drawOuterDebris(ctx, outer, mapTrackPoint, presentation) {
    drawBoundaryDebris(ctx, outer, mapTrackPoint, presentation, {
        inward: false,
        seedSuffix: 'outer',
        clusters: [
            { start: 0.06, end: 0.22, count: 22 },
            { start: 0.52, end: 0.68, count: 20 }
        ]
    });
}

export function drawInnerDebris(ctx, inner, mapTrackPoint, presentation) {
    drawBoundaryDebris(ctx, inner, mapTrackPoint, presentation, {
        inward: true,
        seedSuffix: 'inner',
        clusters: [
            { start: 0.12, end: 0.28, count: 14 },
            { start: 0.58, end: 0.76, count: 16 }
        ]
    });
}

export function fillTrackPresentation(ctx, surfacePath, innerPath, outerPath, width, height, presentation = {}) {
    void outerPath;
    void width;
    void height;
    ctx.fillStyle = presentation.trackColor || CONFIG.trackColor;
    ctx.fill(surfacePath, 'evenodd');
    ctx.fillStyle = presentation.infieldColor || CONFIG.offTrackColor;
    ctx.fill(innerPath);
}

export function drawTrackBoundaries(ctx, outerPath, innerPath, presentation = {}) {
    if (presentation.trackStyle === 'canyon') {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        ctx.lineWidth = presentation.canyonWallShadowWidth || 14;
        ctx.strokeStyle = presentation.canyonWallShadowColor || 'rgba(58, 34, 18, 0.24)';
        ctx.stroke(outerPath);
        ctx.stroke(innerPath);

        ctx.lineWidth = presentation.canyonWallHighlightWidth || 6;
        ctx.strokeStyle = presentation.canyonWallHighlightColor || 'rgba(245, 221, 182, 0.38)';
        ctx.stroke(outerPath);
        ctx.stroke(innerPath);

        ctx.lineWidth = presentation.canyonWallCoreWidth || 3;
        ctx.strokeStyle = presentation.canyonWallCoreColor || presentation.innerStrokeColor || '#6f4a2b';
        ctx.stroke(outerPath);
        ctx.stroke(innerPath);
        ctx.restore();
        return;
    }

    ctx.lineWidth = 4;
    ctx.strokeStyle = presentation.outerStrokeColor || '#f8fafc';
    ctx.lineJoin = 'round';
    ctx.stroke(outerPath);

    ctx.strokeStyle = presentation.innerStrokeColor || '#cbd5e1';
    ctx.stroke(innerPath);
}

export function drawTrackFinishLine(ctx, p1, p2, width, presentation = {}) {
    drawCheckeredLine(ctx, p1, p2, width, {
        primary: presentation.finishLineColor,
        secondary: presentation.finishLineAltColor
    });
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function distanceSq(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function findClosestBoundaryPlacement(points, target) {
    let best = null;

    for (let i = 0; i < points.length; i++) {
        const start = points[i];
        const end = points[(i + 1) % points.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-9) continue;

        const t = clamp01(((target.x - start.x) * dx + (target.y - start.y) * dy) / lenSq);
        const point = {
            x: start.x + dx * t,
            y: start.y + dy * t
        };
        const dist = distanceSq(point, target);
        if (!best || dist < best.dist) {
            best = {
                point,
                angle: Math.atan2(dy, dx),
                dist
            };
        }
    }

    return best || {
        point: target,
        angle: 0,
        dist: 0
    };
}

function findCheckpointBoundaryPlacement(points, checkpointStart, checkpointEnd, target) {
    const lineDx = checkpointEnd.x - checkpointStart.x;
    const lineDy = checkpointEnd.y - checkpointStart.y;
    if (lineDx * lineDx + lineDy * lineDy < 1e-9) {
        return findClosestBoundaryPlacement(points, target);
    }

    let best = null;

    for (let i = 0; i < points.length; i++) {
        const start = points[i];
        const end = points[(i + 1) % points.length];
        const segmentDx = end.x - start.x;
        const segmentDy = end.y - start.y;
        const denominator = lineDx * segmentDy - lineDy * segmentDx;
        if (Math.abs(denominator) < 1e-9) continue;

        const relX = start.x - checkpointStart.x;
        const relY = start.y - checkpointStart.y;
        const segmentT = (relX * lineDy - relY * lineDx) / denominator;
        if (segmentT < -1e-6 || segmentT > 1 + 1e-6) continue;

        const point = {
            x: start.x + segmentDx * segmentT,
            y: start.y + segmentDy * segmentT
        };
        const dist = distanceSq(point, target);
        if (!best || dist < best.dist) {
            best = {
                point,
                angle: Math.atan2(segmentDy, segmentDx),
                dist
            };
        }
    }

    return best || findClosestBoundaryPlacement(points, target);
}

// Half the curb stroke, which is centred on the boundary path.
const CURB_OUTWARD_EXTENT = 3;
// Furthest ink of a tire barrier from its anchor: the outermost tire sits at
// offset 12 with an x radius of 7.5, and the stacked pair sit 2 below centre
// with a y radius of 6. The 1px inner stroke is centred on that edge.
const TIRE_BARRIER_OUTWARD_EXTENT = Math.hypot(12 + 7.5, 2 + 6) + 0.5;
// Debris is thrown out along the boundary normal by up to 18 + 54, and slid
// along the tangent by up to half of 26.
const DEBRIS_MAX_NORMAL_OFFSET = 72;
const DEBRIS_MAX_TANGENT_OFFSET = 13;
// Each vertex of a debris shape sits at up to 1.06 of its major radius.
const DEBRIS_VERTEX_REACH = 1.06;
// Absorbs rounding in the shapes above rather than reserving whole cells.
const TRACK_CANVAS_PADDING_SAFETY = 4;

function getDebrisOutwardExtent(presentation) {
    const maxRadius = Math.max(
        Math.max(1, presentation.debrisMinRadius || 2),
        presentation.debrisMaxRadius || 10,
    );
    const stretchMin = Math.max(1, presentation.debrisStretchMin || 1);
    const stretchMax = Math.max(stretchMin, presentation.debrisStretchMax || stretchMin);
    const strokeWidth = Math.max(0.5, presentation.debrisStrokeWidth || 1.2);

    return Math.hypot(DEBRIS_MAX_NORMAL_OFFSET, DEBRIS_MAX_TANGENT_OFFSET)
        + maxRadius * stretchMax * DEBRIS_VERTEX_REACH
        + strokeWidth / 2;
}

/**
 * How far past the track polygons this presentation actually paints.
 *
 * The canvas has to cover the boundary paths plus every decoration that sits
 * outside them, and nothing else — it is sized in world pixels, so slack here
 * is paid for across the whole bounding box. Only the decorations the
 * presentation switches on contribute.
 */
export function getTrackCanvasPadding(presentation = {}) {
    let extent = 0;

    if (presentation.showCurbs !== false) {
        extent = Math.max(extent, CURB_OUTWARD_EXTENT);
    }
    if (presentation.showTireWalls !== false) {
        extent = Math.max(extent, TIRE_BARRIER_OUTWARD_EXTENT);
    }
    if (presentation.trackStyle === 'canyon') {
        extent = Math.max(
            extent,
            (presentation.canyonWallShadowWidth ?? 14) / 2,
            (presentation.canyonWallHighlightWidth ?? 6) / 2,
            (presentation.canyonWallCoreWidth ?? 3) / 2,
        );
    }
    if (presentation.debrisStyle === 'outer-drift') {
        extent = Math.max(extent, getDebrisOutwardExtent(presentation));
    }

    return Math.ceil(extent + TRACK_CANVAS_PADDING_SAFETY);
}

export function buildTrackCanvas(track, geometry, presentation = {}) {
    const gs = CONFIG.gridSize;
    const outer = geometry.outer ?? [];
    const inner = geometry.inner ?? [];

    if (outer.length < 3 || inner.length < 3) {
        return {
            canvas: null,
            origin: { x: 0, y: 0 }
        };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of [...outer, ...inner]) {
        const px = point.x * gs;
        const py = point.y * gs;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
    }

    const padding = getTrackCanvasPadding(presentation);
    const origin = {
        x: minX - padding,
        y: minY - padding
    };
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((maxX - minX) + padding * 2);
    canvas.height = Math.ceil((maxY - minY) + padding * 2);

    // Off-track area is left transparent for every presentation. The draw path
    // paints the same background across the viewport each frame before blitting
    // this bitmap over it, so baking a copy in here only stored millions of
    // pixels of one flat colour — on a typical track the ribbon covers barely a
    // fifth of the bounding box.
    const ctx = canvas.getContext('2d', { alpha: true });
    const offsetX = -origin.x;
    const offsetY = -origin.y;
    const mapTrackPoint = (point) => ({
        x: point.x * gs + offsetX,
        y: point.y * gs + offsetY
    });

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const surfacePath = new Path2D();
    let mappedPoint = mapTrackPoint(outer[0]);
    surfacePath.moveTo(mappedPoint.x, mappedPoint.y);
    for (let i = 1; i < outer.length; i++) {
        mappedPoint = mapTrackPoint(outer[i]);
        surfacePath.lineTo(mappedPoint.x, mappedPoint.y);
    }
    surfacePath.closePath();
    mappedPoint = mapTrackPoint(inner[0]);
    surfacePath.moveTo(mappedPoint.x, mappedPoint.y);
    for (let i = 1; i < inner.length; i++) {
        mappedPoint = mapTrackPoint(inner[i]);
        surfacePath.lineTo(mappedPoint.x, mappedPoint.y);
    }
    surfacePath.closePath();

    const outerPath = buildClosedPath(outer, mapTrackPoint);
    const innerPath = buildClosedPath(inner, mapTrackPoint);

    fillTrackPresentation(ctx, surfacePath, innerPath, outerPath, canvas.width, canvas.height, presentation);

    const startLine = track.startLine;
    ctx.save();
    ctx.clip(surfacePath, 'evenodd');
    drawTrackFinishLine(
        ctx,
        { x: startLine.p1.x * gs + offsetX, y: startLine.p1.y * gs + offsetY },
        { x: startLine.p2.x * gs + offsetX, y: startLine.p2.y * gs + offsetY },
        10,
        presentation
    );
    ctx.restore();

    const drawCurb = (path) => {
        ctx.lineWidth = 6;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'butt';
        ctx.setLineDash([20, 20]);
        ctx.strokeStyle = presentation.curbRed || CONFIG.curbRed;
        ctx.stroke(path);
        ctx.lineDashOffset = 20;
        ctx.strokeStyle = presentation.curbWhite || CONFIG.curbWhite;
        ctx.stroke(path);
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
    };

    if (presentation.showCurbs !== false) {
        drawCurb(outerPath);
        drawCurb(innerPath);
    }

    if (presentation.trackStyle === 'canyon') {
        drawTrackBoundaries(ctx, outerPath, innerPath, presentation);
    }

    if (presentation.showTireWalls !== false) {
        const checkpoints = track.checkpoints || [];
        for (const cp of checkpoints) {
            const outerPlacement = findCheckpointBoundaryPlacement(outer, cp.p1, cp.p2, cp.p1);
            const innerPlacement = findCheckpointBoundaryPlacement(inner, cp.p1, cp.p2, cp.p2);

            drawTireBarrier(ctx, outerPlacement.point.x * gs + offsetX, outerPlacement.point.y * gs + offsetY, outerPlacement.angle, presentation);
            drawTireBarrier(ctx, innerPlacement.point.x * gs + offsetX, innerPlacement.point.y * gs + offsetY, innerPlacement.angle, presentation);
        }
    }

    drawOuterDebris(ctx, outer, mapTrackPoint, presentation);
    drawInnerDebris(ctx, inner, mapTrackPoint, presentation);

    return { canvas, origin };
}
