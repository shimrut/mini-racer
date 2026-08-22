import {
  addPolygon,
  buildAuthoredComposition,
  transformedPoint,
} from "./authored-scenery.js";

const freezePoints = (points) =>
  Object.freeze(points.map((point) => Object.freeze(point)));
const template = (value) => Object.freeze(value);

/** Broad, smooth silhouettes that sit behind the road and may continue beneath it. */
export const MOUNTAIN_PATCH_TEMPLATES = Object.freeze([
  template({
    id: "mountain-patch-01",
    radius: 570,
    start: Object.freeze([-480, -80]),
    curves: freezePoints([
      [-410, -350, -120, -390],
      [190, -410, 460, -150],
      [560, 70, 360, 280],
      [90, 430, -250, 300],
      [-530, 190, -480, -80],
    ]),
  }),
  template({
    id: "mountain-patch-02",
    radius: 540,
    start: Object.freeze([-440, 80]),
    curves: freezePoints([
      [-500, -190, -210, -330],
      [70, -440, 350, -270],
      [520, -100, 420, 170],
      [250, 370, -80, 350],
      [-390, 330, -440, 80],
    ]),
  }),
  template({
    id: "mountain-patch-03",
    radius: 585,
    start: Object.freeze([-510, 20]),
    curves: freezePoints([
      [-420, -300, -100, -360],
      [220, -350, 490, -80],
      [530, 210, 230, 350],
      [-90, 420, -390, 240],
      [-560, 150, -510, 20],
    ]),
  }),
]);

/** Small faceted stones; their complete group footprint still clears the circuit. */
export const MOUNTAIN_ROCK_TEMPLATES = Object.freeze([
  template({
    id: "mountain-rock-01",
    radius: 58,
    rocks: Object.freeze([
      Object.freeze([-30, 12, 13]),
      Object.freeze([5, -13, 10]),
      Object.freeze([32, 14, 8]),
    ]),
  }),
  template({
    id: "mountain-rock-02",
    radius: 55,
    rocks: Object.freeze([
      Object.freeze([-28, -10, 9]),
      Object.freeze([1, 14, 14]),
      Object.freeze([31, -8, 10]),
    ]),
  }),
  template({
    id: "mountain-rock-03",
    radius: 52,
    rocks: Object.freeze([
      Object.freeze([-27, 13, 8]),
      Object.freeze([-2, -12, 12]),
      Object.freeze([29, 9, 9]),
    ]),
  }),
]);

/** Each marker is exactly one quiet 2x2 group of four round dots. */
export const MOUNTAIN_MARKER_TEMPLATES = Object.freeze([
  template({
    id: "mountain-marker-01",
    radius: 20,
    dotSize: 4,
    dots: freezePoints([
      [-7, -7], [7, -7], [-7, 7], [7, 7],
    ]),
  }),
  template({
    id: "mountain-marker-02",
    radius: 18,
    dotSize: 3.5,
    dots: freezePoints([
      [-6, -6], [6, -6], [-6, 6], [6, 6],
    ]),
  }),
  template({
    id: "mountain-marker-03",
    radius: 22,
    dotSize: 4.5,
    dots: freezePoints([
      [-8, -8], [8, -8], [-8, 8], [8, 8],
    ]),
  }),
]);

export const MOUNTAIN_COMPOSITION_RECIPES = Object.freeze([
  Object.freeze({
    id: "MOUNTAINS_A",
    patches: freezePoints([
      [0.12, 0.14], [0.55, 0.1], [0.88, 0.26], [0.2, 0.82], [0.72, 0.88],
    ]),
    rocks: freezePoints([
      [0.1, 0.34], [0.3, 0.11], [0.82, 0.12], [0.91, 0.64], [0.34, 0.9],
    ]),
    markers: freezePoints([
      [0.13, 0.68], [0.53, 0.91], [0.9, 0.42],
    ]),
  }),
  Object.freeze({
    id: "MOUNTAINS_B",
    patches: freezePoints([
      [0.1, 0.24], [0.4, 0.1], [0.84, 0.14], [0.9, 0.72], [0.46, 0.88],
    ]),
    rocks: freezePoints([
      [0.08, 0.55], [0.22, 0.1], [0.67, 0.09], [0.91, 0.4], [0.73, 0.9], [0.18, 0.86],
    ]),
    markers: freezePoints([
      [0.11, 0.15], [0.54, 0.09], [0.9, 0.84], [0.31, 0.91],
    ]),
  }),
  Object.freeze({
    id: "MOUNTAINS_C",
    patches: freezePoints([
      [0.16, 0.1], [0.66, 0.11], [0.9, 0.45], [0.75, 0.87], [0.22, 0.86],
    ]),
    rocks: freezePoints([
      [0.1, 0.42], [0.36, 0.08], [0.8, 0.12], [0.91, 0.72], [0.52, 0.91],
    ]),
    markers: freezePoints([
      [0.12, 0.16], [0.88, 0.28], [0.84, 0.88],
    ]),
  }),
]);

const PALETTES = Object.freeze([
  Object.freeze({ patch: "#0d1728", rock: "#1b2940", rockFace: "#2a3850", marker: "#243249" }),
  Object.freeze({ patch: "#101b2d", rock: "#1e2d45", rockFace: "#2d3c54", marker: "#29374d" }),
  Object.freeze({ patch: "#121e30", rock: "#223149", rockFace: "#314058", marker: "#2c3b51" }),
]);

function local(x, y, rotation, scaleX, scaleY, pointX, pointY) {
  return transformedPoint(x, y, rotation, scaleX, scaleY, pointX, pointY);
}

function patchLayers(t, x, y, rotation, scaleX, scaleY, palette) {
  const path = new Path2D();
  const start = local(x, y, rotation, scaleX, scaleY, ...t.start);
  path.moveTo(start.x, start.y);
  for (const [cx, cy, pointX, pointY] of t.curves) {
    const control = local(x, y, rotation, scaleX, scaleY, cx, cy);
    const point = local(x, y, rotation, scaleX, scaleY, pointX, pointY);
    path.quadraticCurveTo(control.x, control.y, point.x, point.y);
  }
  path.closePath();
  return [{ path, style: palette.patch }];
}

function rockLayers(t, x, y, rotation, scaleX, scaleY, palette) {
  const body = new Path2D();
  const face = new Path2D();
  for (const [rockX, rockY, size] of t.rocks) {
    const points = [
      [-0.9, -0.2], [-0.25, -0.8], [0.75, -0.45], [0.85, 0.38], [-0.35, 0.72],
    ].map(([pointX, pointY]) => local(
      x, y, rotation, scaleX, scaleY,
      rockX + pointX * size, rockY + pointY * size
    ));
    addPolygon(body, points);
    addPolygon(face, [points[0], points[1], local(x, y, rotation, scaleX, scaleY, rockX, rockY)]);
  }
  return [
    { path: body, style: palette.rock },
    { path: face, style: palette.rockFace },
  ];
}

function markerLayers(t, x, y, rotation, scaleX, scaleY, palette) {
  const path = new Path2D();
  for (const [dotX, dotY] of t.dots) {
    const center = local(x, y, rotation, scaleX, scaleY, dotX, dotY);
    const size = t.dotSize * Math.min(Math.abs(scaleX), Math.abs(scaleY));
    path.moveTo(center.x + size / 2, center.y);
    path.arc(center.x, center.y, size / 2, 0, Math.PI * 2);
  }
  return [{ path, style: palette.marker }];
}

export function buildAuthoredMountainScenery(options) {
  return buildAuthoredComposition({
    ...options,
    seedSuffix: "authored-mountains",
    recipes: MOUNTAIN_COMPOSITION_RECIPES,
    palettes: PALETTES,
    groups: [
      {
        recipeKey: "patches",
        outputKey: "largeFeatures",
        templates: MOUNTAIN_PATCH_TEMPLATES,
        kind: "mountain-background-patch",
        clearance: 0,
        cornerClearance: 0,
        allowTrackOverlap: true,
        scaleRange: [0.72, 0.9],
        buildLayers: patchLayers,
      },
      {
        recipeKey: "rocks",
        outputKey: "mediumFeatures",
        templates: MOUNTAIN_ROCK_TEMPLATES,
        kind: "mountain-faceted-rock-group",
        clearance: 60,
        cornerClearance: 88,
        scaleRange: [0.82, 1.08],
        buildLayers: rockLayers,
      },
      {
        recipeKey: "markers",
        outputKey: "smallFeatures",
        templates: MOUNTAIN_MARKER_TEMPLATES,
        kind: "mountain-four-dot-marker",
        clearance: 58,
        cornerClearance: 82,
        scaleRange: [0.88, 1.08],
        buildLayers: markerLayers,
      },
    ],
  });
}
