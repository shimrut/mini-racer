import {
  addPolygon,
  buildAuthoredComposition,
  transformedPoint,
} from "./authored-scenery.js";
const poly = (points) => Object.freeze(points.map((p) => Object.freeze(p)));
const t = (v) => Object.freeze(v);
const MASS = [
  [-1, -0.2],
  [-0.72, -0.76],
  [-0.18, -1],
  [0.48, -0.82],
  [1, -0.24],
  [0.86, 0.54],
  [0.2, 0.92],
  [-0.54, 0.78],
];
export const ARCTIC_SNOW_FIELD_TEMPLATES = Object.freeze([
  t({
    id: "arctic-snow-field-01",
    radius: 300,
    points: poly(MASS.map(([x, y]) => [x * 290, y * 220])),
  }),
  t({
    id: "arctic-snow-field-02",
    radius: 320,
    points: poly([
      [-310, 20],
      [-230, -180],
      [-20, -238],
      [190, -176],
      [306, 8],
      [230, 196],
      [-28, 228],
      [-260, 176],
    ]),
  }),
  t({
    id: "arctic-snow-field-03",
    radius: 305,
    points: poly([
      [-294, -54],
      [-154, -220],
      [76, -214],
      [286, -72],
      [270, 138],
      [62, 226],
      [-184, 190],
      [-300, 56],
    ]),
  }),
]);
export const ARCTIC_FROZEN_POND_TEMPLATES = Object.freeze([
  t({
    id: "arctic-pond-01",
    radius: 170,
    points: poly([
      [-158, -28],
      [-94, -112],
      [42, -132],
      [154, -50],
      [136, 70],
      [28, 126],
      [-112, 96],
    ]),
    inset: 0.72,
  }),
  t({
    id: "arctic-pond-02",
    radius: 165,
    points: poly([
      [-150, -60],
      [-24, -126],
      [118, -92],
      [156, 22],
      [70, 120],
      [-78, 112],
      [-158, 34],
    ]),
    inset: 0.7,
  }),
  t({
    id: "arctic-pond-03",
    radius: 175,
    points: poly([
      [-166, 8],
      [-104, -108],
      [34, -140],
      [158, -64],
      [146, 60],
      [30, 132],
      [-118, 102],
    ]),
    inset: 0.74,
  }),
]);
export const ARCTIC_SNOWDRIFT_TEMPLATES = Object.freeze([
  t({
    id: "arctic-drift-01",
    radius: 125,
    points: poly([
      [-118, 34],
      [-62, -46],
      [24, -66],
      [116, -10],
      [82, 60],
      [-38, 70],
    ]),
  }),
  t({
    id: "arctic-drift-02",
    radius: 132,
    points: poly([
      [-126, -8],
      [-38, -70],
      [62, -54],
      [124, 24],
      [44, 76],
      [-72, 58],
    ]),
  }),
  t({
    id: "arctic-drift-03",
    radius: 128,
    points: poly([
      [-120, 22],
      [-76, -52],
      [18, -76],
      [120, -22],
      [94, 54],
      [-22, 72],
    ]),
  }),
]);
export const ARCTIC_ICE_PATCH_TEMPLATES = Object.freeze([
  t({
    id: "arctic-ice-01",
    radius: 92,
    points: poly([
      [-82, -20],
      [-28, -72],
      [66, -48],
      [84, 28],
      [18, 70],
      [-74, 42],
    ]),
  }),
  t({
    id: "arctic-ice-02",
    radius: 88,
    points: poly([
      [-80, 20],
      [-54, -48],
      [24, -70],
      [82, -14],
      [58, 58],
      [-30, 72],
    ]),
  }),
]);
export const ARCTIC_SNOWY_ROCK_TEMPLATES = Object.freeze([
  t({
    id: "arctic-rock-01",
    radius: 90,
    rocks: Object.freeze([
      [-42, 8, 38],
      [18, -18, 30],
      [50, 26, 22],
    ]),
  }),
  t({
    id: "arctic-rock-02",
    radius: 94,
    rocks: Object.freeze([
      [-46, -16, 28],
      [0, 18, 42],
      [48, -10, 30],
    ]),
  }),
]);
export const ARCTIC_COMPOSITION_RECIPES = Object.freeze([
  Object.freeze({
    id: "ARCTIC_A",
    fields: Object.freeze([
      [0.08, 0.12],
      [0.34, 0.08],
      [0.68, 0.08],
      [0.92, 0.2],
      [0.92, 0.55],
      [0.82, 0.88],
      [0.2, 0.9],
      [0.07, 0.58],
    ]),
    ponds: Object.freeze([
      [0.12, 0.32],
      [0.86, 0.36],
      [0.72, 0.88],
    ]),
    drifts: Object.freeze([
      [0.22, 0.1],
      [0.54, 0.08],
      [0.9, 0.3],
      [0.9, 0.72],
      [0.55, 0.92],
      [0.12, 0.78],
    ]),
    ice: Object.freeze([
      [0.08, 0.48],
      [0.92, 0.48],
      [0.36, 0.92],
      [0.7, 0.08],
    ]),
    rocks: Object.freeze([
      [0.08, 0.1],
      [0.92, 0.12],
      [0.9, 0.9],
      [0.12, 0.9],
    ]),
  }),
  Object.freeze({
    id: "ARCTIC_B",
    fields: Object.freeze([
      [0.08, 0.18],
      [0.08, 0.48],
      [0.1, 0.8],
      [0.38, 0.92],
      [0.7, 0.9],
      [0.92, 0.72],
      [0.92, 0.34],
    ]),
    ponds: Object.freeze([
      [0.18, 0.1],
      [0.82, 0.16],
    ]),
    drifts: Object.freeze([
      [0.1, 0.3],
      [0.12, 0.68],
      [0.34, 0.9],
      [0.64, 0.92],
      [0.9, 0.68],
      [0.9, 0.24],
      [0.52, 0.08],
    ]),
    ice: Object.freeze([
      [0.28, 0.08],
      [0.72, 0.1],
      [0.92, 0.5],
    ]),
    rocks: Object.freeze([
      [0.08, 0.88],
      [0.5, 0.92],
      [0.9, 0.86],
      [0.92, 0.08],
      [0.08, 0.08],
    ]),
  }),
  Object.freeze({
    id: "ARCTIC_C",
    fields: Object.freeze([
      [0.08, 0.1],
      [0.4, 0.08],
      [0.72, 0.08],
      [0.92, 0.25],
      [0.92, 0.62],
      [0.78, 0.9],
    ]),
    ponds: Object.freeze([
      [0.12, 0.72],
      [0.88, 0.82],
      [0.18, 0.18],
      [0.82, 0.18],
    ]),
    drifts: Object.freeze([
      [0.1, 0.4],
      [0.26, 0.1],
      [0.58, 0.08],
      [0.9, 0.42],
      [0.88, 0.76],
    ]),
    ice: Object.freeze([
      [0.08, 0.88],
      [0.45, 0.92],
      [0.92, 0.1],
      [0.7, 0.9],
      [0.1, 0.14],
    ]),
    rocks: Object.freeze([
      [0.08, 0.56],
      [0.34, 0.08],
      [0.72, 0.1],
    ]),
  }),
]);
const PAL = Object.freeze([
  Object.freeze({
    field: "#e8f2f4",
    field2: "#dcebed",
    pond: "#8fc1cf",
    pond2: "#b8dce4",
    line: "#6fa6b5",
    drift: "#f3f8f8",
    rock: "#91aab3",
    cap: "#f5f9f9",
  }),
  Object.freeze({
    field: "#deedf0",
    field2: "#d1e4e8",
    pond: "#84b8c8",
    pond2: "#acd4dd",
    line: "#669dab",
    drift: "#edf5f6",
    rock: "#899fa9",
    cap: "#eef6f7",
  }),
  Object.freeze({
    field: "#e2eff2",
    field2: "#d5e7eb",
    pond: "#97c7d3",
    pond2: "#c2e0e6",
    line: "#76aab7",
    drift: "#f7faf9",
    rock: "#9aafb7",
    cap: "#fbfcfb",
  }),
]);
const P = (x, y, r, sx, sy, px, py) =>
  transformedPoint(x, y, r, sx, sy, px, py);
const path = (pts, x, y, r, sx, sy) => {
  const p = new Path2D();
  addPolygon(
    p,
    pts.map(([a, b]) => P(x, y, r, sx, sy, a, b))
  );
  return p;
};
function field(t, x, y, r, sx, sy, p) {
  return [{ path: path(t.points, x, y, r, sx, sy), style: p.field }];
}
function pond(t, x, y, r, sx, sy, p) {
  const outer = path(t.points, x, y, r, sx, sy),
    inner = path(
      t.points.map(([a, b]) => [a * t.inset, b * t.inset]),
      x,
      y,
      r,
      sx,
      sy
    );
  const crack = new Path2D();
  [
    [-55, -8],
    [0, 12],
    [50, -26],
    [72, 14],
  ].map(([a, b], i) => {
    const q = P(x, y, r, sx, sy, a, b);
    i ? crack.lineTo(q.x, q.y) : crack.moveTo(q.x, q.y);
  });
  return [
    { path: outer, style: p.pond },
    { path: inner, style: p.pond2 },
    { path: crack, strokeStyle: p.line, lineWidth: 5 },
  ];
}
function simple(t, x, y, r, sx, sy, p) {
  return [{ path: path(t.points, x, y, r, sx, sy), style: p.drift }];
}
function ice(t, x, y, r, sx, sy, p) {
  const base = path(t.points, x, y, r, sx, sy);
  return [{ path: base, style: p.pond2 }];
}
function rocks(t, x, y, r, sx, sy, p) {
  const body = new Path2D(),
    cap = new Path2D();
  t.rocks.forEach(([rx, ry, s]) => {
    const pts = [
      [-0.9, -0.3],
      [-0.2, -0.8],
      [0.8, -0.35],
      [0.65, 0.65],
      [-0.55, 0.7],
    ].map(([a, b]) => P(x, y, r, sx, sy, rx + a * s, ry + b * s));
    addPolygon(body, pts);
    addPolygon(cap, [pts[0], pts[1], pts[2], P(x, y, r, sx, sy, rx, ry)]);
  });
  return [
    { path: body, style: p.rock },
    { path: cap, style: p.cap },
  ];
}
export function buildAuthoredArcticScenery(options) {
  const b = buildAuthoredComposition({
    ...options,
    seedSuffix: "authored-arctic",
    recipes: ARCTIC_COMPOSITION_RECIPES,
    palettes: PAL,
    groups: [
      {
        recipeKey: "fields",
        outputKey: "largeFeatures",
        templates: ARCTIC_SNOW_FIELD_TEMPLATES,
        kind: "arctic-snow-field",
        clearance: 100,
        cornerClearance: 130,
        scaleRange: [0.78, 1],
        buildLayers: field,
      },
      {
        recipeKey: "ponds",
        outputKey: "pondFeatures",
        templates: ARCTIC_FROZEN_POND_TEMPLATES,
        kind: "arctic-frozen-pond",
        clearance: 82,
        cornerClearance: 112,
        scaleRange: [0.82, 1.08],
        buildLayers: pond,
      },
      {
        recipeKey: "drifts",
        outputKey: "mediumFeatures",
        templates: ARCTIC_SNOWDRIFT_TEMPLATES,
        kind: "arctic-snowdrift",
        clearance: 64,
        cornerClearance: 98,
        scaleRange: [0.84, 1.12],
        buildLayers: simple,
      },
      {
        recipeKey: "ice",
        outputKey: "iceFeatures",
        templates: ARCTIC_ICE_PATCH_TEMPLATES,
        kind: "arctic-ice-patch",
        clearance: 58,
        cornerClearance: 88,
        scaleRange: [0.84, 1.14],
        buildLayers: ice,
      },
      {
        recipeKey: "rocks",
        outputKey: "rockFeatures",
        templates: ARCTIC_SNOWY_ROCK_TEMPLATES,
        kind: "arctic-snowy-rock-cluster",
        clearance: 58,
        cornerClearance: 88,
        scaleRange: [0.84, 1.12],
        buildLayers: rocks,
      },
    ],
  });
  return {
    ...b,
    mediumFeatures: [...b.pondFeatures, ...b.mediumFeatures],
    smallFeatures: [...b.iceFeatures, ...b.rockFeatures],
  };
}
