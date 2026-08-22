import { createSeededRandom, hashSeed } from "./seeded-random.js";

const TAU = Math.PI * 2;

export function range(random, min, max) {
  return min + random() * (max - min);
}

export function transformedPoint(
  x,
  y,
  rotation,
  scaleX,
  scaleY,
  pointX,
  pointY
) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: x + pointX * scaleX * cos - pointY * scaleY * sin,
    y: y + pointX * scaleX * sin + pointY * scaleY * cos,
  };
}

export function addPolygon(path, points) {
  if (!points.length) return;
  path.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1)
    path.lineTo(points[index].x, points[index].y);
  path.closePath();
}

/** Track analysis is used only to reject authored geography conflicts. */
export function analyzeAuthoredTrack(distanceIndex) {
  const outer = distanceIndex?.outer || [];
  if (outer.length < 3) return { bounds: null, majorCorners: [] };
  const bounds = outer.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      minY: Math.min(result.minY, point.y),
      maxX: Math.max(result.maxX, point.x),
      maxY: Math.max(result.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
  const candidates = outer
    .map((point, index) => {
      const previous = outer[(index - 1 + outer.length) % outer.length];
      const next = outer[(index + 1) % outer.length];
      const incoming = { x: point.x - previous.x, y: point.y - previous.y };
      const outgoing = { x: next.x - point.x, y: next.y - point.y };
      const inLength = Math.hypot(incoming.x, incoming.y) || 1;
      const outLength = Math.hypot(outgoing.x, outgoing.y) || 1;
      const dot = Math.max(
        -1,
        Math.min(
          1,
          (incoming.x * outgoing.x + incoming.y * outgoing.y) /
            (inLength * outLength)
        )
      );
      return { x: point.x, y: point.y, curvature: Math.acos(dot) };
    })
    .sort((a, b) => b.curvature - a.curvature || a.x - b.x || a.y - b.y);
  const diagonal = Math.hypot(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY
  );
  const separation = Math.max(180, diagonal * 0.11);
  const majorCorners = [];
  for (const candidate of candidates) {
    if (candidate.curvature < 0.08 && majorCorners.length >= 3) break;
    if (
      majorCorners.some(
        (corner) =>
          Math.hypot(candidate.x - corner.x, candidate.y - corner.y) <
          separation
      )
    )
      continue;
    majorCorners.push(candidate);
    if (majorCorners.length === 6) break;
  }
  return { bounds, majorCorners };
}

/** One distance-only shoulder shared by every authored biome. */
export function sampleAuthoredShoulder({
  seedKey,
  area,
  distanceIndex,
  sampleStep = 24,
}) {
  const columns = Math.round((area.maxX - area.minX) / sampleStep) + 1;
  const rows = Math.round((area.maxY - area.minY) / sampleStep) + 1;
  const values = new Float32Array(columns * rows);
  const phase = (hashSeed(`${seedKey}:phase`) / 4294967295) * TAU;
  const resolveWidth = (nearest) => {
    const along = nearest?.along ?? 0;
    return (
      45 +
      Math.sin(along * TAU * 3 + phase) * 10.2 +
      Math.sin(along * TAU * 7 + phase * 0.61) * 4.8
    );
  };
  for (let row = 0; row < rows; row += 1) {
    const y = area.minY + row * sampleStep;
    for (let column = 0; column < columns; column += 1) {
      const x = area.minX + column * sampleStep;
      const nearest = distanceIndex?.query(x, y, 62) || null;
      values[row * columns + column] =
        resolveWidth(nearest) - (nearest?.distance ?? 120);
    }
  }
  return { values, columns, rows, sampleStep, resolveWidth };
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

export function isAuthoredPlacementClear(
  candidate,
  footprintRadius,
  area,
  distanceIndex,
  trackAnalysis,
  clearance,
  cornerClearance = clearance,
  allowTrackOverlap = false
) {
  if (
    candidate.x - footprintRadius < area.minX ||
    candidate.x + footprintRadius > area.maxX ||
    candidate.y - footprintRadius < area.minY ||
    candidate.y + footprintRadius > area.maxY
  )
    return false;
  if (allowTrackOverlap) return true;
  if (distanceIndex?.containsTrack(candidate.x, candidate.y)) return false;
  const nearest =
    distanceIndex?.query(
      candidate.x,
      candidate.y,
      footprintRadius + clearance
    ) || null;
  if (nearest && nearest.distance <= footprintRadius + clearance) return false;
  return !trackAnalysis.majorCorners.some(
    (corner) =>
      cornerClearance > clearance &&
      Math.hypot(candidate.x - corner.x, candidate.y - corner.y) <=
        footprintRadius + cornerClearance
  );
}

function makeFeature({
  template,
  candidate,
  rotation,
  scale,
  mirror,
  palette,
  paletteIndex,
  kind,
  buildLayers,
}) {
  const footprintRadius = template.radius * scale;
  return {
    kind,
    semanticType: kind,
    templateId: template.id,
    ...candidate,
    rotation,
    scale,
    mirror,
    paletteIndex,
    footprintRadius,
    minX: candidate.x - footprintRadius,
    minY: candidate.y - footprintRadius,
    maxX: candidate.x + footprintRadius,
    maxY: candidate.y + footprintRadius,
    layers: buildLayers(
      template,
      candidate.x,
      candidate.y,
      rotation,
      scale * mirror,
      scale,
      palette
    ),
  };
}

/** Descriptor-driven selection and broad-zone placement of complete authored primitives. */
export function buildAuthoredComposition({
  seedKey,
  seedSuffix,
  area,
  compositionArea = area,
  distanceIndex,
  recipes,
  palettes,
  groups,
}) {
  const random = createSeededRandom(`${seedKey}:${seedSuffix}`);
  const recipe = recipes[Math.floor(random() * recipes.length)];
  const trackAnalysis = analyzeAuthoredTrack(distanceIndex);
  const output = {};
  for (const group of groups) {
    const slots = recipe[group.recipeKey];
    output[group.outputKey] = slots
      .map((slot, index) => {
        const template = group.templates[index % group.templates.length];
        const scale = range(random, group.scaleRange[0], group.scaleRange[1]);
        const footprintRadius = template.radius * scale;
        const paletteIndex = Math.floor(random() * palettes.length);
        for (let attempt = 0; attempt < 42; attempt += 1) {
          const candidate = candidateFromSlot(
            slot,
            compositionArea,
            random,
            attempt
          );
          if (
            !isAuthoredPlacementClear(
              candidate,
              footprintRadius,
              area,
              distanceIndex,
              trackAnalysis,
              group.clearance,
              group.cornerClearance,
              group.allowTrackOverlap
            )
          )
            continue;
          return makeFeature({
            template,
            candidate,
            scale,
            paletteIndex,
            palette: palettes[paletteIndex],
            rotation: range(random, -Math.PI, Math.PI),
            mirror: random() < 0.5 ? -1 : 1,
            kind: group.kind,
            buildLayers: group.buildLayers,
          });
        }
        return null;
      })
      .filter(Boolean);
  }
  return { compositionRecipe: recipe.id, trackAnalysis, ...output };
}
