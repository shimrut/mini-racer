/**
 * The ground a biome track is set on.
 *
 * The shapes are built once per track and kept as Path2D beside the track bitmap,
 * so a frame costs one background fill plus one fill for each shape on screen.
 * Nothing is allocated per frame and nothing is baked into the bitmap, which the
 * race cannot afford to grow: it already holds about 13MB per track.
 *
 * The layout is seeded from the track key, so a track is always the same place.
 * Two tracks in one biome still differ, because their keys differ.
 *
 * The ground does not scroll at its own rate. The infield is transparent on a
 * biome track, so the same ground shows inside the track as outside it, and any
 * rate other than the world's would slide one against the other. Depth comes from
 * the shadow baked under the track instead.
 */

import { createSeededRandom } from './seeded-random.js';

/** Field bounds are rounded out to this grid, so the field edge does not chase
 * the last decimal of a measured track bound. What each shape looks like does not
 * depend on this: shapes are anchored to their own absolute cell (see `scatter`). */
const FIELD_SNAP = 200;

/**
 * How far the ground reaches past the track. The camera can lead the car by about
 * 1560px on a wide desktop screen; past the field the plain ground colour still
 * covers the viewport, so reaching the edge shows bare ground, never a hole.
 */
const FIELD_MARGIN = 2000;

const TIER_LANDFORM = 0;
const TIER_SHELF = 1;
const TIER_DETAIL = 2;

const STYLE_LANDFORM = 0;
const STYLE_SHELF = 1;
const STYLE_ROCK = 2;
const STYLE_DECAL = 3;

const LANDFORM_CELL = 900;
const SHELF_CELL = 520;
const DETAIL_CELL = 620;

const BLOB_VERTICES = 20;

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
 * A closed, softly irregular shape. The radius is modulated by three harmonics so
 * the outline reads as a landform rather than a circle, and the curve runs through
 * the midpoints between vertices so there are no visible corners.
 */
function buildBlobPath(random, centerX, centerY, baseRadius) {
    const harmonics = [
        { frequency: 1, amplitude: range(random, 0.10, 0.26), phase: random() * Math.PI * 2 },
        { frequency: 2, amplitude: range(random, 0.05, 0.14), phase: random() * Math.PI * 2 },
        { frequency: 3, amplitude: range(random, 0.02, 0.08), phase: random() * Math.PI * 2 }
    ];
    const stretch = range(random, 1, 1.45);
    const tilt = random() * Math.PI;
    const cosTilt = Math.cos(tilt);
    const sinTilt = Math.sin(tilt);

    const points = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < BLOB_VERTICES; i += 1) {
        const angle = (i / BLOB_VERTICES) * Math.PI * 2;
        let radius = baseRadius;
        for (const harmonic of harmonics) {
            radius += baseRadius * harmonic.amplitude
                * Math.sin(angle * harmonic.frequency + harmonic.phase);
        }
        const localX = Math.cos(angle) * radius * stretch;
        const localY = Math.sin(angle) * radius;
        const x = centerX + localX * cosTilt - localY * sinTilt;
        const y = centerY + localX * sinTilt + localY * cosTilt;
        points.push({ x, y });
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }

    const path = new Path2D();
    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let start = midpoint(points[BLOB_VERTICES - 1], points[0]);
    path.moveTo(start.x, start.y);
    for (let i = 0; i < BLOB_VERTICES; i += 1) {
        const vertex = points[i];
        const end = midpoint(vertex, points[(i + 1) % BLOB_VERTICES]);
        // The curve stays inside the triangle of its two endpoints and its control
        // point, so the vertex bounds above are a true bounding box.
        path.quadraticCurveTo(vertex.x, vertex.y, end.x, end.y);
    }
    path.closePath();

    return { path, minX, minY, maxX, maxY };
}

/** A loose scatter of small stones, all in one path so the cluster costs one fill. */
function buildRockClusterPath(random, centerX, centerY) {
    const path = new Path2D();
    const stoneCount = Math.floor(range(random, 6, 15));
    const spread = range(random, 26, 58);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < stoneCount; i += 1) {
        const stoneX = centerX + range(random, -spread, spread);
        const stoneY = centerY + range(random, -spread, spread);
        const radius = range(random, 3, 9);
        const sides = Math.floor(range(random, 5, 8));
        const spin = random() * Math.PI * 2;

        for (let side = 0; side < sides; side += 1) {
            const angle = spin + (side / sides) * Math.PI * 2;
            const x = stoneX + Math.cos(angle) * radius;
            const y = stoneY + Math.sin(angle) * radius;
            if (side === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        path.closePath();
    }

    return { path, minX, minY, maxX, maxY };
}

/** A faint marker grid, again as one path so the whole grid costs one fill. */
function buildDecalGridPath(random, centerX, centerY) {
    const columns = Math.floor(range(random, 5, 9));
    const rows = Math.floor(range(random, 5, 9));
    const spacing = range(random, 26, 38);
    const size = 3.5;
    const originX = centerX - ((columns - 1) * spacing) / 2;
    const originY = centerY - ((rows - 1) * spacing) / 2;

    const path = new Path2D();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
            const x = originX + column * spacing + range(random, -2, 2);
            const y = originY + row * spacing + range(random, -2, 2);
            path.rect(x, y, size, size);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x + size > maxX) maxX = x + size;
            if (y + size > maxY) maxY = y + size;
        }
    }

    return { path, minX, minY, maxX, maxY };
}

/**
 * Walks the field cell by cell, placing one shape per cell at a jittered position.
 *
 * Cells are anchored to an absolute world grid and seeded from their own integer
 * coordinates, not from a running stream. A shape therefore depends only on which
 * cell it is in, so a track whose measured bounds move by a fraction of a pixel
 * keeps every shape exactly where it was: the field can only gain or lose a cell
 * at its outer edge, thousands of pixels away from the track.
 */
function scatter(seedKey, tierName, field, cellSize, build) {
    const props = [];
    const firstColumn = Math.floor(field.minX / cellSize);
    const lastColumn = Math.ceil(field.maxX / cellSize);
    const firstRow = Math.floor(field.minY / cellSize);
    const lastRow = Math.ceil(field.maxY / cellSize);

    for (let column = firstColumn; column < lastColumn; column += 1) {
        for (let row = firstRow; row < lastRow; row += 1) {
            const random = createSeededRandom(`${seedKey}:${tierName}:${column}:${row}`);
            const centerX = (column + range(random, 0.15, 0.85)) * cellSize;
            const centerY = (row + range(random, 0.15, 0.85)) * cellSize;
            props.push(build(random, centerX, centerY));
        }
    }
    return props;
}

/**
 * Builds the ground for one track. Returns null unless the presentation asks for a
 * biome background, so callers can pass any presentation.
 *
 * `bounds` are the track's world-pixel extents. `seedKey` must identify the track
 * and its biome, so re-picking a biome in the map maker rebuilds the layout.
 */
export function buildBiomeBackdrop(presentation, bounds, seedKey) {
    if (!presentation || presentation.backgroundStyle !== 'biome') return null;
    if (!bounds || typeof Path2D === 'undefined') return null;

    const field = {
        minX: snapDown(bounds.minX) - FIELD_MARGIN,
        minY: snapDown(bounds.minY) - FIELD_MARGIN,
        maxX: snapUp(bounds.maxX) + FIELD_MARGIN,
        maxY: snapUp(bounds.maxY) + FIELD_MARGIN
    };

    const blobColors = presentation.biomeBlobColors || [];
    const styles = [
        blobColors[0] || presentation.biomeGround,
        blobColors[1] || blobColors[0] || presentation.biomeGround,
        presentation.biomeRockColor || blobColors[0] || presentation.biomeGround,
        presentation.biomeDecalColor || blobColors[0] || presentation.biomeGround
    ];

    const props = [
        ...scatter(seedKey, 'landform', field, LANDFORM_CELL, (random, x, y) => ({
            ...buildBlobPath(random, x, y, range(random, 260, 620)),
            tier: TIER_LANDFORM,
            styleIndex: STYLE_LANDFORM
        })),
        ...scatter(seedKey, 'shelf', field, SHELF_CELL, (random, x, y) => ({
            ...buildBlobPath(random, x, y, range(random, 90, 260)),
            tier: TIER_SHELF,
            styleIndex: STYLE_SHELF
        })),
        ...scatter(seedKey, 'detail', field, DETAIL_CELL, (random, x, y) => (
            random() < 0.5
                ? { ...buildRockClusterPath(random, x, y), tier: TIER_DETAIL, styleIndex: STYLE_ROCK }
                : { ...buildDecalGridPath(random, x, y), tier: TIER_DETAIL, styleIndex: STYLE_DECAL }
        ))
    ];

    // Sorting by style keeps the draw loop to one fillStyle assignment per style,
    // and happens to be the right back-to-front order: landform, shelf, detail.
    props.sort((a, b) => a.styleIndex - b.styleIndex);

    return { field, props, styles };
}

/**
 * Paints the ground into the viewport.
 *
 * `offsetX`/`offsetY`/`scale` map field coordinates to the target canvas, so the
 * race and the map maker can share one painter despite working in different units.
 * `detailTier` drops the smallest shapes first when the device is struggling.
 */
export function drawBiomeBackdrop(ctx, width, height, {
    offsetX = 0,
    offsetY = 0,
    scale = 1,
    presentation = {},
    backdrop = null,
    detailTier = TIER_DETAIL
} = {}) {
    ctx.fillStyle = presentation.biomeGround || presentation.offTrackColor || '#0b1220';
    ctx.fillRect(0, 0, width, height);

    if (!backdrop || scale <= 0) return 0;

    const visibleMinX = -offsetX / scale;
    const visibleMinY = -offsetY / scale;
    const visibleMaxX = (width - offsetX) / scale;
    const visibleMaxY = (height - offsetY) / scale;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    let painted = 0;
    let appliedStyle = -1;
    for (const prop of backdrop.props) {
        if (prop.tier > detailTier) continue;
        if (prop.maxX < visibleMinX || prop.minX > visibleMaxX) continue;
        if (prop.maxY < visibleMinY || prop.minY > visibleMaxY) continue;

        if (prop.styleIndex !== appliedStyle) {
            ctx.fillStyle = backdrop.styles[prop.styleIndex];
            appliedStyle = prop.styleIndex;
        }
        ctx.fill(prop.path);
        painted += 1;
    }

    ctx.restore();
    return painted;
}

/** How much of the ground to draw, given how the device is currently coping. */
export function resolveBackdropDetailTier(qualityLevel = 0, frameSkip = 0) {
    if (frameSkip > 0) return TIER_LANDFORM;
    if (qualityLevel > 0) return TIER_SHELF;
    return TIER_DETAIL;
}
