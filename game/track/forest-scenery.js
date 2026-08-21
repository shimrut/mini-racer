import { createSeededRandom, hashSeed } from './seeded-random.js';

const TAU = Math.PI * 2;

export const FOREST_GROUND_MASS_TEMPLATES = Object.freeze([
    Object.freeze({
        id: 'forest-ground-mass-01',
        radius: 360,
        points: Object.freeze([
            [-330, -72], [-252, -235], [-76, -286], [116, -252], [306, -126],
            [342, 54], [214, 226], [24, 276], [-188, 218], [-346, 82],
        ]),
    }),
    Object.freeze({
        id: 'forest-ground-mass-02',
        radius: 330,
        points: Object.freeze([
            [-302, -118], [-174, -250], [24, -222], [188, -274], [294, -112],
            [260, 74], [118, 226], [-62, 242], [-242, 174], [-318, 24],
        ]),
    }),
    Object.freeze({
        id: 'forest-ground-mass-03',
        radius: 350,
        points: Object.freeze([
            [-318, -42], [-268, -202], [-104, -266], [84, -210], [236, -246],
            [326, -82], [282, 112], [116, 254], [-98, 270], [-274, 162],
        ]),
    }),
]);

const TREE_SHAPE = Object.freeze([
    Object.freeze([0, -30]), Object.freeze([18, 2]), Object.freeze([12, 2]),
    Object.freeze([24, 28]), Object.freeze([-24, 28]), Object.freeze([-12, 2]),
    Object.freeze([-18, 2]),
]);

export const FOREST_CLUSTER_TEMPLATES = Object.freeze([
    Object.freeze({
        id: 'forest-cluster-01', radius: 168,
        trees: Object.freeze([[-126, -46, 1.04], [-70, -92, 0.86], [-24, -74, 1.12], [76, -82, 0.92], [124, -30, 1.08], [-104, 54, 0.9], [-34, 66, 1.02], [88, 54, 0.84]]),
        vegetation: Object.freeze([[-82, 10, 14], [32, -4, 18], [112, 76, 12]]),
    }),
    Object.freeze({
        id: 'forest-cluster-02', radius: 176,
        trees: Object.freeze([[-132, -70, 0.88], [-78, -22, 1.08], [-52, 72, 0.92], [6, 92, 1.14], [66, 50, 0.82], [130, 72, 1.0], [106, -52, 1.12], [26, -82, 0.9]]),
        vegetation: Object.freeze([[-118, 32, 13], [22, 18, 16], [72, -20, 12]]),
    }),
    Object.freeze({
        id: 'forest-cluster-03', radius: 172,
        trees: Object.freeze([[-128, 20, 1.08], [-92, -68, 0.82], [-28, -96, 1.02], [42, -58, 0.9], [126, -78, 1.06], [104, 20, 0.86], [56, 88, 1.1], [-54, 76, 0.94]]),
        vegetation: Object.freeze([[-30, -12, 18], [24, 24, 12], [-112, 78, 11]]),
    }),
]);

export const FOREST_ROCK_FORMATION_TEMPLATES = Object.freeze([
    Object.freeze({
        id: 'forest-rock-formation-01', radius: 112,
        rocks: Object.freeze([
            Object.freeze({ x: -54, y: 10, scale: 1.05, points: Object.freeze([[-34, -18], [4, -32], [36, -8], [25, 26], [-18, 30]]) }),
            Object.freeze({ x: 22, y: -18, scale: 0.82, points: Object.freeze([[-30, -12], [-4, -28], [28, -10], [22, 24], [-20, 22]]) }),
            Object.freeze({ x: 62, y: 30, scale: 0.58, points: Object.freeze([[-28, -12], [0, -24], [26, -5], [18, 22], [-20, 18]]) }),
        ]),
    }),
    Object.freeze({
        id: 'forest-rock-formation-02', radius: 118,
        rocks: Object.freeze([
            Object.freeze({ x: -62, y: -24, scale: 0.7, points: Object.freeze([[-32, -14], [-8, -30], [28, -16], [34, 14], [0, 30], [-28, 16]]) }),
            Object.freeze({ x: 2, y: 18, scale: 1.08, points: Object.freeze([[-38, -16], [-10, -34], [30, -22], [40, 10], [12, 34], [-32, 26]]) }),
            Object.freeze({ x: 70, y: -18, scale: 0.64, points: Object.freeze([[-26, -18], [8, -28], [30, 0], [16, 26], [-24, 20]]) }),
        ]),
    }),
]);

const VEGETATION_TEMPLATES = Object.freeze([
    Object.freeze({ id: 'forest-vegetation-01', radius: 74, plants: Object.freeze([[-46, -10, 13], [-12, 18, 18], [28, -18, 11], [48, 22, 15]]) }),
    Object.freeze({ id: 'forest-vegetation-02', radius: 78, plants: Object.freeze([[-50, 18, 12], [-18, -22, 15], [18, 8, 11], [50, -12, 17]]) }),
    Object.freeze({ id: 'forest-vegetation-03', radius: 72, plants: Object.freeze([[-42, -18, 15], [-8, -4, 10], [20, 22, 17], [46, -12, 12]]) }),
]);

export const FOREST_COMPOSITION_RECIPES = Object.freeze([
    Object.freeze({
        id: 'FOREST_A',
        large: Object.freeze([[0.78, 0.18], [0.88, 0.38], [0.72, 0.72], [0.2, 0.82], [0.08, 0.56], [0.22, 0.18], [0.5, 0.08], [0.48, 0.9]]),
        medium: Object.freeze([[0.78, 0.24], [0.84, 0.52], [0.68, 0.76], [0.2, 0.74], [0.12, 0.42], [0.34, 0.16]]),
        rocks: Object.freeze([[0.92, 0.12], [0.9, 0.86], [0.1, 0.9], [0.08, 0.12]]),
        vegetation: Object.freeze([[0.62, 0.14], [0.84, 0.7], [0.32, 0.82], [0.14, 0.3]]),
    }),
    Object.freeze({
        id: 'FOREST_B',
        large: Object.freeze([[0.1, 0.14], [0.14, 0.36], [0.1, 0.62], [0.18, 0.84], [0.76, 0.18], [0.84, 0.48], [0.74, 0.82]]),
        medium: Object.freeze([[0.12, 0.2], [0.16, 0.44], [0.12, 0.72], [0.74, 0.22], [0.84, 0.5], [0.7, 0.76], [0.5, 0.9]]),
        rocks: Object.freeze([[0.92, 0.1], [0.9, 0.9], [0.42, 0.08]]),
        vegetation: Object.freeze([[0.28, 0.14], [0.28, 0.82], [0.78, 0.64], [0.58, 0.12]]),
    }),
    Object.freeze({
        id: 'FOREST_C',
        large: Object.freeze([[0.12, 0.2], [0.5, 0.08], [0.86, 0.22], [0.84, 0.76], [0.48, 0.9], [0.14, 0.72]]),
        medium: Object.freeze([[0.24, 0.18], [0.72, 0.18], [0.82, 0.58], [0.58, 0.82], [0.18, 0.66]]),
        rocks: Object.freeze([[0.08, 0.08], [0.92, 0.08], [0.92, 0.9], [0.08, 0.9], [0.5, 0.94]]),
        vegetation: Object.freeze([[0.34, 0.1], [0.88, 0.46], [0.28, 0.86]]),
    }),
]);

function range(random, min, max) {
    return min + random() * (max - min);
}

function transformedPoint(x, y, rotation, scaleX, scaleY, pointX, pointY) {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
        x: x + pointX * scaleX * cos - pointY * scaleY * sin,
        y: y + pointX * scaleX * sin + pointY * scaleY * cos,
    };
}

function addPolygon(path, points) {
    path.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) path.lineTo(points[index].x, points[index].y);
    path.closePath();
}

function makeLayersFeature({ template, x, y, rotation, scale, mirror, palette, paletteIndex, kind, buildLayers }) {
    const scaleX = scale * mirror;
    const scaleY = scale;
    const layers = buildLayers(template, x, y, rotation, scaleX, scaleY, palette);
    const radius = template.radius * scale;
    return {
        kind,
        semanticType: kind,
        templateId: template.id,
        x, y, rotation, scale, mirror,
        paletteIndex,
        footprintRadius: radius,
        minX: x - radius,
        minY: y - radius,
        maxX: x + radius,
        maxY: y + radius,
        layers,
    };
}

function buildGroundLayers(template, x, y, rotation, scaleX, scaleY, palette) {
    const path = new Path2D();
    addPolygon(path, template.points.map(([px, py]) => transformedPoint(x, y, rotation, scaleX, scaleY, px, py)));
    return [{ path, style: palette.ground }];
}

function addTree(path, x, y, rotation, scaleX, scaleY, tree) {
    const [treeX, treeY, treeScale] = tree;
    addPolygon(path, TREE_SHAPE.map(([px, py]) => transformedPoint(
        x, y, rotation, scaleX, scaleY,
        treeX + px * treeScale, treeY + py * treeScale,
    )));
}

function addPlant(path, x, y, rotation, scaleX, scaleY, plant) {
    const [plantX, plantY, radius] = plant;
    const points = [];
    for (let side = 0; side < 6; side += 1) {
        const angle = side / 6 * TAU;
        points.push(transformedPoint(
            x, y, rotation, scaleX, scaleY,
            plantX + Math.cos(angle) * radius,
            plantY + Math.sin(angle) * radius * 0.68,
        ));
    }
    addPolygon(path, points);
}

function buildClusterLayers(template, x, y, rotation, scaleX, scaleY, palette) {
    const trees = new Path2D();
    const highlights = new Path2D();
    const plants = new Path2D();
    template.trees.forEach((tree, index) => addTree(index % 3 === 1 ? highlights : trees, x, y, rotation, scaleX, scaleY, tree));
    template.vegetation.forEach((plant) => addPlant(plants, x, y, rotation, scaleX, scaleY, plant));
    return [
        { path: trees, style: palette.tree },
        { path: highlights, style: palette.highlight },
        { path: plants, style: palette.vegetation },
    ];
}

function buildRockLayers(template, x, y, rotation, scaleX, scaleY, palette) {
    const body = new Path2D();
    const accent = new Path2D();
    template.rocks.forEach((rock) => {
        const points = rock.points.map(([px, py]) => transformedPoint(
            x, y, rotation, scaleX, scaleY,
            rock.x + px * rock.scale, rock.y + py * rock.scale,
        ));
        addPolygon(body, points);
        addPolygon(accent, [points[0], points[1], transformedPoint(x, y, rotation, scaleX, scaleY, rock.x, rock.y)]);
    });
    return [{ path: body, style: palette.rock }, { path: accent, style: palette.rockAccent }];
}

function buildVegetationLayers(template, x, y, rotation, scaleX, scaleY, palette) {
    const path = new Path2D();
    template.plants.forEach((plant) => addPlant(path, x, y, rotation, scaleX, scaleY, plant));
    return [{ path, style: palette.vegetation }];
}

const PALETTES = Object.freeze([
    Object.freeze({ ground: '#173a32', tree: '#12382e', highlight: '#34705a', vegetation: '#285043', rock: '#334542', rockAccent: '#52675f' }),
    Object.freeze({ ground: '#1c4338', tree: '#153d31', highlight: '#3a775d', vegetation: '#2d5647', rock: '#374a46', rockAccent: '#586d64' }),
    Object.freeze({ ground: '#214a3d', tree: '#184235', highlight: '#408066', vegetation: '#315d4c', rock: '#3b4e49', rockAccent: '#5e7469' }),
]);

/** Distance-only shoulder field. Forest never samples terrain noise. */
export function sampleForestShoulder({ seedKey, area, distanceIndex, sampleStep = 24 }) {
    const columns = Math.round((area.maxX - area.minX) / sampleStep) + 1;
    const rows = Math.round((area.maxY - area.minY) / sampleStep) + 1;
    const values = new Float32Array(columns * rows);
    const phase = (hashSeed(`${seedKey}:phase`) / 4294967295) * TAU;
    const resolveWidth = (nearest) => {
        const along = nearest?.along ?? 0;
        const broad = Math.sin(along * TAU * 3 + phase) * 10.2;
        const detail = Math.sin(along * TAU * 7 + phase * 0.61) * 4.8;
        return 45 + broad + detail;
    };
    for (let row = 0; row < rows; row += 1) {
        const y = area.minY + row * sampleStep;
        for (let column = 0; column < columns; column += 1) {
            const x = area.minX + column * sampleStep;
            const nearest = distanceIndex?.query(x, y, 62) || null;
            values[row * columns + column] = resolveWidth(nearest) - (nearest?.distance ?? 120);
        }
    }
    return { values, columns, rows, sampleStep, resolveWidth };
}

export function analyzeForestTrack(distanceIndex) {
    const outer = distanceIndex?.outer || [];
    if (outer.length < 3) return { bounds: null, majorCorners: [] };
    const bounds = outer.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x),
        minY: Math.min(result.minY, point.y),
        maxX: Math.max(result.maxX, point.x),
        maxY: Math.max(result.maxY, point.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const candidates = outer.map((point, index) => {
        const previous = outer[(index - 1 + outer.length) % outer.length];
        const next = outer[(index + 1) % outer.length];
        const incoming = { x: point.x - previous.x, y: point.y - previous.y };
        const outgoing = { x: next.x - point.x, y: next.y - point.y };
        const inLength = Math.hypot(incoming.x, incoming.y) || 1;
        const outLength = Math.hypot(outgoing.x, outgoing.y) || 1;
        const dot = Math.max(-1, Math.min(1, (
            incoming.x * outgoing.x + incoming.y * outgoing.y
        ) / (inLength * outLength)));
        return { x: point.x, y: point.y, curvature: Math.acos(dot), index };
    }).sort((a, b) => b.curvature - a.curvature);
    const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const separation = Math.max(180, diagonal * 0.11);
    const majorCorners = [];
    for (const candidate of candidates) {
        if (candidate.curvature < 0.08 && majorCorners.length >= 3) break;
        if (majorCorners.some((corner) => Math.hypot(candidate.x - corner.x, candidate.y - corner.y) < separation)) continue;
        majorCorners.push(candidate);
        if (majorCorners.length === 6) break;
    }
    return { bounds, majorCorners };
}

function candidateFromSlot(slot, area, random, attempt) {
    const width = area.maxX - area.minX;
    const height = area.maxY - area.minY;
    const jitter = attempt === 0 ? 0.035 : Math.min(0.2, 0.05 + attempt * 0.012);
    return {
        x: area.minX + (slot[0] + range(random, -jitter, jitter)) * width,
        y: area.minY + (slot[1] + range(random, -jitter, jitter)) * height,
    };
}

function isPlacementClear(candidate, footprintRadius, area, distanceIndex, trackAnalysis, clearance, cornerClearance) {
    if (candidate.x - footprintRadius < area.minX || candidate.x + footprintRadius > area.maxX
        || candidate.y - footprintRadius < area.minY || candidate.y + footprintRadius > area.maxY) return false;
    if (distanceIndex?.containsTrack(candidate.x, candidate.y)) return false;
    const nearest = distanceIndex?.query(candidate.x, candidate.y, footprintRadius + clearance) || null;
    if (nearest && nearest.distance <= footprintRadius + clearance) return false;
    if (cornerClearance > clearance && trackAnalysis.majorCorners.some((corner) => (
        Math.hypot(candidate.x - corner.x, candidate.y - corner.y) <= footprintRadius + cornerClearance
    ))) return false;
    return true;
}

function placeFeature({ random, slot, area, compositionArea, distanceIndex, trackAnalysis, template, kind, clearance, cornerClearance = clearance, scaleRange, paletteIndex, buildLayers }) {
    const scale = range(random, scaleRange[0], scaleRange[1]);
    const footprintRadius = template.radius * scale;
    for (let attempt = 0; attempt < 28; attempt += 1) {
        const candidate = candidateFromSlot(slot, compositionArea, random, attempt);
        if (!isPlacementClear(candidate, footprintRadius, area, distanceIndex, trackAnalysis, clearance, cornerClearance)) continue;
        return makeLayersFeature({
            template,
            ...candidate,
            rotation: range(random, -Math.PI, Math.PI),
            scale,
            mirror: random() < 0.5 ? -1 : 1,
            palette: PALETTES[paletteIndex],
            paletteIndex,
            kind,
            buildLayers,
        });
    }
    return null;
}

function rotateVector(x, y, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function placeAssociatedFeature({ random, anchors, area, distanceIndex, trackAnalysis, template, kind, clearance, cornerClearance = clearance, scaleRange, paletteIndex, buildLayers, overlap = 0.5 }) {
    const scale = range(random, scaleRange[0], scaleRange[1]);
    const footprintRadius = template.radius * scale;
    const trackCenter = trackAnalysis.bounds ? {
        x: (trackAnalysis.bounds.minX + trackAnalysis.bounds.maxX) / 2,
        y: (trackAnalysis.bounds.minY + trackAnalysis.bounds.maxY) / 2,
    } : anchors.reduce((center, anchor) => ({
        x: center.x + anchor.x / anchors.length,
        y: center.y + anchor.y / anchors.length,
    }), { x: 0, y: 0 });
    for (let attempt = 0; attempt < 42; attempt += 1) {
        const anchor = anchors[attempt % anchors.length];
        const towardX = trackCenter.x - anchor.x;
        const towardY = trackCenter.y - anchor.y;
        const length = Math.hypot(towardX, towardY) || 1;
        const angle = range(random, -0.78, 0.78);
        const direction = rotateVector(towardX / length, towardY / length, angle);
        const distance = Math.max(18, anchor.footprintRadius * range(random, overlap * 0.62, overlap));
        const candidate = { x: anchor.x + direction.x * distance, y: anchor.y + direction.y * distance };
        if (!isPlacementClear(candidate, footprintRadius, area, distanceIndex, trackAnalysis, clearance, cornerClearance)) continue;
        return makeLayersFeature({
            template,
            ...candidate,
            rotation: range(random, -Math.PI, Math.PI),
            scale,
            mirror: random() < 0.5 ? -1 : 1,
            palette: PALETTES[paletteIndex],
            paletteIndex,
            kind,
            buildLayers,
        });
    }
    return null;
}

/** Builds a deterministic authored Forest composition around the track. */
export function buildAuthoredForestScenery({ seedKey, area, compositionArea = area, distanceIndex }) {
    const random = createSeededRandom(`${seedKey}:authored-forest`);
    const recipe = FOREST_COMPOSITION_RECIPES[Math.floor(random() * FOREST_COMPOSITION_RECIPES.length)];
    const trackAnalysis = analyzeForestTrack(distanceIndex);
    const largeFeatures = recipe.large.map((slot, index) => placeFeature({
        random,
        slot,
        area,
        compositionArea,
        distanceIndex,
        trackAnalysis,
        template: FOREST_GROUND_MASS_TEMPLATES[index % FOREST_GROUND_MASS_TEMPLATES.length],
        kind: 'forest-ground-mass',
        clearance: 100,
        cornerClearance: 130,
        scaleRange: [0.82, 1.12],
        paletteIndex: Math.floor(random() * PALETTES.length),
        buildLayers: buildGroundLayers,
    })).filter(Boolean);
    const buildAssociatedSet = (slots, templates, anchors, options) => {
        if (anchors.length === 0) return [];
        return slots.map((slot, index) => {
            const anchorIndex = Math.round(
                index * Math.max(0, anchors.length - 1) / Math.max(1, slots.length - 1),
            );
            const orderedAnchors = [...anchors.slice(anchorIndex), ...anchors.slice(0, anchorIndex)];
            return placeAssociatedFeature({
                random,
                anchors: orderedAnchors,
                area,
                distanceIndex,
                trackAnalysis,
                template: templates[index % templates.length],
                paletteIndex: Math.floor(random() * PALETTES.length),
                ...options,
            });
        }).filter(Boolean);
    };
    const mediumFeatures = buildAssociatedSet(recipe.medium, FOREST_CLUSTER_TEMPLATES, largeFeatures, {
        kind: 'forest-cluster', clearance: 64, cornerClearance: 104,
        scaleRange: [0.9, 1.16], buildLayers: buildClusterLayers, overlap: 0.42,
    });
    const rockFeatures = buildAssociatedSet(recipe.rocks, FOREST_ROCK_FORMATION_TEMPLATES, mediumFeatures, {
        kind: 'forest-rock-formation', clearance: 62, cornerClearance: 92,
        scaleRange: [0.82, 1.14], buildLayers: buildRockLayers, overlap: 0.9,
    });
    const vegetationFeatures = buildAssociatedSet(recipe.vegetation, VEGETATION_TEMPLATES, mediumFeatures, {
        kind: 'forest-vegetation-cluster', clearance: 58, cornerClearance: 88,
        scaleRange: [0.86, 1.16], buildLayers: buildVegetationLayers, overlap: 0.86,
    });

    return {
        compositionRecipe: recipe.id,
        trackAnalysis,
        largeFeatures,
        mediumFeatures,
        smallFeatures: [...rockFeatures, ...vegetationFeatures],
    };
}
