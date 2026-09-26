import { CONFIG } from '../config.js';
import { TRACKSIDE_ITEMS, getTracksideItemsExtent } from './trackside-items.js';

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

export function drawPresentationBackground(ctx, width, height, presentation = {}) {
    if (presentation.backgroundStyle === 'desert') {
        drawDesertBackdrop(ctx, width, height, presentation);
        return;
    }

    ctx.fillStyle = presentation.offTrackColor || CONFIG.offTrackColor;
    ctx.fillRect(0, 0, width, height);
}

// Stars behind a space track, in two layers. Each layer moves slower than
// the track, so the stars look far away. The stars of each square of sky
// come from its position, so they stay in place from frame to frame.
const STAR_LAYERS = Object.freeze([
    Object.freeze({ parallax: 0.25, cell: 90, count: 3, minSize: 1, maxSize: 1.6 }),
    Object.freeze({ parallax: 0.55, cell: 150, count: 2, minSize: 1.4, maxSize: 2.4 })
]);
// A star this large or larger has four short rays.
const STAR_RAY_MIN_SIZE = 2.1;

function drawStarField(ctx, width, height, camera, zoom, colors) {
    for (const [layerIndex, layer] of STAR_LAYERS.entries()) {
        const left = camera.x * layer.parallax;
        const top = camera.y * layer.parallax;
        const firstColumn = Math.floor(left / layer.cell);
        const lastColumn = Math.floor((left + width / zoom) / layer.cell);
        const firstRow = Math.floor(top / layer.cell);
        const lastRow = Math.floor((top + height / zoom) / layer.cell);
        const paths = colors.map(() => new Path2D());
        for (let column = firstColumn; column <= lastColumn; column += 1) {
            for (let row = firstRow; row <= lastRow; row += 1) {
                const random = createSeededRandom(`star:${layerIndex}:${column}:${row}`);
                for (let i = 0; i < layer.count; i += 1) {
                    const x = ((column + random()) * layer.cell - left) * zoom;
                    const y = ((row + random()) * layer.cell - top) * zoom;
                    const size = layer.minSize + random() * (layer.maxSize - layer.minSize);
                    const path = paths[Math.floor(random() * paths.length)];
                    path.rect(x - size / 2, y - size / 2, size, size);
                    if (size >= STAR_RAY_MIN_SIZE) {
                        const ray = size * 1.6;
                        const thin = size * 0.4;
                        path.rect(x - ray, y - thin / 2, ray * 2, thin);
                        path.rect(x - thin / 2, y - ray, thin, ray * 2);
                    }
                }
            }
        }
        paths.forEach((path, index) => {
            ctx.fillStyle = colors[index];
            ctx.fill(path);
        });
    }
}

export function drawViewportPresentationBackground(ctx, width, height, camera = { x: 0, y: 0 }, zoom = 1, presentation = {}) {
    if (presentation.backgroundStyle === 'desert') {
        drawDesertBackdrop(ctx, width, height, presentation, { camera, zoom });
        return;
    }

    ctx.fillStyle = presentation.offTrackColor || CONFIG.offTrackColor;
    ctx.fillRect(0, 0, width, height);
    if (presentation.backgroundStyle === 'space'
        && Array.isArray(presentation.starColors) && presentation.starColors.length > 0) {
        drawStarField(ctx, width, height, camera, zoom, presentation.starColors);
    }
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

// Soft flat patches of lighter and darker soil, so the road colour is uneven.
function drawSurfacePatches(ctx, width, height, presentation) {
    const colors = presentation.patchColors;
    const areaPerPatch = Number(presentation.patchAreaPerDot);
    if (!Array.isArray(colors) || colors.length === 0 || !(areaPerPatch > 0)) return;

    const random = createSeededRandom(`${presentation.key || 'track'}:patches`);
    const paths = colors.map(() => new Path2D());
    const count = Math.round((width * height) / areaPerPatch);
    for (let i = 0; i < count; i += 1) {
        const x = random() * width;
        const y = random() * height;
        const radiusX = 10 + random() * 22;
        const radiusY = radiusX * (0.45 + random() * 0.35);
        const rotation = random() * Math.PI;
        const path = paths[Math.floor(random() * paths.length)];
        path.moveTo(x + radiusX * Math.cos(rotation), y + radiusX * Math.sin(rotation));
        path.ellipse(x, y, radiusX, radiusY, rotation, 0, Math.PI * 2);
    }
    paths.forEach((path, index) => {
        ctx.fillStyle = colors[index];
        ctx.fill(path);
    });
}

// A band of loose soil that the cars push to each edge of the road.
function drawSurfaceEdgeBands(ctx, outerPath, innerPath, presentation) {
    const color = presentation.edgeBandColor;
    const bandWidth = Number(presentation.edgeBandWidth);
    if (!color || !(bandWidth > 0)) return;

    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    // Two strokes give the band a soft inner side. The clip keeps the half on the road.
    for (const lineWidth of [bandWidth * 2, bandWidth]) {
        ctx.lineWidth = lineWidth;
        ctx.stroke(outerPath);
        ctx.stroke(innerPath);
    }
}

// Sparse flat specks, so a ground reads as loose soil and not as painted tarmac.
function drawSurfaceSpeckles(ctx, width, height, presentation) {
    const colors = presentation.speckleColors;
    const areaPerSpeckle = Number(presentation.speckleAreaPerDot);
    if (!Array.isArray(colors) || colors.length === 0 || !(areaPerSpeckle > 0)) return;

    const random = createSeededRandom(`${presentation.key || 'track'}:speckles`);
    const paths = colors.map(() => new Path2D());
    const count = Math.round((width * height) / areaPerSpeckle);
    for (let i = 0; i < count; i += 1) {
        const x = random() * width;
        const y = random() * height;
        const radius = 1 + random() * 1.5;
        const path = paths[Math.floor(random() * paths.length)];
        path.moveTo(x + radius, y);
        path.arc(x, y, radius, 0, Math.PI * 2);
    }
    paths.forEach((path, index) => {
        ctx.fillStyle = colors[index];
        ctx.fill(path);
    });
}

// Points at equal steps along a closed line.
function getPointsAlongLoop(points, step) {
    const result = [];
    let carry = 0;
    for (let i = 0; i < points.length; i += 1) {
        const start = points[i];
        const end = points[(i + 1) % points.length];
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        let along = carry;
        while (along < length) {
            const t = along / length;
            result.push({
                x: start.x + (end.x - start.x) * t,
                y: start.y + (end.y - start.y) * t,
                angle: Math.atan2(end.y - start.y, end.x - start.x)
            });
            along += step;
        }
        carry = along - length;
    }
    return result;
}

// Flat patches of ice on the road. Each patch has straight edges and lies
// along the road. Two short glints catch the light from the top left.
const ICE_GLINT_ANGLE = -Math.PI / 4;

function addIcePatch(path, x, y, halfLength, halfWidth, angle, random) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corners = 7 + Math.floor(random() * 4);
    for (let i = 0; i < corners; i += 1) {
        const turn = (Math.PI * 2 * (i + (random() - 0.5) * 0.5)) / corners;
        const reach = 0.75 + random() * 0.25;
        const localX = Math.cos(turn) * halfLength * reach;
        const localY = Math.sin(turn) * halfWidth * reach;
        const px = x + localX * cos - localY * sin;
        const py = y + localX * sin + localY * cos;
        if (i === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
    }
    path.closePath();
}

function drawIcePatches(ctx, outer, inner, presentation) {
    const color = presentation.icePatchColor;
    const spacing = Number(presentation.icePatchSpacing);
    if (!color || !(spacing > 0) || inner.length === 0) return;

    const random = createSeededRandom(`${presentation.key || 'track'}:ice`);
    const icePath = new Path2D();
    const glintPath = new Path2D();
    const glintCos = Math.cos(ICE_GLINT_ANGLE);
    const glintSin = Math.sin(ICE_GLINT_ANGLE);
    for (const edge of getPointsAlongLoop(outer, spacing)) {
        if (random() < 0.4) continue;
        let across = inner[0];
        let bestDistSq = Infinity;
        for (const point of inner) {
            const distSq = distanceSq(point, edge);
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                across = point;
            }
        }
        const roadWidth = Math.sqrt(bestDistSq);
        const t = 0.25 + random() * 0.5;
        const x = edge.x + (across.x - edge.x) * t;
        const y = edge.y + (across.y - edge.y) * t;
        const cos = Math.cos(edge.angle);
        const sin = Math.sin(edge.angle);
        const halfLength = roadWidth * (0.25 + random() * 0.25);
        const halfWidth = roadWidth * (0.08 + random() * 0.08);
        const angle = edge.angle + (random() - 0.5) * 0.3;
        addIcePatch(icePath, x, y, halfLength, halfWidth, angle, random);
        // Two short parallel glints, the second one shorter.
        const along = (random() * 2 - 1) * halfLength * 0.3;
        const glintLength = 5 + random() * 4;
        for (let i = 0; i < 2; i += 1) {
            const glintX = x + cos * along + glintSin * 5 * i;
            const glintY = y + sin * along - glintCos * 5 * i;
            const length = glintLength * (1 - i * 0.45);
            glintPath.moveTo(glintX - glintCos * length, glintY - glintSin * length);
            glintPath.lineTo(glintX + glintCos * length, glintY + glintSin * length);
        }
    }
    ctx.fillStyle = color;
    ctx.fill(icePath);
    if (presentation.icePatchGlintColor) {
        ctx.strokeStyle = presentation.icePatchGlintColor;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.stroke(glintPath);
    }
}

// Small wave marks on water: one or two short arcs side by side, all
// upright, as in a drawn map.
function drawWaveMarks(ctx, width, height, presentation) {
    const color = presentation.waveColor;
    const areaPerMark = Number(presentation.waveAreaPerMark);
    if (!color || !(areaPerMark > 0)) return;

    const random = createSeededRandom(`${presentation.key || 'track'}:waves`);
    const path = new Path2D();
    const count = Math.round((width * height) / areaPerMark);
    for (let i = 0; i < count; i += 1) {
        const x = random() * width;
        const y = random() * height;
        const radius = 4 + random() * 3;
        const arcs = random() < 0.45 ? 2 : 1;
        for (let arc = 0; arc < arcs; arc += 1) {
            const cx = x + arc * radius * 1.55;
            const cy = y + radius * 0.6;
            const start = -Math.PI * 0.82;
            path.moveTo(cx + Math.cos(start) * radius, cy + Math.sin(start) * radius);
            path.arc(cx, cy, radius, start, -Math.PI * 0.18);
        }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.stroke(path);
}

// A grid of thin lines on a space lane. The car moves over it, so the
// grid shows the speed.
function drawSurfaceGrid(ctx, width, height, presentation) {
    const color = presentation.gridColor;
    const spacing = Number(presentation.gridSpacing);
    if (!color || !(spacing > 0)) return;

    const path = new Path2D();
    for (let x = spacing / 2; x < width; x += spacing) {
        path.moveTo(x, 0);
        path.lineTo(x, height);
    }
    for (let y = spacing / 2; y < height; y += spacing) {
        path.moveTo(0, y);
        path.lineTo(width, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke(path);
}

// The texture of a ground: a grid, patches, ice, edge bands, waves and
// specks, only on the road.
function drawSurfaceTexture(ctx, surfacePath, outer, inner, outerPath, innerPath, width, height, presentation) {
    ctx.save();
    ctx.clip(surfacePath, 'evenodd');
    drawSurfaceGrid(ctx, width, height, presentation);
    drawSurfacePatches(ctx, width, height, presentation);
    drawIcePatches(ctx, outer, inner, presentation);
    drawSurfaceEdgeBands(ctx, outerPath, innerPath, presentation);
    drawWaveMarks(ctx, width, height, presentation);
    drawSurfaceSpeckles(ctx, width, height, presentation);
    ctx.restore();
}

// The size of each lump of a bank along a closed line. The bank swells and
// narrows slowly along its length, and each lump is a little different.
function getBankLumps(points, step, minRadius, maxRadius, random) {
    const phaseA = random() * Math.PI * 2;
    const phaseB = random() * Math.PI * 2;
    return getPointsAlongLoop(points, step).map((point, index) => {
        const along = index * step;
        const swell = 0.5 + 0.3 * Math.sin(along / 70 + phaseA) + 0.2 * Math.sin(along / 23 + phaseB);
        const size = 0.55 * swell + 0.45 * random();
        return { x: point.x, y: point.y, radius: minRadius + size * (maxRadius - minRadius) };
    });
}

function addBankLumps(path, lumps, radiusScale = 1, offsetX = 0, offsetY = 0) {
    for (const lump of lumps) {
        const radius = lump.radius * radiusScale;
        const x = lump.x + offsetX;
        const y = lump.y + offsetY;
        path.moveTo(x + radius, y);
        path.arc(x, y, radius, 0, Math.PI * 2);
    }
}

const BANK_LUMP_STEP = 7;
const BANK_LIP_MIN_RADIUS = 2;
const BANK_LIP_MAX_RADIUS = 5;
// The light comes from the top left. Each lump has a shade to the lower right
// and a bright top to the upper left.
const BANK_SHADE_OFFSET_X = 1.5;
const BANK_SHADE_OFFSET_Y = 2;
const BANK_LIGHT_OFFSET_X = -1.2;
const BANK_LIGHT_OFFSET_Y = -1.5;
const BANK_LIGHT_SCALE = 0.6;

// One band of lumps along both edges of the road, only inside the clip.
// colors gives the base, shade and light colours of the lumps. extraLumps
// are more lumps in the same band, such as a mound under a bush.
function drawBankLumpBand(ctx, clipPath, outer, inner, minRadius, maxRadius, seed, colors, extraLumps = []) {
    const shadePath = new Path2D();
    const bankPath = new Path2D();
    const lightPath = new Path2D();
    for (const [side, points] of [['outer', outer], ['inner', inner]]) {
        const random = createSeededRandom(`${seed}:${side}`);
        const lumps = getBankLumps(points, BANK_LUMP_STEP, minRadius, maxRadius, random);
        addBankLumps(shadePath, lumps, 1, BANK_SHADE_OFFSET_X, BANK_SHADE_OFFSET_Y);
        addBankLumps(bankPath, lumps);
        addBankLumps(lightPath, lumps, BANK_LIGHT_SCALE, BANK_LIGHT_OFFSET_X, BANK_LIGHT_OFFSET_Y);
    }
    addBankLumps(shadePath, extraLumps, 1, BANK_SHADE_OFFSET_X, BANK_SHADE_OFFSET_Y);
    addBankLumps(bankPath, extraLumps);
    addBankLumps(lightPath, extraLumps, BANK_LIGHT_SCALE, BANK_LIGHT_OFFSET_X, BANK_LIGHT_OFFSET_Y);
    ctx.save();
    ctx.clip(clipPath, 'evenodd');
    ctx.fillStyle = colors.shade || colors.base;
    ctx.fill(shadePath);
    ctx.fillStyle = colors.base;
    ctx.fill(bankPath);
    if (colors.light) {
        ctx.fillStyle = colors.light;
        ctx.fill(lightPath);
    }
    ctx.restore();
}

function hasEdgeBanks(presentation) {
    return Boolean(presentation.bankColor) && Number(presentation.bankWidth) > 0;
}

// A bank of piled snow, earth or sand along each edge of the road, in place
// of kerbs. Large lumps sit off the road. Small lumps make a soft lip on the
// road: a lip colour makes it a line of foam on water. A soft shadow on the
// road at the foot of the bank makes the bank stand up. A sharp foot line
// in its place marks the wall, so the edge of the road is easy to see.
// mounds are more lumps of the bank, under the things that stand on it.
function drawEdgeBanks(ctx, surfacePath, outerPath, innerPath, outer, inner, width, height, presentation, mounds = []) {
    const bankWidth = Number(presentation.bankWidth);
    if (!hasEdgeBanks(presentation)) return;

    const shadowColor = presentation.bankShadowColor;
    if (shadowColor) {
        ctx.save();
        ctx.clip(surfacePath, 'evenodd');
        ctx.strokeStyle = shadowColor;
        ctx.lineJoin = 'round';
        // Two strokes give the shadow a soft side, as for the edge bands.
        for (const lineWidth of [BANK_LIP_MAX_RADIUS * 5, BANK_LIP_MAX_RADIUS * 3]) {
            ctx.lineWidth = lineWidth;
            ctx.stroke(outerPath);
            ctx.stroke(innerPath);
        }
        ctx.restore();
    }
    const footLineColor = presentation.bankFootLineColor;
    const footLineWidth = Number(presentation.bankFootLineWidth);
    if (footLineColor && footLineWidth > 0) {
        ctx.save();
        ctx.clip(surfacePath, 'evenodd');
        ctx.strokeStyle = footLineColor;
        ctx.lineJoin = 'round';
        // The clip keeps the half of the stroke that is on the road.
        ctx.lineWidth = footLineWidth * 2;
        ctx.stroke(outerPath);
        ctx.stroke(innerPath);
        ctx.restore();
    }

    // Everything off the road: the whole canvas less the road.
    const offRoadPath = new Path2D();
    offRoadPath.rect(0, 0, width, height);
    offRoadPath.addPath(surfacePath);

    const seed = `${presentation.key || 'track'}:bank`;
    const bankColors = {
        base: presentation.bankColor,
        shade: presentation.bankShadeColor,
        light: presentation.bankLightColor
    };
    const lipColors = presentation.bankLipColor
        ? { base: presentation.bankLipColor, shade: presentation.bankLipShadeColor, light: null }
        : bankColors;
    drawBankLumpBand(ctx, offRoadPath, outer, inner, bankWidth * 0.4, bankWidth, `${seed}:bank`, bankColors, mounds);
    const lipMaxRadius = Number(presentation.bankLipMaxRadius) || BANK_LIP_MAX_RADIUS;
    drawBankLumpBand(ctx, surfacePath, outer, inner,
        Math.min(BANK_LIP_MIN_RADIUS, lipMaxRadius), lipMaxRadius, `${seed}:lip`, lipColors);
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

// How far each corner of a painted square can move, as a part of the square.
const FINISH_PAINT_JITTER = 0.14;

// A finish line painted on a loose ground, as chalk on soil or dye in snow.
// The corners of the squares move a little, so the paint looks uneven. With
// no second colour, the road shows between the painted squares.
function drawPaintedFinishLine(ctx, p1, p2, width, presentation) {
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
    const jitter = Math.min(cellLength, rowHeight) * FINISH_PAINT_JITTER;
    const random = createSeededRandom(`${presentation.key || 'track'}:finish`);
    const corners = [];
    for (let row = 0; row <= rows; row += 1) {
        const line = [];
        for (let col = 0; col <= columns; col += 1) {
            const along = col * cellLength + (col > 0 && col < columns ? (random() - 0.5) * 2 * jitter : 0);
            const across = -width / 2 + row * rowHeight + (random() - 0.5) * 2 * jitter;
            line.push({ x: p1.x + tx * along + nx * across, y: p1.y + ty * along + ny * across });
        }
        corners.push(line);
    }

    const addCell = (row, col) => {
        const a = corners[row][col];
        const b = corners[row][col + 1];
        const c = corners[row + 1][col + 1];
        const d = corners[row + 1][col];
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.closePath();
    };
    ctx.save();
    for (const [color, parity] of [[presentation.finishLineAltColor, 1], [presentation.finishLineColor, 0]]) {
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < columns; col += 1) {
                if ((row + col) % 2 === parity) addCell(row, col);
            }
        }
        ctx.fill();
    }
    ctx.restore();
}

export function drawTrackFinishLine(ctx, p1, p2, width, presentation = {}) {
    if (presentation.finishLineStyle === 'painted') {
        drawPaintedFinishLine(ctx, p1, p2, width, presentation);
        return;
    }
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

const CURB_OUTWARD_EXTENT = 3;
const TIRE_BARRIER_OUTWARD_EXTENT = Math.hypot(12 + 7.5, 2 + 6) + 0.5;
const DEBRIS_MAX_NORMAL_OFFSET = 72;
const DEBRIS_MAX_TANGENT_OFFSET = 13;
const DEBRIS_VERTEX_REACH = 1.06;
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

export function getTrackCanvasPadding(presentation = {}) {
    let extent = 0;

    if (presentation.showCurbs !== false) {
        extent = Math.max(extent, CURB_OUTWARD_EXTENT);
    }
    if (presentation.showTireWalls !== false) {
        extent = Math.max(extent, TIRE_BARRIER_OUTWARD_EXTENT);
    }
    const tracksideNames = [
        ...(Array.isArray(presentation.tracksideItems) ? presentation.tracksideItems.map(([name]) => name) : []),
        ...(presentation.finishMarker ? [presentation.finishMarker] : [])
    ];
    if (tracksideNames.length > 0) {
        extent = Math.max(extent, getTracksideGap(presentation) + getTracksideItemsExtent(tracksideNames));
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
    if (presentation.bankColor && Number(presentation.bankWidth) > 0) {
        extent = Math.max(
            extent,
            Number(presentation.bankWidth) + Math.hypot(BANK_SHADE_OFFSET_X, BANK_SHADE_OFFSET_Y),
        );
    }

    return Math.ceil(extent + TRACK_CANVAS_PADDING_SAFETY);
}

// Picks an item from [name, weight] pairs.
function pickTracksideItem(choices, random) {
    const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = random() * total;
    for (const [name, weight] of choices) {
        roll -= weight;
        if (roll < 0) return name;
    }
    return choices[choices.length - 1][0];
}

// True when no part of a circle is on the road.
function isCircleOffRoad(ctx, surfacePath, x, y, radius) {
    if (ctx.isPointInPath(surfacePath, x, y, 'evenodd')) return false;
    for (let i = 0; i < 12; i += 1) {
        const angle = (Math.PI * 2 * i) / 12;
        if (ctx.isPointInPath(surfacePath, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, 'evenodd')) {
            return false;
        }
    }
    return true;
}

// The gap between the road and the nearest part of a trackside item.
const TRACKSIDE_MIN_GAP = 3;
// On a bank, the middle of an item stands on the middle of the bank, as a
// part of the bank width. A large item can hang over the road edge.
const TRACKSIDE_BANK_MIDDLE = 0.5;
// On a bank, the bank swells into a mound under each item, this much wider
// than the item. The mound is lumps round a middle lump, as the bank is.
const TRACKSIDE_MOUND_RIM = 3;
const TRACKSIDE_MOUND_LUMPS = 6;
// The chance of a second and a third item in a group.
const TRACKSIDE_SECOND_CHANCE = 0.75;
const TRACKSIDE_THIRD_CHANCE = 0.35;
// Items in a group touch a little.
const TRACKSIDE_GROUP_SPACING = 0.85;
// The edge direction at a point is the direction over this distance to each
// side, so that it does not jump at the corners of the edge line.
const TRACKSIDE_DIRECTION_SPAN = 10;
// Steps, in pixels, to move an item along or away from the edge.
const TRACKSIDE_MOVE_STEP = 2;
const TRACKSIDE_MAX_MOVES = 40;

// The farthest that the nearest part of an item can be from the road.
function getTracksideGap(presentation) {
    // With kerbs, as in space, the items keep clear of the kerb.
    const kerbGap = presentation.showCurbs !== false ? CURB_OUTWARD_EXTENT + TRACKSIDE_MIN_GAP : 0;
    return Math.max(TRACKSIDE_MIN_GAP, kerbGap, Number(presentation.bankWidth) || 0);
}

// A walk along a closed road edge, by the distance from its first point.
function createEdgeWalk(points) {
    const starts = [0];
    for (let i = 0; i < points.length; i += 1) {
        const start = points[i];
        const end = points[(i + 1) % points.length];
        starts.push(starts[i] + Math.hypot(end.x - start.x, end.y - start.y));
    }
    const length = starts[points.length];
    const pointAt = (distance) => {
        const along = ((distance % length) + length) % length;
        let low = 0;
        let high = points.length;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (starts[middle] <= along) low = middle;
            else high = middle;
        }
        const start = points[low];
        const end = points[(low + 1) % points.length];
        const t = (along - starts[low]) / ((starts[low + 1] - starts[low]) || 1);
        return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
    };
    // The distance along the edge of the edge point nearest to `point`.
    const locate = (point) => {
        let best = 0;
        let bestDistSq = Infinity;
        for (let i = 0; i < points.length; i += 1) {
            const start = points[i];
            const end = points[(i + 1) % points.length];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const lengthSq = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
            const distSq = distanceSq({ x: start.x + dx * t, y: start.y + dy * t }, point);
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                best = starts[i] + (starts[i + 1] - starts[i]) * t;
            }
        }
        return best;
    };
    return { length, pointAt, locate };
}

// The direction at a point on the road edge out to the side away from the
// road, for an edge that runs at `angle`.
function getEdgeFrame(ctx, surfacePath, point, angle) {
    let normalX = -Math.sin(angle);
    let normalY = Math.cos(angle);
    if (ctx.isPointInPath(surfacePath, point.x + normalX * 4, point.y + normalY * 4, 'evenodd')) {
        normalX = -normalX;
        normalY = -normalY;
    }
    return { normalX, normalY, facing: Math.atan2(-normalY, -normalX) };
}

// Where an item of this size stands beside the road, `distance` along the
// edge of `side`: on the middle of the bank when there is a bank, and off
// the road otherwise. Returns null when it does not fit there.
function findTracksideSpot(ctx, surfacePath, side, distance, item, size, presentation) {
    const point = side.walk.pointAt(distance);
    const behind = side.walk.pointAt(distance - TRACKSIDE_DIRECTION_SPAN);
    const ahead = side.walk.pointAt(distance + TRACKSIDE_DIRECTION_SPAN);
    const frame = getEdgeFrame(ctx, surfacePath, point, Math.atan2(ahead.y - behind.y, ahead.x - behind.x));
    const reach = size * item.reach;
    const gap = getTracksideGap(presentation);
    const onBank = hasEdgeBanks(presentation);
    let out = onBank ? Number(presentation.bankWidth) * TRACKSIDE_BANK_MIDDLE : gap + reach;
    // How far the item can hang over the road edge here.
    const overhang = onBank ? Math.max(0, size - out + 1) : 0;
    // Past this, the item leaves the room that the track image has for it.
    const farthest = gap + reach;
    const at = () => ({ x: point.x + frame.normalX * out, y: point.y + frame.normalY * out });
    while (out <= farthest && !isCircleOffRoad(ctx, surfacePath, at().x, at().y, reach - overhang)) {
        out += TRACKSIDE_MOVE_STEP;
    }
    if (out > farthest) return null;
    return { ...at(), distance, reach, facing: frame.facing };
}

// Where the next item of a group stands: along the edge from its neighbour,
// in `direction`, so that the two only just touch.
function findTracksideNeighbourSpot(ctx, surfacePath, side, neighbour, direction, item, size, presentation) {
    const wanted = (neighbour.reach + size * item.reach) * TRACKSIDE_GROUP_SPACING;
    let distance = neighbour.distance + direction * wanted * 0.5;
    for (let move = 0; move < TRACKSIDE_MAX_MOVES; move += 1) {
        const spot = findTracksideSpot(ctx, surfacePath, side, distance, item, size, presentation);
        if (spot && Math.hypot(spot.x - neighbour.x, spot.y - neighbour.y) >= wanted) return spot;
        distance += direction * TRACKSIDE_MOVE_STEP;
    }
    return null;
}

// A small group of items beside the road at a distance along an edge. The
// largest item stands in the middle, and the others to each side of it,
// along the edge. Adds each item to `planned`.
function planTracksideGroup(ctx, surfacePath, side, distance, presentation, random, planned) {
    let count = 1;
    if (random() < TRACKSIDE_SECOND_CHANCE) count += 1;
    if (count === 2 && random() < TRACKSIDE_THIRD_CHANCE) count += 1;
    const picks = [];
    for (let i = 0; i < count; i += 1) {
        const item = TRACKSIDE_ITEMS[pickTracksideItem(presentation.tracksideItems, random)];
        if (!item) continue;
        picks.push({ item, size: item.minSize + random() * (item.maxSize - item.minSize) });
    }
    picks.sort((a, b) => b.size * b.item.reach - a.size * a.item.reach);
    if (picks.length === 0) return;

    const middle = findTracksideSpot(ctx, surfacePath, side, distance, picks[0].item, picks[0].size, presentation);
    if (!middle) return;
    planned.push({ ...picks[0], spot: middle, random });
    // The last item on each side of the group: [forward, back].
    const ends = [middle, middle];
    picks.slice(1).forEach(({ item, size }, i) => {
        const end = i % 2;
        const direction = end === 0 ? 1 : -1;
        const spot = findTracksideNeighbourSpot(ctx, surfacePath, side, ends[end], direction, item, size, presentation);
        if (!spot) return;
        planned.push({ item, size, spot, random });
        ends[end] = spot;
    });
}

// Where every trackside item stands: the groups at the checkpoints, and the
// item at each end of the finish line, such as a hay bale with a flag. Each
// planned item keeps the random source to draw it with.
function planTracksideItems(ctx, surfacePath, sides, track, mapTrackPoint, presentation) {
    const planned = [];
    const key = presentation.key || 'track';
    if (presentation.showTireWalls === false
        && Array.isArray(presentation.tracksideItems) && presentation.tracksideItems.length > 0) {
        const random = createSeededRandom(`${key}:trackside`);
        for (const cp of track.checkpoints || []) {
            for (const [side, end] of [[sides.outer, cp.p1], [sides.inner, cp.p2]]) {
                const placement = findCheckpointBoundaryPlacement(side.points, cp.p1, cp.p2, end);
                const distance = side.walk.locate(mapTrackPoint(placement.point));
                planTracksideGroup(ctx, surfacePath, side, distance, presentation, random, planned);
            }
        }
    }
    const marker = TRACKSIDE_ITEMS[presentation.finishMarker];
    const startLine = track.startLine;
    if (marker && startLine?.p1 && startLine?.p2) {
        const random = createSeededRandom(`${key}:finish-markers`);
        for (const [side, end] of [[sides.outer, startLine.p1], [sides.inner, startLine.p2]]) {
            const placement = findCheckpointBoundaryPlacement(side.points, startLine.p1, startLine.p2, end);
            const distance = side.walk.locate(mapTrackPoint(placement.point));
            const spot = findTracksideSpot(ctx, surfacePath, side, distance, marker, marker.maxSize, presentation);
            if (spot) planned.push({ item: marker, size: marker.maxSize, spot, random });
        }
    }
    return planned;
}

// The mound of bank under a planned item: lumps round a middle lump. The
// lumps join the bank, so the item looks planted in it.
function getTracksideMoundLumps(planned) {
    const lumps = [];
    for (const { size, spot } of planned) {
        const radius = size + TRACKSIDE_MOUND_RIM;
        lumps.push({ x: spot.x, y: spot.y, radius: radius * 0.7 });
        const turn = spot.facing;
        for (let i = 0; i < TRACKSIDE_MOUND_LUMPS; i += 1) {
            const angle = turn + (Math.PI * 2 * i) / TRACKSIDE_MOUND_LUMPS;
            lumps.push({
                x: spot.x + Math.cos(angle) * radius * 0.45,
                y: spot.y + Math.sin(angle) * radius * 0.45,
                radius: radius * 0.55
            });
        }
    }
    return lumps;
}

function drawTracksideItems(ctx, planned) {
    for (const { item, size, spot, random } of planned) {
        ctx.save();
        item.draw(ctx, spot.x, spot.y, size, { random, facing: spot.facing });
        ctx.restore();
    }
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

    const mappedOuter = outer.map(mapTrackPoint);
    const mappedInner = inner.map(mapTrackPoint);

    fillTrackPresentation(ctx, surfacePath, innerPath, outerPath, canvas.width, canvas.height, presentation);
    drawSurfaceTexture(ctx, surfacePath, mappedOuter, mappedInner, outerPath, innerPath, canvas.width, canvas.height, presentation);

    const startLine = track.startLine;
    ctx.save();
    ctx.clip(surfacePath, 'evenodd');
    drawTrackFinishLine(
        ctx,
        { x: startLine.p1.x * gs + offsetX, y: startLine.p1.y * gs + offsetY },
        { x: startLine.p2.x * gs + offsetX, y: startLine.p2.y * gs + offsetY },
        Number(presentation.finishLineWidth) || 10,
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

    // Each road edge, for the things that stand beside it.
    const sides = {
        outer: { points: outer, walk: createEdgeWalk(mappedOuter) },
        inner: { points: inner, walk: createEdgeWalk(mappedInner) }
    };
    // The items are placed before the bank is drawn, so that the bank can
    // swell into a mound under each of them.
    const tracksideItems = planTracksideItems(ctx, surfacePath, sides, track, mapTrackPoint, presentation);
    drawEdgeBanks(ctx, surfacePath, outerPath, innerPath, mappedOuter, mappedInner, canvas.width, canvas.height,
        presentation, getTracksideMoundLumps(tracksideItems));

    if (presentation.trackStyle === 'canyon') {
        drawTrackBoundaries(ctx, outerPath, innerPath, presentation);
    }

    const checkpoints = track.checkpoints || [];
    if (presentation.showTireWalls !== false) {
        for (const cp of checkpoints) {
            const outerPlacement = findCheckpointBoundaryPlacement(outer, cp.p1, cp.p2, cp.p1);
            const innerPlacement = findCheckpointBoundaryPlacement(inner, cp.p1, cp.p2, cp.p2);

            drawTireBarrier(ctx, outerPlacement.point.x * gs + offsetX, outerPlacement.point.y * gs + offsetY, outerPlacement.angle, presentation);
            drawTireBarrier(ctx, innerPlacement.point.x * gs + offsetX, innerPlacement.point.y * gs + offsetY, innerPlacement.angle, presentation);
        }
    }
    drawTracksideItems(ctx, tracksideItems);

    drawOuterDebris(ctx, outer, mapTrackPoint, presentation);
    drawInnerDebris(ctx, inner, mapTrackPoint, presentation);

    return { canvas, origin };
}
