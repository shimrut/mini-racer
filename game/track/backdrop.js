/**
 * The ground a biome track is set on.
 *
 * The ground is terrain, not scattered shapes. A smooth height field runs across
 * the whole track, and each biome tone fills everything above one height. Because
 * a higher band always sits inside a lower one, filling them from low to high
 * terraces the ground into long flowing contours, the way a contour map reads.
 * Rocks and marker grids are then scattered on top of that.
 *
 * The field and the scatter are both anchored to absolute world coordinates and
 * seeded from the track key, so a track is always the same place, two tracks in
 * one biome are two different places, and a track whose measured bounds shift by
 * a fraction of a pixel does not move.
 *
 * Everything is built once and kept as Path2D beside the track bitmap. A frame
 * fills the ground once, then fills only the tiles and props the viewport can see.
 *
 * The ground does not scroll at its own rate. The infield is transparent on a
 * biome track, so the same ground shows inside the track as outside it, and any
 * rate other than the world's would slide one against the other. Depth comes from
 * the shadow baked under the track instead.
 */

import { createSeededRandom } from './seeded-random.js';

/** Field bounds are rounded out to this grid so the field edge does not chase the
 * last decimal of a measured track bound. What the ground looks like does not
 * depend on it: the height field is read at absolute world coordinates. */
const FIELD_SNAP = 200;

/**
 * How far the ground reaches past the track. The camera can lead the car by about
 * 1560px on a wide desktop screen; past the field the plain ground colour still
 * covers the viewport, so reaching the edge shows bare ground, never a hole.
 */
const FIELD_MARGIN = 2000;

/** How finely the height field is read. Smaller means smoother contours and more
 * geometry; 200px keeps a contour smooth at race zoom. */
const SAMPLE_STEP = 200;

/** Contours are grouped into tiles this many samples wide, so off-screen ground
 * can be skipped without splitting a fill into thousands of small ones. */
const TILE_SAMPLES = 8;

/** Heights at which the ground steps up a tone. Each sits inside the one before. */
const TERRAIN_LEVELS = [-0.18, 0.12, 0.42, 0.68];

const TIER_TERRAIN = 0;
const TIER_ROCKS = 1;
const TIER_DECALS = 2;

// Densities are set from the reference art: about three rock formations and four
// marker grids in view at once on a wide screen.
const ROCK_CELL = 560;
const ROCK_CHANCE = 0.6;
const DECAL_CELL = 620;
const DECAL_CHANCE = 0.55;

function snapDown(value) {
    return Math.floor(value / FIELD_SNAP) * FIELD_SNAP;
}

function snapUp(value) {
    return Math.ceil(value / FIELD_SNAP) * FIELD_SNAP;
}

function range(random, low, high) {
    return low + random() * (high - low);
}

/**
 * A smooth height field.
 *
 * Two long waves running in different directions give the ground its grain, and
 * three slow ripples warp them so the contours wander instead of striping. The
 * field is continuous everywhere, which is what makes the contours join up.
 */
function createTerrainField(random) {
    const firstAngle = random() * Math.PI;
    const secondAngle = random() * Math.PI;
    const firstLength = range(random, 2600, 5200);
    const secondLength = range(random, 3800, 7200);
    const warps = [0, 1, 2].map(() => ({
        frequencyX: range(random, 0.4, 1.3) / 1000,
        frequencyY: range(random, 0.4, 1.3) / 1000,
        phaseX: random() * Math.PI * 2,
        phaseY: random() * Math.PI * 2,
        amplitude: range(random, 0.5, 1.4)
    }));

    const firstCos = Math.cos(firstAngle);
    const firstSin = Math.sin(firstAngle);
    const secondCos = Math.cos(secondAngle);
    const secondSin = Math.sin(secondAngle);

    return (x, y) => {
        let warp = 0;
        for (const ripple of warps) {
            warp += ripple.amplitude
                * Math.sin(x * ripple.frequencyX + ripple.phaseX)
                * Math.sin(y * ripple.frequencyY + ripple.phaseY);
        }
        const first = Math.sin(((x * firstCos + y * firstSin) / firstLength) * Math.PI * 2 + warp);
        const second = Math.sin(((x * secondCos + y * secondSin) / secondLength) * Math.PI * 2 + warp * 0.6);
        return first * 0.62 + second * 0.38;
    };
}

/**
 * Adds the part of one grid square that lies above `level` to `path`.
 *
 * This is the marching-squares cell case: the four corner heights say which
 * corners are above the level, and the crossings are read along each edge. Two
 * neighbouring squares work out exactly the same crossing on the edge they share,
 * so the squares meet with no seam and one fill covers all of them.
 */
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

    const cross = (a, b) => (level - a) / (b - a);
    const top = { x: x0 + (x1 - x0) * cross(topLeft, topRight), y: y0 };
    const right = { x: x1, y: y0 + (y1 - y0) * cross(topRight, bottomRight) };
    const bottom = { x: x0 + (x1 - x0) * cross(bottomLeft, bottomRight), y: y1 };
    const left = { x: x0, y: y0 + (y1 - y0) * cross(topLeft, bottomLeft) };
    const topLeftCorner = { x: x0, y: y0 };
    const topRightCorner = { x: x1, y: y0 };
    const bottomRightCorner = { x: x1, y: y1 };
    const bottomLeftCorner = { x: x0, y: y1 };

    const emit = (points) => {
        path.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i += 1) {
            path.lineTo(points[i].x, points[i].y);
        }
        path.closePath();
    };

    switch (code) {
        case 1: emit([topLeftCorner, top, left]); break;
        case 2: emit([top, topRightCorner, right]); break;
        case 3: emit([topLeftCorner, topRightCorner, right, left]); break;
        case 4: emit([right, bottomRightCorner, bottom]); break;
        // Opposite corners: two separate slopes rather than a guessed saddle.
        case 5: emit([topLeftCorner, top, left]); emit([right, bottomRightCorner, bottom]); break;
        case 6: emit([top, topRightCorner, bottomRightCorner, bottom]); break;
        case 7: emit([topLeftCorner, topRightCorner, bottomRightCorner, bottom, left]); break;
        case 8: emit([left, bottom, bottomLeftCorner]); break;
        case 9: emit([topLeftCorner, top, bottom, bottomLeftCorner]); break;
        case 10: emit([top, topRightCorner, right]); emit([left, bottom, bottomLeftCorner]); break;
        case 11: emit([topLeftCorner, topRightCorner, right, bottom, bottomLeftCorner]); break;
        case 12: emit([left, right, bottomRightCorner, bottomLeftCorner]); break;
        case 13: emit([topLeftCorner, top, right, bottomRightCorner, bottomLeftCorner]); break;
        case 14: emit([top, topRightCorner, bottomRightCorner, bottomLeftCorner, left]); break;
        default: break;
    }
}

/** Reads the height field over the whole area, on absolute world coordinates. */
function sampleTerrain(field, area) {
    const columns = Math.round((area.maxX - area.minX) / SAMPLE_STEP) + 1;
    const rows = Math.round((area.maxY - area.minY) / SAMPLE_STEP) + 1;
    const heights = new Float32Array(columns * rows);

    for (let row = 0; row < rows; row += 1) {
        const y = area.minY + row * SAMPLE_STEP;
        for (let column = 0; column < columns; column += 1) {
            heights[row * columns + column] = field(area.minX + column * SAMPLE_STEP, y);
        }
    }

    return { heights, columns, rows };
}

/** Builds one tone's ground as tiles, so off-screen ground can be skipped. */
function buildTerrainLayer(samples, area, level, styleIndex) {
    const { heights, columns, rows } = samples;
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
                    const x0 = area.minX + column * SAMPLE_STEP;
                    const index = row * columns + column;
                    const topLeft = heights[index];
                    const topRight = heights[index + 1];
                    const bottomLeft = heights[index + columns];
                    const bottomRight = heights[index + columns + 1];
                    if (
                        topLeft < level && topRight < level
                        && bottomLeft < level && bottomRight < level
                    ) {
                        continue;
                    }
                    addCellAboveLevel(
                        path, level,
                        x0, y0, x0 + SAMPLE_STEP, y0 + SAMPLE_STEP,
                        topLeft, topRight, bottomRight, bottomLeft,
                    );
                    painted = true;
                }
            }

            if (!painted) continue;
            tiles.push({
                path,
                styleIndex,
                minX: area.minX + tileColumn * SAMPLE_STEP,
                minY: area.minY + tileRow * SAMPLE_STEP,
                maxX: area.minX + lastColumn * SAMPLE_STEP,
                maxY: area.minY + lastRow * SAMPLE_STEP
            });
        }
    }

    return tiles;
}

/**
 * A rock: a dark slab with one lit facet, the way the reference art draws them.
 */
function buildRock(random, centerX, centerY) {
    const radius = range(random, 14, 34);
    const sides = Math.floor(range(random, 5, 8));
    const spin = random() * Math.PI * 2;
    const squash = range(random, 0.55, 0.85);

    const points = [];
    for (let side = 0; side < sides; side += 1) {
        const angle = spin + (side / sides) * Math.PI * 2;
        const wobble = range(random, 0.78, 1.12);
        points.push({
            x: centerX + Math.cos(angle) * radius * wobble,
            y: centerY + Math.sin(angle) * radius * wobble * squash
        });
    }

    const body = new Path2D();
    body.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) body.lineTo(points[i].x, points[i].y);
    body.closePath();

    // The lit facet is one side of the slab, closed back through the middle.
    const facet = new Path2D();
    const litCount = Math.max(2, Math.round(points.length / 2));
    facet.moveTo(points[0].x, points[0].y);
    for (let i = 1; i <= litCount; i += 1) facet.lineTo(points[i % points.length].x, points[i % points.length].y);
    facet.lineTo(centerX, centerY);
    facet.closePath();

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
    }

    return { path: body, facet, minX, minY, maxX, maxY };
}

/** A faint marker grid, as one path so the whole grid costs one fill. */
function buildDecalGrid(random, centerX, centerY) {
    const columns = Math.floor(range(random, 4, 8));
    const rows = Math.floor(range(random, 3, 7));
    const spacing = range(random, 22, 34);
    const size = 4;
    const originX = centerX - ((columns - 1) * spacing) / 2;
    const originY = centerY - ((rows - 1) * spacing) / 2;

    const path = new Path2D();
    for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
            path.rect(originX + column * spacing, originY + row * spacing, size, size);
        }
    }

    return {
        path,
        minX: originX - size,
        minY: originY - size,
        maxX: originX + columns * spacing + size,
        maxY: originY + rows * spacing + size
    };
}

/**
 * Places one thing per grid cell, seeded from that cell's own coordinates, so a
 * prop depends only on where it is and never shifts when the field edge moves.
 */
function scatter(seedKey, name, area, cellSize, chance, build) {
    const props = [];
    const firstColumn = Math.floor(area.minX / cellSize);
    const lastColumn = Math.ceil(area.maxX / cellSize);
    const firstRow = Math.floor(area.minY / cellSize);
    const lastRow = Math.ceil(area.maxY / cellSize);

    for (let column = firstColumn; column < lastColumn; column += 1) {
        for (let row = firstRow; row < lastRow; row += 1) {
            const random = createSeededRandom(`${seedKey}:${name}:${column}:${row}`);
            if (random() > chance) continue;
            const x = (column + range(random, 0.15, 0.85)) * cellSize;
            const y = (row + range(random, 0.15, 0.85)) * cellSize;
            props.push(build(random, x, y));
        }
    }

    return props;
}

/**
 * Builds the ground for one track. Returns null unless the presentation asks for a
 * biome background, so callers can pass any presentation.
 *
 * `bounds` are the track's world-pixel extents. `seedKey` must identify the track
 * and its biome, so re-picking a biome in the map maker rebuilds the ground.
 */
export function buildBiomeBackdrop(presentation, bounds, seedKey) {
    if (!presentation || presentation.backgroundStyle !== 'biome') return null;
    if (!bounds || typeof Path2D === 'undefined') return null;

    const area = {
        minX: snapDown(bounds.minX) - FIELD_MARGIN,
        minY: snapDown(bounds.minY) - FIELD_MARGIN,
        maxX: snapUp(bounds.maxX) + FIELD_MARGIN,
        maxY: snapUp(bounds.maxY) + FIELD_MARGIN
    };

    const random = createSeededRandom(`${seedKey}:terrain`);
    const field = createTerrainField(random);
    const samples = sampleTerrain(field, area);

    const terrainTones = presentation.biomeTerrainColors || [];
    const styles = [
        ...terrainTones,
        presentation.biomeRockColor || terrainTones[terrainTones.length - 1],
        presentation.biomeRockLitColor || presentation.biomeRockColor,
        presentation.biomeDecalColor || terrainTones[0]
    ];
    const rockStyle = terrainTones.length;
    const rockLitStyle = rockStyle + 1;
    const decalStyle = rockStyle + 2;

    // Low levels first: each higher tone sits inside the one below, so filling in
    // order steps the ground up one terrace at a time.
    const terrain = [];
    TERRAIN_LEVELS.forEach((level, index) => {
        if (index >= terrainTones.length) return;
        terrain.push(...buildTerrainLayer(samples, area, level, index));
    });

    const rocks = scatter(seedKey, 'rock', area, ROCK_CELL, ROCK_CHANCE, buildRock);
    const decals = scatter(seedKey, 'decal', area, DECAL_CELL, DECAL_CHANCE, buildDecalGrid);

    return { field: area, terrain, rocks, decals, styles, rockStyle, rockLitStyle, decalStyle };
}

function isVisible(item, minX, minY, maxX, maxY) {
    return !(item.maxX < minX || item.minX > maxX || item.maxY < minY || item.minY > maxY);
}

/**
 * Paints the ground into the viewport.
 *
 * `offsetX`/`offsetY`/`scale` map world coordinates to the target canvas, so the
 * race and the map maker share one painter despite working in different units.
 * `detailTier` drops the smallest things first when the device is struggling.
 */
export function drawBiomeBackdrop(ctx, width, height, {
    offsetX = 0,
    offsetY = 0,
    scale = 1,
    presentation = {},
    backdrop = null,
    detailTier = TIER_DECALS
} = {}) {
    ctx.fillStyle = presentation.biomeGround || presentation.offTrackColor || '#0b1220';
    ctx.fillRect(0, 0, width, height);

    if (!backdrop || scale <= 0) return 0;

    const minX = -offsetX / scale;
    const minY = -offsetY / scale;
    const maxX = (width - offsetX) / scale;
    const maxY = (height - offsetY) / scale;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    let painted = 0;
    let appliedStyle = -1;
    const setStyle = (styleIndex) => {
        if (styleIndex === appliedStyle) return;
        ctx.fillStyle = backdrop.styles[styleIndex];
        appliedStyle = styleIndex;
    };

    for (const tile of backdrop.terrain) {
        if (!isVisible(tile, minX, minY, maxX, maxY)) continue;
        setStyle(tile.styleIndex);
        ctx.fill(tile.path);
        painted += 1;
    }

    if (detailTier >= TIER_ROCKS) {
        // Slabs first, then every lit facet, so the style flips twice for all the
        // rocks on screen rather than twice per rock. Rocks are a cell apart, so
        // none of them can cover another one's facet.
        const visibleRocks = backdrop.rocks
            .filter((rock) => isVisible(rock, minX, minY, maxX, maxY));
        setStyle(backdrop.rockStyle);
        for (const rock of visibleRocks) ctx.fill(rock.path);
        setStyle(backdrop.rockLitStyle);
        for (const rock of visibleRocks) ctx.fill(rock.facet);
        painted += visibleRocks.length;
    }

    if (detailTier >= TIER_DECALS) {
        setStyle(backdrop.decalStyle);
        for (const decal of backdrop.decals) {
            if (!isVisible(decal, minX, minY, maxX, maxY)) continue;
            ctx.fill(decal.path);
            painted += 1;
        }
    }

    ctx.restore();
    return painted;
}

/** How much of the ground to draw, given how the device is currently coping. */
export function resolveBackdropDetailTier(qualityLevel = 0, frameSkip = 0) {
    if (frameSkip > 0) return TIER_TERRAIN;
    if (qualityLevel > 0) return TIER_ROCKS;
    return TIER_DECALS;
}
