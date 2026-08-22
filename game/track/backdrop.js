import { buildTrackDistanceIndex } from "./environment-field.js";
import { sampleAuthoredShoulder } from "./authored-scenery.js";
import { buildAuthoredForestScenery } from "./forest-scenery.js";
import { buildAuthoredMountainScenery } from "./mountains-scenery.js";
import { buildAuthoredArcticScenery } from "./arctic-scenery.js";
import { buildAuthoredBeachScenery } from "./beach-scenery.js";

const FIELD_SNAP = 200;
const FIELD_MARGIN = 2000;
const TILE_SAMPLES = 12;
const TIER_ESSENTIAL_PROPS = 0;
const TIER_MAJOR_PROPS = 1;
const TIER_ALL_PROPS = 2;
const AUTHORED_BUILDERS = Object.freeze({
  forest: buildAuthoredForestScenery,
  mountains: buildAuthoredMountainScenery,
  arctic: buildAuthoredArcticScenery,
  beach: buildAuthoredBeachScenery,
});
const snapDown = (value) => Math.floor(value / FIELD_SNAP) * FIELD_SNAP;
const snapUp = (value) => Math.ceil(value / FIELD_SNAP) * FIELD_SNAP;

function addCellAboveLevel(
  path,
  x0,
  y0,
  x1,
  y1,
  topLeft,
  topRight,
  bottomRight,
  bottomLeft
) {
  const code =
    (topLeft >= 0 ? 1 : 0) |
    (topRight >= 0 ? 2 : 0) |
    (bottomRight >= 0 ? 4 : 0) |
    (bottomLeft >= 0 ? 8 : 0);
  if (code === 0) return;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  if (code === 15) {
    path.moveTo(x0, y0);
    path.lineTo(x1, y0);
    path.lineTo(x1, y1);
    path.lineTo(x0, y1);
    path.closePath();
    return;
  }
  const cross = (a, b) => (Math.abs(b - a) < 1e-9 ? 0.5 : -a / (b - a));
  const top = { x: x0 + (x1 - x0) * cross(topLeft, topRight), y: y0 };
  const right = { x: x1, y: y0 + (y1 - y0) * cross(topRight, bottomRight) };
  const bottom = { x: x0 + (x1 - x0) * cross(bottomLeft, bottomRight), y: y1 };
  const left = { x: x0, y: y0 + (y1 - y0) * cross(topLeft, bottomLeft) };
  const emit = (points) => {
    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1)
      path.lineTo(points[i].x, points[i].y);
    path.closePath();
  };
  switch (code) {
    case 1:
      emit([corners[0], top, left]);
      break;
    case 2:
      emit([top, corners[1], right]);
      break;
    case 3:
      emit([corners[0], corners[1], right, left]);
      break;
    case 4:
      emit([right, corners[2], bottom]);
      break;
    case 5:
      emit([corners[0], top, left]);
      emit([right, corners[2], bottom]);
      break;
    case 6:
      emit([top, corners[1], corners[2], bottom]);
      break;
    case 7:
      emit([corners[0], corners[1], corners[2], bottom, left]);
      break;
    case 8:
      emit([left, bottom, corners[3]]);
      break;
    case 9:
      emit([corners[0], top, bottom, corners[3]]);
      break;
    case 10:
      emit([top, corners[1], right]);
      emit([left, bottom, corners[3]]);
      break;
    case 11:
      emit([corners[0], corners[1], right, bottom, corners[3]]);
      break;
    case 12:
      emit([left, right, corners[2], corners[3]]);
      break;
    case 13:
      emit([corners[0], top, right, corners[2], corners[3]]);
      break;
    case 14:
      emit([top, corners[1], corners[2], corners[3], left]);
      break;
    default:
      break;
  }
}

function buildShoulderTiles(samples, area, style) {
  const { values, columns, rows, sampleStep } = samples;
  const tiles = [];
  for (let tileRow = 0; tileRow < rows - 1; tileRow += TILE_SAMPLES) {
    for (
      let tileColumn = 0;
      tileColumn < columns - 1;
      tileColumn += TILE_SAMPLES
    ) {
      const lastRow = Math.min(tileRow + TILE_SAMPLES, rows - 1);
      const lastColumn = Math.min(tileColumn + TILE_SAMPLES, columns - 1);
      const path = new Path2D();
      let painted = false;
      for (let row = tileRow; row < lastRow; row += 1) {
        for (let column = tileColumn; column < lastColumn; column += 1) {
          const index = row * columns + column;
          const corners = [
            values[index],
            values[index + 1],
            values[index + columns + 1],
            values[index + columns],
          ];
          if (corners.every((value) => value < 0)) continue;
          const x0 = area.minX + column * sampleStep;
          const y0 = area.minY + row * sampleStep;
          addCellAboveLevel(
            path,
            x0,
            y0,
            x0 + sampleStep,
            y0 + sampleStep,
            ...corners
          );
          painted = true;
        }
      }
      if (painted)
        tiles.push({
          path,
          style,
          minX: area.minX + tileColumn * sampleStep,
          minY: area.minY + tileRow * sampleStep,
          maxX: area.minX + lastColumn * sampleStep,
          maxY: area.minY + lastRow * sampleStep,
        });
    }
  }
  return tiles;
}

export function buildBiomeBackdrop(
  presentation,
  bounds,
  seedKey,
  { geometry = null, worldScale = 1 } = {}
) {
  if (
    !presentation ||
    presentation.backgroundStyle !== "biome" ||
    !bounds ||
    typeof Path2D === "undefined"
  )
    return null;
  const config = presentation.biomeConfig;
  const builder = config && AUTHORED_BUILDERS[config.id];
  if (!builder) return null;
  const area = {
    minX: snapDown(bounds.minX) - FIELD_MARGIN,
    minY: snapDown(bounds.minY) - FIELD_MARGIN,
    maxX: snapUp(bounds.maxX) + FIELD_MARGIN,
    maxY: snapUp(bounds.maxY) + FIELD_MARGIN,
  };
  const compositionMargin = 520;
  const compositionArea = {
    minX: Math.max(area.minX, bounds.minX - compositionMargin),
    minY: Math.max(area.minY, bounds.minY - compositionMargin),
    maxX: Math.min(area.maxX, bounds.maxX + compositionMargin),
    maxY: Math.min(area.maxY, bounds.maxY + compositionMargin),
  };
  const distanceIndex = buildTrackDistanceIndex(geometry, worldScale);
  const composition = builder({
    seedKey,
    area,
    compositionArea,
    distanceIndex,
  });
  const shoulderSamples = sampleAuthoredShoulder({
    seedKey: `${seedKey}:${config.id}-shoulder`,
    area,
    distanceIndex,
  });
  const shoulderTiles = buildShoulderTiles(
    shoulderSamples,
    area,
    config.runoffColor
  );
  const shoulder = {
    source: "distance-only",
    tiles: shoulderTiles,
    minWidth: 30,
    maxWidth: 60,
    resolveWidth: shoulderSamples.resolveWidth,
  };
  return {
    field: area,
    ...composition,
    shoulder,
    terrain: composition.largeFeatures,
    transition: [],
    runoff: shoulderTiles,
    features: [...composition.mediumFeatures, ...composition.smallFeatures],
    regions: [],
    propCandidates: [],
    props: [],
    groundColor: config.groundColors[0],
    configId: config.id,
    distanceIndex,
    resolveRunoffWidth: shoulderSamples.resolveWidth,
    trackLocalExtent: { min: 30, max: 60 },
  };
}

const isVisible = (item, minX, minY, maxX, maxY) =>
  !(
    item.maxX < minX ||
    item.minX > maxX ||
    item.maxY < minY ||
    item.minY > maxY
  );
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
    if (
      !isVisible(tile, visible.minX, visible.minY, visible.maxX, visible.maxY)
    )
      continue;
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
    if (
      !isVisible(
        feature,
        visible.minX,
        visible.minY,
        visible.maxX,
        visible.maxY
      )
    )
      continue;
    for (const layer of feature.layers || []) {
      if (layer.style) {
        ctx.fillStyle = layer.style;
        ctx.fill(layer.path);
      }
      if (layer.strokeStyle && ctx.stroke) {
        ctx.strokeStyle = layer.strokeStyle;
        ctx.lineWidth = layer.lineWidth || 1;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke(layer.path);
      }
    }
    painted += 1;
  }
  return painted;
}

export function drawBiomeBackdropBase(
  ctx,
  width,
  height,
  {
    offsetX = 0,
    offsetY = 0,
    scale = 1,
    presentation = {},
    backdrop = null,
  } = {}
) {
  ctx.fillStyle =
    backdrop?.groundColor ||
    presentation.biomeConfig?.groundColors?.[0] ||
    presentation.biomeGround ||
    presentation.offTrackColor ||
    "#0b1220";
  ctx.fillRect(0, 0, width, height);
  if (!backdrop || scale <= 0) return 0;
  const visible = prepareTransform(ctx, width, height, offsetX, offsetY, scale);
  let painted = drawFeatures(ctx, backdrop.largeFeatures || [], visible);
  painted += drawFeatures(ctx, backdrop.mediumFeatures || [], visible);
  painted += drawFeatures(ctx, backdrop.smallFeatures || [], visible);
  painted += drawTiles(ctx, backdrop.shoulder?.tiles || [], visible);
  ctx.restore();
  return painted;
}
export function drawBiomeBackdropProps() {
  return 0;
}
export function drawBiomeBackdrop(ctx, width, height, options = {}) {
  return drawBiomeBackdropBase(ctx, width, height, options);
}
export function resolveBackdropDetailTier(qualityLevel = 0, frameSkip = 0) {
  if (frameSkip > 0) return TIER_ESSENTIAL_PROPS;
  if (qualityLevel > 0) return TIER_MAJOR_PROPS;
  return TIER_ALL_PROPS;
}
