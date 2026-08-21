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

const TIER_ESSENTIAL_PROPS = 0;
const TIER_MAJOR_PROPS = 1;
const TIER_ALL_PROPS = 2;

function snapDown(value) {
    return Math.floor(value / FIELD_SNAP) * FIELD_SNAP;
}

function snapUp(value) {
    return Math.ceil(value / FIELD_SNAP) * FIELD_SNAP;
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
    const transitionWidth = config.transitionWidth ?? 46;

    for (let row = 0; row < rows; row += 1) {
        const y = area.minY + row * SAMPLE_STEP;
        for (let column = 0; column < columns; column += 1) {
            const x = area.minX + column * SAMPLE_STEP;
            const index = row * columns + column;
            const localDistance = (config.runoffWidth ?? 32)
                + (config.runoffVariation ?? 8)
                + transitionWidth;
            const nearest = distanceIndex?.query(x, y, localDistance) || null;
            const distance = nearest?.distance ?? localDistance * 2;
            const runoffWidth = resolveRunoffWidth(nearest);
            const organic = noise(x, y, contourScale);
            terrain[index] = shapeTerrainValue(
                organic,
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
    const isBiomeDefiningProp = (
        (point.regionType === 'forest-grove' && definition.type === 'pine')
        || (point.regionType === 'mountain-ridge' && definition.type === 'rock-formation')
        || (point.regionType === 'arctic-rock-cluster' && definition.type === 'snowy-rock')
        || (point.regionType === 'beach-rock-cluster' && definition.type === 'rock')
    );
    return {
        ...built,
        x: point.x,
        y: point.y,
        type: definition.type,
        // Keep each biome's defining silhouette in the lowest detail tier. The
        // candidates stay bounded and viewport-culled, so this preserves the
        // geography read without bringing every small prop back on slow frames.
        priority: isBiomeDefiningProp ? 1 : random(),
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

function buildWorldFeatures(config, area, seedKey) {
    const features = [];
    const regions = [];
    const areaSize = (area.maxX - area.minX) * (area.maxY - area.minY);
    const regionCount = (squarePixelsPerRegion, minimum, maximum) => Math.max(
        minimum,
        Math.min(maximum, Math.round(areaSize / squarePixelsPerRegion)),
    );
    const addRegions = (suffix, targetCount, spacing, create) => {
        // Stratified world cells give large geography even coverage without
        // consulting the circuit. Uniform rejection left screen-sized holes,
        // making a Forest or Mountain race sometimes show no defining region.
        const cellSize = Math.max(spacing, Math.sqrt(areaSize / targetCount));
        const firstCellX = Math.floor(area.minX / cellSize);
        const lastCellX = Math.floor(area.maxX / cellSize);
        const firstCellY = Math.floor(area.minY / cellSize);
        const lastCellY = Math.floor(area.maxY / cellSize);
        for (let cellY = firstCellY; cellY <= lastCellY; cellY += 1) {
            for (let cellX = firstCellX; cellX <= lastCellX; cellX += 1) {
                const cellSeed = `${seedKey}:region:${suffix}:${cellX}:${cellY}`;
                const random = createSeededRandom(cellSeed);
                const point = {
                    x: (cellX + range(random, 0.2, 0.8)) * cellSize,
                    y: (cellY + range(random, 0.2, 0.8)) * cellSize,
                    seed: cellSeed,
                };
                if (point.x < area.minX || point.x > area.maxX
                    || point.y < area.minY || point.y > area.maxY) continue;
                create(point, random);
            }
        }
    };
    const addRegion = (point, type, radiusX, radiusY, propTypes = []) => {
        const region = {
            x: point.x,
            y: point.y,
            type,
            radiusX,
            radiusY,
            propTypes,
            seed: point.seed,
            minX: point.x - radiusX * 1.2,
            minY: point.y - radiusY * 1.2,
            maxX: point.x + radiusX * 1.2,
            maxY: point.y + radiusY * 1.2,
        };
        regions.push(region);
        return region;
    };
    const addFill = (region, random, fillStyle, sides = 16, scale = 1) => {
        features.push({
            path: buildBlob(
                random,
                region.x,
                region.y,
                region.radiusX * scale,
                region.radiusY * scale,
                sides,
            ),
            fillStyle,
            semanticType: region.type,
            minX: region.x - region.radiusX * scale * 1.2,
            minY: region.y - region.radiusY * scale * 1.2,
            maxX: region.x + region.radiusX * scale * 1.2,
            maxY: region.y + region.radiusY * scale * 1.2,
        });
    };
    const addForestCanopy = (region, random) => {
        const body = new Path2D();
        const accent = new Path2D();
        const treeCount = Math.round(range(random, 11, 18));
        for (let tree = 0; tree < treeCount; tree += 1) {
            const angle = random() * Math.PI * 2;
            const radius = Math.sqrt(random());
            const x = region.x + Math.cos(angle) * region.radiusX * radius * 0.72;
            const y = region.y + Math.sin(angle) * region.radiusY * radius * 0.68;
            const scale = range(random, 0.78, 1.16);
            const tiers = [
                { top: -31, half: 17, bottom: 3 },
                { top: -18, half: 22, bottom: 17 },
                { top: -4, half: 27, bottom: 31 },
            ];
            tiers.forEach((tier, index) => addPolygon(index === 0 ? accent : body, [
                { x, y: y + tier.top * scale },
                { x: x + tier.half * scale, y: y + tier.bottom * scale },
                { x: x - tier.half * scale, y: y + tier.bottom * scale },
            ]));
        }
        const bounds = {
            minX: region.x - region.radiusX,
            minY: region.y - region.radiusY,
            maxX: region.x + region.radiusX,
            maxY: region.y + region.radiusY,
        };
        features.push({
            path: body,
            fillStyle: '#071412',
            semanticType: 'forest-canopy',
            ...bounds,
        });
        features.push({
            path: accent,
            fillStyle: '#255245',
            semanticType: 'forest-canopy-highlight',
            ...bounds,
        });
    };
    const addRegionRidges = (
        region,
        random,
        strokeStyle,
        semanticType,
        { count = 3, lineWidth = 3, amplitude = 0.14 } = {},
    ) => {
        const path = new Path2D();
        const rotation = random() * Math.PI * 2;
        for (let ridge = 0; ridge < count; ridge += 1) {
            const offset = (ridge - (count - 1) / 2) * region.radiusY * 0.28;
            for (let step = 0; step <= 8; step += 1) {
                const amount = step / 8;
                const localX = (amount * 2 - 1) * region.radiusX * 0.76;
                const localY = offset
                    + Math.sin(amount * Math.PI * 2 + ridge * 0.8) * region.radiusY * amplitude;
                const point = transformPoint(region.x, region.y, rotation, 1, localX, localY);
                if (step === 0) path.moveTo(point.x, point.y);
                else path.lineTo(point.x, point.y);
            }
        }
        features.push({
            path,
            strokeStyle,
            lineWidth,
            semanticType,
            minX: region.minX,
            minY: region.minY,
            maxX: region.maxX,
            maxY: region.maxY,
        });
    };
    const addMountainRocks = (region, random) => {
        const body = new Path2D();
        const accent = new Path2D();
        const count = Math.round(range(random, 6, 11));
        for (let rock = 0; rock < count; rock += 1) {
            const angle = random() * Math.PI * 2;
            const radius = Math.sqrt(random());
            const x = region.x + Math.cos(angle) * region.radiusX * radius * 0.68;
            const y = region.y + Math.sin(angle) * region.radiusY * radius * 0.62;
            const size = range(random, 18, 34);
            const sides = Math.round(range(random, 5, 8));
            const points = [];
            for (let side = 0; side < sides; side += 1) {
                const sideAngle = side / sides * Math.PI * 2;
                points.push({
                    x: x + Math.cos(sideAngle) * size * range(random, 0.8, 1.15),
                    y: y + Math.sin(sideAngle) * size * range(random, 0.55, 0.82),
                });
            }
            addPolygon(body, points);
            addPolygon(accent, [points[0], points[1], { x, y }]);
        }
        features.push({
            path: body,
            fillStyle: '#0c1424',
            semanticType: 'mountain-rock-field',
            minX: region.minX,
            minY: region.minY,
            maxX: region.maxX,
            maxY: region.maxY,
        });
        features.push({
            path: accent,
            fillStyle: '#40506a',
            semanticType: 'mountain-rock-highlight',
            minX: region.minX,
            minY: region.minY,
            maxX: region.maxX,
            maxY: region.maxY,
        });
    };

    if (config.id === 'forest') {
        addRegions('grove', regionCount(1_250_000, 12, 36), 620, (point, random) => {
            const region = addRegion(
                point,
                'forest-grove',
                range(random, 380, 650),
                range(random, 300, 520),
                ['pine', 'shrub'],
            );
            addFill(region, random, config.groundColors[1], 18);
            addForestCanopy(region, random);
        });
        addRegions('clearing', regionCount(5_000_000, 4, 10), 920, (point, random) => {
            const region = addRegion(
                point,
                'forest-clearing',
                range(random, 180, 340),
                range(random, 140, 280),
            );
            addFill(region, random, config.groundColors[3], 17);
        });
        addRegions('rock-group', regionCount(3_000_000, 4, 14), 720, (point, random) => {
            addRegion(point, 'forest-rock-group', range(random, 150, 260), range(random, 120, 210), ['rock']);
        });
    } else if (config.id === 'mountains') {
        addRegions('ridge', regionCount(1_500_000, 12, 32), 720, (point, random) => {
            const region = addRegion(
                point,
                'mountain-ridge',
                range(random, 620, 1100),
                range(random, 220, 420),
                ['rock-formation', 'boulder'],
            );
            addFill(region, random, config.groundColors[1], 8);
            addFill(region, random, config.groundColors[3], 7, 0.63);
            addRegionRidges(region, random, '#40506a', 'mountain-ridge-lines', {
                count: 2,
                lineWidth: 4,
                amplitude: 0.18,
            });
            addMountainRocks(region, random);
        });
        addRegions('boulder-field', regionCount(2_800_000, 6, 18), 700, (point, random) => {
            addRegion(point, 'boulder-field', range(random, 220, 380), range(random, 170, 300), ['boulder']);
        });
        addRegions('sparse-trees', regionCount(5_000_000, 3, 10), 980, (point, random) => {
            addRegion(point, 'mountain-tree-line', range(random, 240, 390), range(random, 170, 290), ['pine']);
        });
    } else if (config.id === 'arctic') {
        addRegions('snowdrift', regionCount(1_300_000, 12, 34), 620, (point, random) => {
            const region = addRegion(
                point,
                'snowdrift',
                range(random, 480, 800),
                range(random, 180, 340),
                ['snowy-rock', 'ice-chip'],
            );
            addFill(region, random, config.groundColors[1], 18);
            addRegionRidges(region, random, 'rgba(247, 252, 253, 0.62)', 'snowdrift-lines', {
                count: 3,
                lineWidth: 3,
                amplitude: 0.12,
            });
        });
        addRegions('lake', regionCount(6_000_000, 3, 8), 960, (point, random) => {
            const region = addRegion(
                point,
                'frozen-lake',
                range(random, 220, 430),
                range(random, 120, 250),
            );
            addFill(region, random, '#a9cfdb', 18);
            const cracks = new Path2D();
            for (let crack = 0; crack < 4; crack += 1) {
                const startX = point.x + range(random, -region.radiusX * 0.45, region.radiusX * 0.45);
                const startY = point.y + range(random, -region.radiusY * 0.4, region.radiusY * 0.4);
                cracks.moveTo(startX, startY);
                cracks.lineTo(startX + range(random, -60, 60), startY + range(random, -28, 28));
                cracks.lineTo(startX + range(random, -105, 105), startY + range(random, -52, 52));
            }
            features.push({
                path: cracks,
                strokeStyle: '#87b4c3',
                lineWidth: 2,
                semanticType: 'ice-cracks',
                minX: region.minX,
                minY: region.minY,
                maxX: region.maxX,
                maxY: region.maxY,
            });
        });
        addRegions('rock-cluster', regionCount(3_000_000, 5, 14), 760, (point, random) => {
            addRegion(point, 'arctic-rock-cluster', range(random, 170, 290), range(random, 130, 230), ['snowy-rock']);
        });
    } else if (config.id === 'beach') {
        addRegions('water', regionCount(8_000_000, 2, 7), 1250, (point, random) => {
            const region = addRegion(
                point,
                'water-body',
                range(random, 700, 1200),
                range(random, 400, 650),
            );
            addFill(region, random, '#b4935d', 20, 1.14);
            features[features.length - 1].semanticType = 'wet-sand';
            addFill(region, random, '#416f7b', 20);
            addFill(region, random, '#5b8790', 20, 0.76);
        });
        addRegions('dune', regionCount(1_500_000, 12, 32), 560, (point, random) => {
            const region = addRegion(
                point,
                'dune-field',
                range(random, 450, 750),
                range(random, 170, 300),
                ['rock', 'pebble'],
            );
            addFill(region, random, config.groundColors[2], 18);
            addRegionRidges(region, random, 'rgba(247, 220, 166, 0.52)', 'dune-crests', {
                count: 3,
                lineWidth: 3,
                amplitude: 0.16,
            });
        });
        addRegions('pebble-cluster', regionCount(2_800_000, 6, 16), 650, (point, random) => {
            addRegion(point, 'beach-rock-cluster', range(random, 150, 260), range(random, 110, 200), ['rock', 'pebble']);
        });
    }

    return { features, regions };
}

function buildProps(config, area, seedKey, regions, distanceIndex, resolveRunoffWidth) {
    if (!config.props?.length) return { candidates: [], accepted: [] };
    const width = area.maxX - area.minX;
    const height = area.maxY - area.minY;
    const targetCount = Math.min(
        config.maxProps ?? 320,
        Math.max(18, Math.round((width * height / 1000000) * config.propDensity * 10)),
    );
    const transitionWidth = config.transitionWidth ?? 46;
    const conservativeRadius = config.maxPropRadius ?? 64;
    const clearance = config.propClearance ?? 42;
    const propRegions = regions.filter((region) => region.propTypes.length > 0);
    const points = sampleEnvironmentProps({
        seedKey: `${seedKey}:props`,
        area,
        minDistance: config.propSpacing ?? (config.id === 'forest' ? 155 : 205),
        targetCount,
        clustering: 0,
        createCandidate(random) {
            if (propRegions.length === 0) return null;
            const region = propRegions[Math.floor(random() * propRegions.length)];
            const radius = Math.sqrt(random());
            const angle = random() * Math.PI * 2;
            return {
                x: region.x + Math.cos(angle) * region.radiusX * radius,
                y: region.y + Math.sin(angle) * region.radiusY * radius,
                regionType: region.type,
                propTypes: region.propTypes,
            };
        },
    });
    const maxExclusionDistance = (config.runoffWidth ?? 32)
        + (config.runoffVariation ?? 8)
        + transitionWidth
        + conservativeRadius
        + clearance;
    const accepted = points.filter((point) => {
        if (distanceIndex?.containsTrack(point.x, point.y)) return false;
        const nearest = distanceIndex?.query(point.x, point.y, maxExclusionDistance) || null;
        return !nearest || nearest.distance > (
            resolveRunoffWidth(nearest)
            + transitionWidth
            + conservativeRadius
            + clearance
        );
    });
    return {
        candidates: points,
        accepted: accepted.map((point) => buildProp(point, {
            ...config,
            props: point.propTypes?.length
                ? config.props.filter((definition) => point.propTypes.includes(definition.type))
                : config.props,
        })),
    };
}

/** Builds one deterministic world, then applies only track-local masks and prop exclusion. */
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
    const worldFeatures = buildWorldFeatures(config, area, seedKey);
    const propLayout = buildProps(
        config,
        area,
        seedKey,
        worldFeatures.regions,
        distanceIndex,
        samples.resolveRunoffWidth,
    );

    return {
        field: area,
        terrain,
        transition,
        runoff,
        features: worldFeatures.features,
        regions: worldFeatures.regions,
        propCandidates: propLayout.candidates,
        props: propLayout.accepted,
        groundColor: config.groundColors[0],
        configId: config.id,
        distanceIndex,
        resolveRunoffWidth: samples.resolveRunoffWidth,
        trackLocalExtent: {
            min: (config.runoffWidth ?? 32)
                - (config.runoffVariation ?? 8)
                + (config.transitionWidth ?? 46),
            max: (config.runoffWidth ?? 32)
                + (config.runoffVariation ?? 8)
                + (config.transitionWidth ?? 46),
        },
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
