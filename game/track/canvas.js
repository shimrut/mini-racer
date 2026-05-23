import { CONFIG } from '../config.js?v=1.91';

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

function buildLinearGradient(ctx, x0, y0, x1, y1, stops, fallback) {
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [offset, color] of stops) {
        gradient.addColorStop(offset, color);
    }
    return gradient || fallback;
}

function resolveBackgroundParallaxFactor(presentation = {}) {
    const rawFactor = presentation.backgroundParallaxFactor;
    if (!Number.isFinite(rawFactor)) return 1;
    return Math.max(0, Math.min(1, rawFactor));
}

function drawDesertBackdrop(ctx, width, height, presentation = {}, {
    camera = null,
    zoom = 1
} = {}) {
    void camera;
    void zoom;
    ctx.fillStyle = presentation.offTrackColor || '#8d6a3b';
    ctx.fillRect(0, 0, width, height);
}

const BIOMES = {
    meadow: {
        base: '#f1f5f9',
        blobs: ['#e2e8f0', '#cbd5e1'],
        blobScale: 400,
        density: 0.45
    },
    desert: {
        base: '#fef3c7',
        blobs: ['#fde68a', '#fcd34d'],
        blobScale: 350,
        density: 0.4
    },
    forest: {
        base: '#f0fdf4',
        blobs: ['#dcfce7', '#bbf7d0'],
        blobScale: 300,
        density: 0.55
    },
    prairie: {
        base: '#fdfcf0',
        blobs: ['#f8f7e5', '#f1f0d1'],
        blobScale: 500,
        density: 0.35
    },
    hills: {
        base: '#f8fafc',
        blobs: ['#f1f5f9', '#e2e8f0'],
        blobScale: 450,
        density: 0.4
    }
};

function drawBlobbyBackground(ctx, width, height, presentation, camera, zoom, isStatic, seedSource) {
    const biomeKey = presentation.biome || 'meadow';
    const biome = BIOMES[biomeKey] || BIOMES.meadow;
    
    ctx.fillStyle = presentation.offTrackColor || biome.base;
    ctx.fillRect(0, 0, width, height);

    const safeZoom = isStatic ? 1 : Math.max(zoom || 1, 0.001);
    const parallaxFactor = isStatic ? 1 : resolveBackgroundParallaxFactor(presentation);
    const worldLeft = isStatic ? 0 : (Number.isFinite(camera?.x) ? camera.x * parallaxFactor : 0);
    const worldTop = isStatic ? 0 : (Number.isFinite(camera?.y) ? camera.y * parallaxFactor : 0);
    const worldWidth = width / safeZoom;
    const worldHeight = height / safeZoom;

    const cellSize = biome.blobScale || 300;
    const startCellX = Math.floor(worldLeft / cellSize) - 1;
    const endCellX = Math.floor((worldLeft + worldWidth) / cellSize) + 1;
    const startCellY = Math.floor(worldTop / cellSize) - 1;
    const endCellY = Math.floor((worldTop + worldHeight) / cellSize) + 1;

    for (let cellX = startCellX; cellX <= endCellX; cellX++) {
        for (let cellY = startCellY; cellY <= endCellY; cellY++) {
            const random = createSeededRandom(`${seedSource}:${cellX}:${cellY}`);
            if (random() > (biome.density || 0.4)) continue;

            const worldX = (cellX + random()) * cellSize;
            const worldY = (cellY + random()) * cellSize;
            const radius = (0.5 + random() * 0.7) * cellSize * 0.65;
            
            const screenX = (worldX - worldLeft) * safeZoom;
            const screenY = (worldY - worldTop) * safeZoom;
            const screenRadius = radius * safeZoom;

            ctx.fillStyle = biome.blobs[Math.floor(random() * biome.blobs.length)];
            
            // Draw an organic-ish blob using overlapping circles
            ctx.beginPath();
            ctx.arc(screenX, screenY, screenRadius, 0, Math.PI * 2);
            ctx.fill();
            
            const subCount = 1 + Math.floor(random() * 3);
            for (let s = 0; s < subCount; s++) {
                const subRadius = screenRadius * (0.4 + random() * 0.5);
                const angle = random() * Math.PI * 2;
                const dist = screenRadius * (0.3 + random() * 0.4);
                ctx.beginPath();
                ctx.arc(screenX + Math.cos(angle) * dist, screenY + Math.sin(angle) * dist, subRadius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
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

function drawNeonGateFinishLine(ctx, p1, p2, width, presentation = {}) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;

    const tx = dx / length;
    const ty = dy / length;
    const nx = -ty;
    const ny = tx;
    const primaryColor = presentation.finishLineColor || '#e0f2fe';
    const secondaryColor = presentation.finishLineAltColor || 'rgba(125, 211, 252, 0.92)';
    const glowColor = presentation.finishLineGlowColor || 'rgba(56, 189, 248, 0.32)';
    const beaconColor = presentation.finishLineBeaconColor || primaryColor;
    const glowWidth = Math.max(width * 1.5, 12);
    const beamWidth = Math.max(width * 0.42, 3.5);
    const segmentWidth = Math.max(width * 0.2, 1.75);
    const beaconRadius = Math.max(width * 0.42, 3.5);
    const dashPattern = [width * 0.9, width * 0.45];
    const beamGradient = buildLinearGradient(
        ctx,
        p1.x,
        p1.y,
        p2.x,
        p2.y,
        [
            [0, secondaryColor],
            [0.28, primaryColor],
            [0.5, beaconColor],
            [0.72, primaryColor],
            [1, secondaryColor]
        ],
        primaryColor
    );

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.lineWidth = glowWidth;
    ctx.strokeStyle = glowColor;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.lineWidth = beamWidth;
    ctx.strokeStyle = beamGradient;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.lineWidth = segmentWidth;
    ctx.setLineDash(dashPattern);
    ctx.strokeStyle = beaconColor;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.lineDashOffset = dashPattern[0] * 0.5;
    ctx.strokeStyle = secondaryColor;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    const edgeHalfWidth = width * 0.62;
    for (const point of [p1, p2]) {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.lineWidth = Math.max(width * 0.22, 1.75);
        ctx.strokeStyle = beaconColor;
        ctx.beginPath();
        ctx.moveTo(point.x - nx * edgeHalfWidth, point.y - ny * edgeHalfWidth);
        ctx.lineTo(point.x + nx * edgeHalfWidth, point.y + ny * edgeHalfWidth);
        ctx.stroke();

        ctx.shadowBlur = 0;
        const beaconGlow = ctx.createRadialGradient(
            point.x,
            point.y,
            0,
            point.x,
            point.y,
            beaconRadius * 1.7
        );
        beaconGlow.addColorStop(0, beaconColor);
        beaconGlow.addColorStop(0.56, glowColor);
        beaconGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = beaconGlow;
        ctx.beginPath();
        ctx.arc(point.x, point.y, beaconRadius * 1.7, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = primaryColor;
        ctx.beginPath();
        ctx.arc(point.x, point.y, beaconRadius * 0.62, 0, Math.PI * 2);
        ctx.fill();
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
    if (presentation.backgroundStyle === 'procedural') {
        drawBlobbyBackground(ctx, width, height, presentation, null, 1, true, seed);
        return;
    }

    if (presentation.backgroundStyle === 'desert') {
        drawDesertBackdrop(ctx, width, height, presentation);
        return;
    }

    if (presentation.backgroundStyle !== 'space') {
        ctx.fillStyle = presentation.offTrackColor || CONFIG.offTrackColor;
        ctx.fillRect(0, 0, width, height);
        return;
    }

    ctx.fillStyle = presentation.offTrackColor || '#050816';
    ctx.fillRect(0, 0, width, height);

    const random = createSeededRandom(seed);
    const starDensity = Math.max(0.4, presentation.starDensity || 1);
    const stars = Math.max(42, Math.round((width * height) / 12000 * starDensity));
    for (let i = 0; i < stars; i += 1) {
        const x = random() * width;
        const y = random() * height;
        const isBright = random() < 0.14;
        const radius = isBright ? 1.3 + random() * 1.1 : 0.35 + random() * 0.8;
        ctx.globalAlpha = isBright ? 0.78 + random() * 0.18 : 0.42 + random() * 0.28;
        ctx.fillStyle = random() < 0.1
            ? (presentation.starAccentColor || 'rgba(125, 211, 252, 0.55)')
            : (presentation.starColor || 'rgba(255, 255, 255, 0.95)');
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

export function drawViewportPresentationBackground(ctx, width, height, camera = { x: 0, y: 0 }, zoom = 1, presentation = {}) {
    if (presentation.backgroundStyle === 'procedural') {
        drawBlobbyBackground(ctx, width, height, presentation, camera, zoom, false, presentation.key || 'procedural');
        return;
    }

    if (presentation.backgroundStyle === 'desert') {
        drawDesertBackdrop(ctx, width, height, presentation, { camera, zoom });
        return;
    }

    if (presentation.backgroundStyle !== 'space') {
        ctx.fillStyle = presentation.offTrackColor || CONFIG.offTrackColor;
        ctx.fillRect(0, 0, width, height);
        return;
    }

    ctx.fillStyle = presentation.offTrackColor || '#050816';
    ctx.fillRect(0, 0, width, height);

    const safeZoom = Math.max(zoom || 1, 0.001);
    const parallaxFactor = resolveBackgroundParallaxFactor(presentation);
    const starDensity = Math.max(0.4, presentation.starDensity || 1);
    const worldLeft = Number.isFinite(camera?.x) ? camera.x * parallaxFactor : 0;
    const worldTop = Number.isFinite(camera?.y) ? camera.y * parallaxFactor : 0;
    const worldWidth = width / safeZoom;
    const worldHeight = height / safeZoom;
    const cellSize = 128;
    const startCellX = Math.floor(worldLeft / cellSize) - 1;
    const endCellX = Math.floor((worldLeft + worldWidth) / cellSize) + 1;
    const startCellY = Math.floor(worldTop / cellSize) - 1;
    const endCellY = Math.floor((worldTop + worldHeight) / cellSize) + 1;

    for (let cellX = startCellX; cellX <= endCellX; cellX += 1) {
        for (let cellY = startCellY; cellY <= endCellY; cellY += 1) {
            const random = createSeededRandom(`${presentation.key || 'space'}:${cellX}:${cellY}`);
            const starCount = 1 + Math.floor(random() * 2 * starDensity);
            for (let i = 0; i < starCount; i += 1) {
                const worldX = (cellX * cellSize) + random() * cellSize;
                const worldY = (cellY * cellSize) + random() * cellSize;
                const screenX = (worldX - worldLeft) * safeZoom;
                const screenY = (worldY - worldTop) * safeZoom;
                if (screenX < -4 || screenX > width + 4 || screenY < -4 || screenY > height + 4) continue;

                const isBright = random() > 0.86;
                const radius = isBright ? 1.2 + random() * 1.1 : 0.35 + random() * 0.75;
                ctx.globalAlpha = isBright ? 0.78 + random() * 0.18 : 0.42 + random() * 0.26;
                ctx.fillStyle = random() > 0.92
                    ? (presentation.starAccentColor || 'rgba(125, 211, 252, 0.55)')
                    : (presentation.starColor || 'rgba(255, 255, 255, 0.95)');
                ctx.beginPath();
                ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
    ctx.globalAlpha = 1;
}

function drawCorridorBands(ctx, surfacePath, width, height, presentation) {
    ctx.save();
    ctx.clip(surfacePath, 'evenodd');

    const fieldGlow = ctx.createRadialGradient(
        width * 0.52,
        height * 0.5,
        Math.min(width, height) * 0.08,
        width * 0.52,
        height * 0.5,
        Math.max(width, height) * 0.58
    );
    fieldGlow.addColorStop(0, presentation.hyperspaceFieldMidColor || 'rgba(37, 99, 235, 0.18)');
    fieldGlow.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
    fieldGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = fieldGlow;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.12;
    const coreGlow = ctx.createLinearGradient(width * 0.32, 0, width * 0.68, 0);
    coreGlow.addColorStop(0, 'rgba(255, 255, 255, 0)');
    coreGlow.addColorStop(0.5, presentation.hyperspaceFieldBrightColor || 'rgba(248, 250, 252, 0.9)');
    coreGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = coreGlow;
    ctx.fillRect(width * 0.32, 0, width * 0.36, height);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.restore();
}

function drawLaneGuide(ctx, surfacePath, presentation, width, height) {
    if (!presentation.centerLineColor) return;
    ctx.save();
    ctx.clip(surfacePath, 'evenodd');
    ctx.strokeStyle = presentation.centerLineColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 12]);
    ctx.beginPath();
    ctx.moveTo(width * 0.06, height * 0.5);
    ctx.lineTo(width * 0.94, height * 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
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
    if (presentation.trackStyle === 'rails') {
        return;
    }

    if (presentation.trackStyle !== 'hyperspace-corridor') {
        ctx.fillStyle = presentation.trackColor || CONFIG.trackColor;
        ctx.fill(surfacePath, 'evenodd');
        ctx.fillStyle = presentation.infieldColor || CONFIG.offTrackColor;
        ctx.fill(innerPath);
        return;
    }

    const corridorGradient = buildLinearGradient(
        ctx,
        0,
        height * 0.18,
        width,
        height * 0.82,
        [
            [0, '#08101d'],
            [0.22, presentation.hyperspaceFieldDarkColor || '#07101f'],
            [0.5, presentation.trackColor || '#586273'],
            [0.78, presentation.hyperspaceFieldDarkColor || '#07101f'],
            [1, '#08101d']
        ],
        presentation.trackColor || '#586273'
    );

    ctx.fillStyle = corridorGradient;
    ctx.fill(surfacePath, 'evenodd');
    drawCorridorBands(ctx, surfacePath, width, height, presentation);
    drawLaneGuide(ctx, surfacePath, presentation, width, height);
}

export function drawTrackBoundaries(ctx, outerPath, innerPath, presentation = {}) {
    if (presentation.trackStyle === 'hyperspace-corridor') {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.lineWidth = 5;
        ctx.strokeStyle = presentation.outerStrokeColor || '#f8feff';
        ctx.stroke(outerPath);
        ctx.lineWidth = 4;
        ctx.strokeStyle = presentation.innerStrokeColor || 'rgba(125, 211, 252, 0.96)';
        ctx.stroke(innerPath);
        ctx.restore();
        return;
    }

    if (presentation.trackStyle === 'rails') {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const vaporLayers = Array.isArray(presentation.railVaporLayers)
            ? presentation.railVaporLayers
            : [];
        if (vaporLayers.length > 0) {
            for (const layer of vaporLayers) {
                if (!layer?.color || !Number.isFinite(layer.width) || layer.width <= 0) continue;
                ctx.shadowColor = "transparent";
                ctx.shadowBlur = 0;
                ctx.lineWidth = layer.width;
                ctx.strokeStyle = layer.color;
                ctx.stroke(outerPath);
                ctx.stroke(innerPath);
            }
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
        } else if (presentation.railHazeColor && Number.isFinite(presentation.railHazeWidth) && presentation.railHazeWidth > 0) {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.lineWidth = presentation.railHazeWidth;
            ctx.strokeStyle = presentation.railHazeColor;
            ctx.stroke(outerPath);
            ctx.stroke(innerPath);
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
        }

        ctx.lineWidth = presentation.railBandWidth || 10;
        ctx.strokeStyle = presentation.railBandColor || 'rgba(125, 211, 252, 0.18)';
        ctx.stroke(outerPath);
        ctx.stroke(innerPath);

        ctx.lineWidth = presentation.railMidWidth || 6;
        ctx.strokeStyle = presentation.railMidColor || 'rgba(224, 242, 254, 0.28)';
        ctx.stroke(outerPath);
        ctx.stroke(innerPath);

        ctx.lineWidth = presentation.railCoreWidth || 2.5;
        ctx.strokeStyle = presentation.railCoreColor || presentation.outerStrokeColor || '#f8fafc';
        ctx.stroke(outerPath);
        ctx.strokeStyle = presentation.railCoreColor || presentation.innerStrokeColor || '#cbd5e1';
        ctx.stroke(innerPath);
        ctx.restore();
        return;
    }

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

    ctx.lineWidth = presentation.trackStyle === 'rails' ? 3 : 4;
    ctx.strokeStyle = presentation.outerStrokeColor || '#f8fafc';
    ctx.lineJoin = 'round';
    ctx.stroke(outerPath);

    ctx.strokeStyle = presentation.innerStrokeColor || '#cbd5e1';
    ctx.stroke(innerPath);
}

export function drawTrackFinishLine(ctx, p1, p2, width, presentation = {}) {
    if (presentation.finishLineStyle === 'neon-gate') {
        drawNeonGateFinishLine(ctx, p1, p2, width, presentation);
        return;
    }

    if (presentation.trackStyle === 'hyperspace-corridor') {
        ctx.save();
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        drawCheckeredLine(ctx, p1, p2, width, {
            primary: presentation.finishLineColor,
            secondary: presentation.finishLineAltColor
        });
        ctx.restore();
        return;
    }

    drawCheckeredLine(ctx, p1, p2, width);
}

function findClosestPointIndex(points, target) {
    let minDist = Infinity;
    let minIndex = 0;
    for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - target.x;
        const dy = points[i].y - target.y;
        const dist = dx * dx + dy * dy;
        if (dist < minDist) {
            minDist = dist;
            minIndex = i;
        }
    }
    return minIndex;
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

    const padding = gs * 5;
    const origin = {
        x: minX - padding,
        y: minY - padding
    };
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((maxX - minX) + padding * 2);
    canvas.height = Math.ceil((maxY - minY) + padding * 2);

    const useTransparentCanvas = presentation.backgroundStyle === 'space' || presentation.backgroundStyle === 'desert' || presentation.backgroundStyle === 'procedural';
    const ctx = canvas.getContext('2d', { alpha: useTransparentCanvas });
    const offsetX = -origin.x;
    const offsetY = -origin.y;
    const mapTrackPoint = (point) => ({
        x: point.x * gs + offsetX,
        y: point.y * gs + offsetY
    });

    if (useTransparentCanvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
        drawPresentationBackground(ctx, canvas.width, canvas.height, presentation, `${track?.name || 'track'}:${canvas.width}x${canvas.height}`);
    }

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

    if (
        presentation.trackStyle === 'hyperspace-corridor'
        || presentation.trackStyle === 'rails'
        || presentation.trackStyle === 'canyon'
    ) {
        drawTrackBoundaries(ctx, outerPath, innerPath, presentation);
    }

    if (presentation.showTireWalls !== false) {
        const checkpoints = track.checkpoints || [];
        for (const cp of checkpoints) {
            const outerIdx = findClosestPointIndex(outer, cp.p1);
            const innerIdx = findClosestPointIndex(inner, cp.p2);

            const outerPoint = outer[outerIdx];
            const outerPrev = outer[(outerIdx - 1 + outer.length) % outer.length];
            const outerNext = outer[(outerIdx + 1) % outer.length];
            const outerAngle = Math.atan2(outerNext.y - outerPrev.y, outerNext.x - outerPrev.x);
            drawTireBarrier(ctx, outerPoint.x * gs + offsetX, outerPoint.y * gs + offsetY, outerAngle, presentation);

            const innerPoint = inner[innerIdx];
            const innerPrev = inner[(innerIdx - 1 + inner.length) % inner.length];
            const innerNext = inner[(innerIdx + 1) % inner.length];
            const innerAngle = Math.atan2(innerNext.y - innerPrev.y, innerNext.x - innerPrev.x);
            drawTireBarrier(ctx, innerPoint.x * gs + offsetX, innerPoint.y * gs + offsetY, innerAngle, presentation);
        }
    }

    drawOuterDebris(ctx, outer, mapTrackPoint, presentation);
    drawInnerDebris(ctx, inner, mapTrackPoint, presentation);

    return { canvas, origin };
}
