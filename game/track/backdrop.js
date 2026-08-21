import { createSeededRandom, hashSeed } from './seeded-random.js';
import {
    buildTrackDistanceIndex,
    createEnvironmentNoise,
    sampleEnvironmentProps,
} from './environment-field.js';

const FIELD_SNAP = 200;
const FIELD_MARGIN = 2000;
const SAMPLE_STEP = 72;
const TILE_SAMPLES = 12;
const TRACK_INFLUENCE_DISTANCE = 760;

const TIER_ESSENTIAL_PROPS = 0;
const TIER_MAJOR_PROPS = 1;
const TIER_ALL_PROPS = 2;

function snapDown(value) {
    return Math.floor(value / FIELD_SNAP) * FIELD_SNAP;
}

function snapUp(value) {
    return Math.ceil(value / FIELD_SNAP) * FIELD_SNAP;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function smoothstep(value) {
    const clamped = clamp01(value);
    return clamped * clamped * (3 - 2 * clamped);
}

function range(random, low, high) {
    return low + random() * (high - low);
}

function createRunoffWidthResolver(config, seedKey) {
    const phase = (hashSeed(`${seedKey}:runoff-phase`) / 4294967295) * Math.PI * 2;
    const baseWidth = config.runoffWidth ?? 64;
    const variation = config.runoffVariation ?? 18;
    return (nearest) => {
        if (!nearest) return baseWidth;
        const first = Math.sin(nearest.along * Math.PI * 6 + phase);
        const second = Math.sin(nearest.along * Math.PI * 14 + phase * 0.63);
        return baseWidth + variation * (first * 0.68 + second * 0.32);
    };
}

function shapeTerrainValue(value, style, x, y, noise, scale) {
    if (style === 'angular-elevation') {
        const ridged = Math.sign(value) * Math.pow(Math.abs(value), 0.72);
        return ridged * 0.82 + noise(x + 340, y - 190, scale * 1.9) * 0.18;
    }
    if (style === 'snow-drift') {
        return value * 0.78 + noise(x * 0.72, y * 0.72, scale * 1.8) * 0.22;
    }
    if (style === 'dunes') {
        const broadDune = Math.sin((x * 0.42 + y * 0.74) / (scale * 0.36)) * 0.13;
        return value * 0.87 + broadDune;
    }
    return value;
}

function createContourLevels(count) {
    if (count <= 1) return [0];
    return Array.from({ length: count }, (_, index) => -0.48 + (index / (count - 1)) * 0.9);
}

function addCellAboveLevel(path, level, x0, y0, x1, y1, topLeft, topRight, bottomRight, bottomLeft) {
    const code = (topLeft >= level ? 1 : 0)
        | (topRight >= level ? 2 : 0)
        | (bottomRight >= level ? 4 : 0)
        | (bottomLeft >= level ? 8 : 0);
    if (code === 0) return;

    if (code === 15) {
        path.moveTo(x0, y0);
        path.lineTo(x1, y0);
        path.lineTo(x1, y1);
        path.lineTo(x0, y1);
        path.closePath();
        return;
    }

    const cross = (a, b) => {
        const denominator = b - a;
        return Math.abs(denominator) < 1e-9 ? 0.5 : (level - a) / denominator;
    };
    const top = { x: x0 + (x1 - x0) * cross(topLeft, topRight), y: y0 };
    const right = { x: x1, y: y0 + (y1 - y0) * cross(topRight, bottomRight) };
    const bottom = { x: x0 + (x1 - x0) * cross(bottomLeft, bottomRight), y: y1 };
    const left = { x: x0, y: y0 + (y1 - y0) * cross(topLeft, bottomLeft), };
    const corners = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
    ];
    const emit = (points) => {
        path.moveTo(points[0].x, points[0].y);
        for (let index = 1; index < points.length; index += 1) {
            path.lineTo(points[index].x, points[index].y);
        }
        path.closePath();
    };

    switch (code) {
        case 1: emit([corners[0], top, left]); break;
        case 2: emit([top, corners[1], right]); break;
        case 3: emit([corners[0], corners[1], right, left]); break;
        case 4: emit([right, corners[2], bottom]); break;
        case 5: emit([corners[0], top, left]); emit([right, corners[2], bottom]); break;
        case 6: emit([top, corners[1], corners[2], bottom]); break;
        case 7: emit([corners[0], corners[1], corners[2], bottom, left]); break;
        case 8: emit([left, bottom, corners[3]]); break;
        case 9: emit([corners[0], top, bottom, corners[3]]); break;
        case 10: emit([top, corners[1], right]); emit([left, bottom, corners[3]]); break;
        case 11: emit([corners[0], corners[1], right, bottom, corners[3]]); break;
        case 12: emit([left, right, corners[2], corners[3]]); break;
        case 13: emit([corners[0], top, right, corners[2], corners[3]]); break;
        case 14: emit([top, corners[1], corners[2], corners[3], left]); break;
        default: break;
    }
}

function buildScalarLayer(values, dimensions, area, level, style) {
    const { columns, rows } = dimensions;
    const tiles = [];
    for (let tileRow = 0; tileRow < rows - 1; tileRow += TILE_SAMPLES) {
        for (let tileColumn = 0; tileColumn < columns - 1; tileColumn += TILE_SAMPLES) {
            const lastRow = Math.min(tileRow + TILE_SAMPLES, rows - 1);
            const lastColumn = Math.min(tileColumn + TILE_SAMPLES, columns - 1);
            const path = new Path2D();
            let painted = false;
            for (let row = tileRow; row < lastRow; row += 1) {
                const y0 = area.minY + row * SAMPLE_STEP;
                for (let column = tileColumn; column < lastColumn; column += 1) {
                    const index = row * columns + column;
                    const corners = [
                        values[index],
                        values[index + 1],
                        values[index + columns + 1],
                        values[index + columns],
                    ];
                    if (corners.every((value) => value < level)) continue;
                    const x0 = area.minX + column * SAMPLE_STEP;
                    addCellAboveLevel(
                        path,
                        level,
                        x0,
                        y0,
                        x0 + SAMPLE_STEP,
                        y0 + SAMPLE_STEP,
                        corners[0],
                        corners[1],
                        corners[2],
                        corners[3],
                    );
                    painted = true;
                }
            }
            if (!painted) continue;
            tiles.push({
                path,
                style,
                minX: area.minX + tileColumn * SAMPLE_STEP,
                minY: area.minY + tileRow * SAMPLE_STEP,
                maxX: area.minX + lastColumn * SAMPLE_STEP,
                maxY: area.minY + lastRow * SAMPLE_STEP,
            });
        }
    }
    return tiles;
}

function sampleEnvironment(config, area, seedKey, distanceIndex) {
    const columns = Math.round((area.maxX - area.minX) / SAMPLE_STEP) + 1;
    const rows = Math.round((area.maxY - area.minY) / SAMPLE_STEP) + 1;
    const terrain = new Float32Array(columns * rows);
    const transition = new Float32Array(columns * rows);
    const runoff = new Float32Array(columns * rows);
    const noise = createEnvironmentNoise(`${seedKey}:terrain`);
    const contourScale = 820 * (config.contourScale || 1);
    const resolveRunoffWidth = createRunoffWidthResolver(config, seedKey);
    const transitionWidth = config.transitionWidth ?? 150;

    for (let row = 0; row < rows; row += 1) {
        const y = area.minY + row * SAMPLE_STEP;
        for (let column = 0; column < columns; column += 1) {
            const x = area.minX + column * SAMPLE_STEP;
            const index = row * columns + column;
            const nearest = distanceIndex?.query(x, y, TRACK_INFLUENCE_DISTANCE) || null;
            const distance = nearest?.distance ?? TRACK_INFLUENCE_DISTANCE * 2;
            const runoffWidth = resolveRunoffWidth(nearest);
            const organic = noise(x, y, contourScale);
            const trackParallel = nearest
                ? noise(nearest.along * contourScale * 5.4, distance * 1.35, contourScale * 0.72)
                : organic;
            const influence = smoothstep(1 - distance / TRACK_INFLUENCE_DISTANCE);
            const blended = organic * (1 - influence * 0.58) + trackParallel * influence * 0.58;
            terrain[index] = shapeTerrainValue(
                blended,
                config.terrainStyle,
                x,
                y,
                noise,
                contourScale,
            );
            transition[index] = runoffWidth + transitionWidth - distance;
            runoff[index] = runoffWidth - distance;
        }
    }

    return { terrain, transition, runoff, columns, rows, resolveRunoffWidth };
}

function transformPoint(centerX, centerY, rotation, scale, x, y) {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
        x: centerX + (x * cos - y * sin) * scale,
        y: centerY + (x * sin + y * cos) * scale,
    };
}

function addPolygon(path, points) {
    path.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
        path.lineTo(points[index].x, points[index].y);
    }
    path.closePath();
}

function buildFacetedProp(random, x, y, definition, scale, rotation, count = 1) {
    const body = new Path2D();
    const accent = new Path2D();
    let radius = 0;
    for (let cluster = 0; cluster < count; cluster += 1) {
        const localScale = scale * range(random, 0.72, 1.08);
        const offsetX = count > 1 ? range(random, -22, 22) * scale : 0;
        const offsetY = count > 1 ? range(random, -15, 15) * scale : 0;
        const sides = Math.floor(range(random, 5, 8));
        const localRadius = range(random, 15, 27) * localScale;
        const points = [];
        for (let side = 0; side < sides; side += 1) {
            const angle = rotation + (side / sides) * Math.PI * 2;
            const wobble = range(random, 0.82, 1.14);
            points.push({
                x: x + offsetX + Math.cos(angle) * localRadius * wobble,
                y: y + offsetY + Math.sin(angle) * localRadius * wobble * 0.72,
            });
        }
        addPolygon(body, points);
        addPolygon(accent, [points[0], points[1], { x: x + offsetX, y: y + offsetY }]);
        radius = Math.max(radius, Math.hypot(offsetX, offsetY) + localRadius * 1.2);
    }
    return {
        layers: [
            { path: body, style: definition.color },
            { path: accent, style: definition.accentColor },
        ],
        radius,
    };
}

function buildPineProp(x, y, definition, scale, rotation) {
    const body = new Path2D();
    const accent = new Path2D();
    const tiers = [
        { top: -31, half: 17, bottom: 3 },
        { top: -19, half: 22, bottom: 16 },
        { top: -5, half: 27, bottom: 31 },
    ];
    for (const [index, tier] of tiers.entries()) {
        const points = [
            transformPoint(x, y, rotation, scale, 0, tier.top),
            transformPoint(x, y, rotation, scale, tier.half, tier.bottom),
            transformPoint(x, y, rotation, scale, -tier.half, tier.bottom),
        ];
        addPolygon(index === 0 ? accent : body, points);
    }
    return {
        layers: [
            { path: body, style: definition.color },
            { path: accent, style: definition.accentColor },
        ],
        radius: 38 * scale,
    };
}

function buildShrubProp(random, x, y, definition, scale, rotation) {
    const body = new Path2D();
    const accent = new Path2D();
    for (let clump = 0; clump < 4; clump += 1) {
        const angle = rotation + (clump / 4) * Math.PI * 2;
        const centerX = x + Math.cos(angle) * 8 * scale;
        const centerY = y + Math.sin(angle) * 5 * scale;
        const points = [];
        for (let side = 0; side < 6; side += 1) {
            const sideAngle = (side / 6) * Math.PI * 2;
            const radius = range(random, 7, 11) * scale;
            points.push({
                x: centerX + Math.cos(sideAngle) * radius,
                y: centerY + Math.sin(sideAngle) * radius * 0.72,
            });
        }
        addPolygon(clump === 0 ? accent : body, points);
    }
    return {
        layers: [
            { path: body, style: definition.color },
            { path: accent, style: definition.accentColor },
        ],
        radius: 24 * scale,
    };
}

function buildPebbleProp(random, x, y, definition, scale, rotation) {
    return buildFacetedProp(random, x, y, definition, scale * 0.42, rotation, 3);
}

function choosePropDefinition(random, definitions) {
    const totalWeight = definitions.reduce((sum, definition) => sum + (definition.weight || 1), 0);
    let target = random() * totalWeight;
    for (const definition of definitions) {
        target -= definition.weight || 1;
        if (target <= 0) return definition;
    }
    return definitions[definitions.length - 1];
}

function buildProp(point, config) {
    const random = createSeededRandom(point.seed);
    const definition = choosePropDefinition(random, config.props);
    const scale = range(random, definition.minScale ?? 0.9, definition.maxScale ?? 1.1);
    const maxRotation = definition.maxRotation ?? 0.18;
    const rotation = range(random, -maxRotation, maxRotation);
    let built;
    if (definition.type === 'pine') {
        built = buildPineProp(point.x, point.y, definition, scale, rotation);
    } else if (definition.type === 'shrub') {
        built = buildShrubProp(random, point.x, point.y, definition, scale, rotation);
    } else if (definition.type === 'pebble' || definition.type === 'ice-chip') {
        built = buildPebbleProp(random, point.x, point.y, definition, scale, rotation);
    } else {
        built = buildFacetedProp(
            random,
            point.x,
            point.y,
            definition,
            scale,
            rotation,
            definition.type === 'rock-formation' ? 3 : 1,
        );
    }
    return {
        ...built,
        x: point.x,
        y: point.y,
        type: definition.type,
        priority: random(),
        minX: point.x - built.radius,
        minY: point.y - built.radius,
        maxX: point.x + built.radius,
        maxY: point.y + built.radius,
    };
}

function buildBlob(random, x, y, radiusX, radiusY, sides = 14) {
    const path = new Path2D();
    const points = [];
    const spin = random() * Math.PI * 2;
    for (let side = 0; side < sides; side += 1) {
        const angle = spin + (side / sides) * Math.PI * 2;
        const wobble = range(random, 0.78, 1.18);
        points.push({
            x: x + Math.cos(angle) * radiusX * wobble,
            y: y + Math.sin(angle) * radiusY * wobble,
        });
    }
    addPolygon(path, points);
    return path;
}

function buildSecondaryFeatures(config, area, seedKey, distanceIndex, resolveRunoffWidth) {
    const features = [];
    const transitionWidth = config.transitionWidth ?? 150;
    const acceptsFeature = (x, y, clearance) => {
        if (distanceIndex?.containsTrack(x, y)) return false;
        const nearest = distanceIndex?.query(x, y, 1600) || null;
        if (distanceIndex && !nearest) return false;
        return !nearest || nearest.distance > resolveRunoffWidth(nearest) + transitionWidth + clearance;
    };
    const addFeaturePoints = (suffix, targetCount, spacing, clearance, build) => {
        const points = sampleEnvironmentProps({
            seedKey: `${seedKey}:feature:${suffix}`,
            area,
            minDistance: spacing,
            targetCount,
            clustering: 0.18,
            clusterRadius: spacing * 0.8,
            accept: (x, y) => acceptsFeature(x, y, clearance),
            createCandidate: distanceIndex
                ? (random) => distanceIndex.sampleNearBoundary(
                    random,
                    transitionWidth + clearance + 120,
                    Math.min(1450, transitionWidth + clearance + 760),
                )
                : null,
        });
        for (const point of points) build(point);
    };

    if (config.id === 'arctic') {
        addFeaturePoints('pond', 7, 760, 330, (point) => {
            const random = createSeededRandom(point.seed);
            const radiusX = range(random, 130, 260);
            const radiusY = range(random, 70, 150);
            features.push({
                path: buildBlob(random, point.x, point.y, radiusX, radiusY, 16),
                fillStyle: '#a9cfdb',
                minX: point.x - radiusX * 1.2,
                minY: point.y - radiusY * 1.2,
                maxX: point.x + radiusX * 1.2,
                maxY: point.y + radiusY * 1.2,
            });
            const cracks = new Path2D();
            for (let crack = 0; crack < 3; crack += 1) {
                const startX = point.x + range(random, -radiusX * 0.5, radiusX * 0.5);
                const startY = point.y + range(random, -radiusY * 0.45, radiusY * 0.45);
                cracks.moveTo(startX, startY);
                cracks.lineTo(startX + range(random, -55, 55), startY + range(random, -26, 26));
                cracks.lineTo(startX + range(random, -92, 92), startY + range(random, -46, 46));
            }
            features.push({
                path: cracks,
                strokeStyle: '#87b4c3',
                lineWidth: 2,
                minX: point.x - radiusX,
                minY: point.y - radiusY,
                maxX: point.x + radiusX,
                maxY: point.y + radiusY,
            });
        });
    } else if (config.id === 'beach') {
        addFeaturePoints('shoreline', 4, 1200, 620, (point) => {
            const random = createSeededRandom(point.seed);
            const radiusX = range(random, 260, 520);
            const radiusY = range(random, 150, 300);
            features.push({
                path: buildBlob(random, point.x, point.y, radiusX, radiusY, 18),
                fillStyle: '#416f7b',
                minX: point.x - radiusX * 1.2,
                minY: point.y - radiusY * 1.2,
                maxX: point.x + radiusX * 1.2,
                maxY: point.y + radiusY * 1.2,
            });
            features.push({
                path: buildBlob(random, point.x, point.y, radiusX * 0.8, radiusY * 0.78, 18),
                fillStyle: '#5b8790',
                minX: point.x - radiusX,
                minY: point.y - radiusY,
                maxX: point.x + radiusX,
                maxY: point.y + radiusY,
            });
        });
    } else if (config.id === 'mountains') {
        addFeaturePoints('elevation', 6, 900, 350, (point) => {
            const random = createSeededRandom(point.seed);
            const radiusX = range(random, 150, 280);
            const radiusY = range(random, 90, 180);
            features.push({
                path: buildBlob(random, point.x, point.y, radiusX, radiusY, 8),
                fillStyle: config.groundColors[1],
                minX: point.x - radiusX * 1.2,
                minY: point.y - radiusY * 1.2,
                maxX: point.x + radiusX * 1.2,
                maxY: point.y + radiusY * 1.2,
            });
        });
    }
    return features;
}

function buildProps(config, area, seedKey, distanceIndex, resolveRunoffWidth) {
    if (!config.props?.length) return [];
    const width = area.maxX - area.minX;
    const height = area.maxY - area.minY;
    const targetCount = Math.min(
        config.maxProps ?? 320,
        Math.max(18, Math.round((width * height / 1000000) * config.propDensity * 10)),
    );
    const transitionWidth = config.transitionWidth ?? 150;
    const conservativeRadius = config.maxPropRadius ?? 64;
    const clearance = config.propClearance ?? 42;
    const points = sampleEnvironmentProps({
        seedKey: `${seedKey}:props`,
        area,
        minDistance: config.propSpacing ?? (config.id === 'forest' ? 155 : 205),
        targetCount,
        clustering: config.clustering,
        clusterRadius: config.clusterRadius ?? 420,
        createCandidate: distanceIndex
            ? (random) => distanceIndex.sampleNearBoundary(
                random,
                transitionWidth + conservativeRadius + clearance + 28,
                920,
            )
            : null,
        accept(x, y) {
            if (distanceIndex?.containsTrack(x, y)) return false;
            const nearest = distanceIndex?.query(x, y, 980) || null;
            if (distanceIndex && !nearest) return false;
            return !nearest || nearest.distance > (
                resolveRunoffWidth(nearest)
                + transitionWidth
                + conservativeRadius
                + clearance
            );
        },
    });
    return points.map((point) => buildProp(point, config));
}

/** Builds one deterministic environment around the smoothed circuit geometry. */
export function buildBiomeBackdrop(presentation, bounds, seedKey, {
    geometry = null,
    worldScale = 1,
} = {}) {
    if (!presentation || presentation.backgroundStyle !== 'biome') return null;
    if (!bounds || typeof Path2D === 'undefined') return null;
    const config = presentation.biomeConfig;
    if (!config) return null;

    const area = {
        minX: snapDown(bounds.minX) - FIELD_MARGIN,
        minY: snapDown(bounds.minY) - FIELD_MARGIN,
        maxX: snapUp(bounds.maxX) + FIELD_MARGIN,
        maxY: snapUp(bounds.maxY) + FIELD_MARGIN,
    };
    const distanceIndex = buildTrackDistanceIndex(geometry, worldScale);
    const samples = sampleEnvironment(config, area, seedKey, distanceIndex);
    const dimensions = { columns: samples.columns, rows: samples.rows };
    const terrainColors = config.groundColors.slice(1, config.contourCount);
    const levels = createContourLevels(terrainColors.length);
    const terrain = [];
    terrainColors.forEach((style, index) => {
        terrain.push(...buildScalarLayer(samples.terrain, dimensions, area, levels[index], style));
    });
    const transition = buildScalarLayer(samples.transition, dimensions, area, 0, config.transitionColor);
    const runoff = buildScalarLayer(samples.runoff, dimensions, area, 0, config.runoffColor);
    const features = buildSecondaryFeatures(
        config,
        area,
        seedKey,
        distanceIndex,
        samples.resolveRunoffWidth,
    );
    const props = buildProps(
        config,
        area,
        seedKey,
        distanceIndex,
        samples.resolveRunoffWidth,
    );

    return {
        field: area,
        terrain,
        transition,
        runoff,
        features,
        props,
        groundColor: config.groundColors[0],
        configId: config.id,
        distanceIndex,
        resolveRunoffWidth: samples.resolveRunoffWidth,
    };
}

function isVisible(item, minX, minY, maxX, maxY) {
    return !(item.maxX < minX || item.minX > maxX || item.maxY < minY || item.minY > maxY);
}

function prepareTransform(ctx, width, height, offsetX, offsetY, scale) {
    const visible = {
        minX: -offsetX / scale,
        minY: -offsetY / scale,
        maxX: (width - offsetX) / scale,
        maxY: (height - offsetY) / scale,
    };
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    return visible;
}

function drawTiles(ctx, tiles, visible) {
    let painted = 0;
    let style = null;
    for (const tile of tiles) {
        if (!isVisible(tile, visible.minX, visible.minY, visible.maxX, visible.maxY)) continue;
        if (tile.style !== style) {
            ctx.fillStyle = tile.style;
            style = tile.style;
        }
        ctx.fill(tile.path);
        painted += 1;
    }
    return painted;
}

function drawFeatures(ctx, features, visible) {
    let painted = 0;
    for (const feature of features) {
        if (!isVisible(feature, visible.minX, visible.minY, visible.maxX, visible.maxY)) continue;
        if (feature.fillStyle) {
            ctx.fillStyle = feature.fillStyle;
            ctx.fill(feature.path);
        }
        if (feature.strokeStyle) {
            ctx.strokeStyle = feature.strokeStyle;
            ctx.lineWidth = feature.lineWidth || 1;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke(feature.path);
        }
        painted += 1;
    }
    return painted;
}

export function drawBiomeBackdropBase(ctx, width, height, {
    offsetX = 0,
    offsetY = 0,
    scale = 1,
    presentation = {},
    backdrop = null,
} = {}) {
    ctx.fillStyle = backdrop?.groundColor
        || presentation.biomeConfig?.groundColors?.[0]
        || presentation.biomeGround
        || presentation.offTrackColor
        || '#0b1220';
    ctx.fillRect(0, 0, width, height);
    if (!backdrop || scale <= 0) return 0;
    const visible = prepareTransform(ctx, width, height, offsetX, offsetY, scale);
    let painted = drawTiles(ctx, backdrop.terrain, visible);
    painted += drawFeatures(ctx, backdrop.features, visible);
    painted += drawTiles(ctx, backdrop.transition, visible);
    painted += drawTiles(ctx, backdrop.runoff, visible);
    ctx.restore();
    return painted;
}

export function drawBiomeBackdropProps(ctx, width, height, {
    offsetX = 0,
    offsetY = 0,
    scale = 1,
    backdrop = null,
    detailTier = TIER_ALL_PROPS,
} = {}) {
    if (!backdrop || scale <= 0) return 0;
    const visible = prepareTransform(ctx, width, height, offsetX, offsetY, scale);
    let painted = 0;
    for (const prop of backdrop.props) {
        if (detailTier <= TIER_ESSENTIAL_PROPS && prop.priority < 0.82) continue;
        if (detailTier < TIER_ALL_PROPS && prop.priority < 0.52) continue;
        if (!isVisible(prop, visible.minX, visible.minY, visible.maxX, visible.maxY)) continue;
        for (const layer of prop.layers) {
            ctx.fillStyle = layer.style;
            ctx.fill(layer.path);
        }
        painted += 1;
    }
    ctx.restore();
    return painted;
}

export function drawBiomeBackdrop(ctx, width, height, options = {}) {
    return drawBiomeBackdropBase(ctx, width, height, options)
        + drawBiomeBackdropProps(ctx, width, height, options);
}

export function resolveBackdropDetailTier(qualityLevel = 0, frameSkip = 0) {
    if (frameSkip > 0) return TIER_ESSENTIAL_PROPS;
    if (qualityLevel > 0) return TIER_MAJOR_PROPS;
    return TIER_ALL_PROPS;
}
