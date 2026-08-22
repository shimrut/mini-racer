import {
  addPolygon,
  buildAuthoredComposition,
  transformedPoint,
} from "./authored-scenery.js";
const poly = (p) => Object.freeze(p.map((x) => Object.freeze(x)));
const t = (v) => Object.freeze(v);
export const BEACH_DUNE_TEMPLATES = Object.freeze([
  t({
    id: "beach-dune-01",
    radius: 320,
    points: poly([
      [-310, 20],
      [-240, -172],
      [-42, -228],
      [176, -178],
      [304, -18],
      [244, 178],
      [20, 228],
      [-238, 168],
    ]),
    crest: poly([
      [-210, -72],
      [-52, -132],
      [126, -92],
      [230, -12],
    ]),
  }),
  t({
    id: "beach-dune-02",
    radius: 305,
    points: poly([
      [-292, -54],
      [-142, -214],
      [92, -202],
      [292, -52],
      [266, 146],
      [68, 218],
      [-190, 184],
      [-304, 56],
    ]),
    crest: poly([
      [-190, -106],
      [-24, -142],
      [146, -86],
      [232, -12],
    ]),
  }),
  t({
    id: "beach-dune-03",
    radius: 330,
    points: poly([
      [-318, 54],
      [-248, -146],
      [-70, -230],
      [154, -196],
      [314, -26],
      [250, 178],
      [24, 238],
      [-220, 182],
    ]),
    crest: poly([
      [-222, -58],
      [-76, -128],
      [104, -112],
      [240, -28],
    ]),
  }),
]);
const band = (innerEdge, outerEdge) => poly([
  ...innerEdge,
  ...[...outerEdge].reverse(),
]);
const shoreline = (id, radius, coastline, wetEdge, shallowEdge, deepEdge) => t({
  id,
  radius,
  bands: Object.freeze([
    band(coastline, wetEdge),
    band(wetEdge, shallowEdge),
    band(shallowEdge, deepEdge),
  ]),
  foam: poly(wetEdge),
});

export const BEACH_SHORELINE_TEMPLATES = Object.freeze([
  shoreline(
    "beach-shoreline-01",
    450,
    [[-360, -138], [-190, -174], [-14, -148], [166, -96], [352, -22]],
    [[-360, -86], [-190, -120], [-8, -96], [168, -46], [352, 28]],
    [[-360, -6], [-184, -34], [4, -12], [174, 34], [352, 104]],
    [[-360, 192], [-170, 176], [20, 196], [192, 226], [352, 276]],
  ),
  shoreline(
    "beach-shoreline-02",
    440,
    [[-348, -104], [-164, -156], [26, -134], [196, -72], [344, 8]],
    [[-348, -54], [-160, -104], [28, -82], [194, -22], [344, 58]],
    [[-348, 22], [-154, -24], [34, -4], [196, 52], [344, 126]],
    [[-348, 218], [-138, 188], [48, 202], [210, 244], [344, 292]],
  ),
  shoreline(
    "beach-shoreline-03",
    460,
    [[-372, -82], [-230, -142], [-42, -162], [152, -112], [366, -28]],
    [[-372, -30], [-226, -88], [-38, -108], [156, -58], [366, 24]],
    [[-372, 48], [-220, -8], [-30, -26], [164, 22], [366, 100]],
    [[-372, 248], [-204, 202], [-12, 190], [182, 226], [366, 286]],
  ),
]);
export const BEACH_PEBBLE_TEMPLATES = Object.freeze([
  t({
    id: "beach-pebbles-01",
    radius: 92,
    rocks: Object.freeze([
      [-54, 8, 24],
      [-18, -24, 16],
      [18, 16, 20],
      [54, -10, 14],
    ]),
  }),
  t({
    id: "beach-pebbles-02",
    radius: 96,
    rocks: Object.freeze([
      [-58, -18, 18],
      [-24, 20, 24],
      [16, -12, 15],
      [54, 18, 22],
    ]),
  }),
]);
export const BEACH_COMPOSITION_RECIPES = Object.freeze([
  Object.freeze({
    id: "BEACH_A",
    dunes: Object.freeze([
      [0.08, 0.12],
      [0.34, 0.08],
      [0.68, 0.08],
      [0.92, 0.18],
      [0.9, 0.72],
      [0.68, 0.9],
      [0.18, 0.9],
      [0.07, 0.58],
    ]),
    shorelines: Object.freeze([
      [0.1, 0.42],
      [0.9, 0.5],
    ]),
    pebbles: Object.freeze([
      [0.08, 0.08],
      [0.92, 0.1],
      [0.9, 0.9],
      [0.12, 0.9],
    ]),
  }),
  Object.freeze({
    id: "BEACH_B",
    dunes: Object.freeze([
      [0.08, 0.18],
      [0.08, 0.5],
      [0.1, 0.82],
      [0.42, 0.92],
      [0.76, 0.88],
      [0.92, 0.62],
      [0.92, 0.24],
    ]),
    shorelines: Object.freeze([[0.78, 0.12]]),
    pebbles: Object.freeze([
      [0.24, 0.08],
      [0.64, 0.08],
      [0.92, 0.42],
      [0.72, 0.9],
      [0.18, 0.88],
    ]),
  }),
  Object.freeze({
    id: "BEACH_C",
    dunes: Object.freeze([
      [0.08, 0.1],
      [0.42, 0.08],
      [0.78, 0.1],
      [0.92, 0.36],
      [0.9, 0.78],
    ]),
    shorelines: Object.freeze([
      [0.08, 0.64],
      [0.82, 0.86],
      [0.88, 0.14],
    ]),
    pebbles: Object.freeze([
      [0.12, 0.18],
      [0.58, 0.08],
      [0.92, 0.58],
    ]),
  }),
]);
const PAL = Object.freeze([
  Object.freeze({
    sand: "#d7bd86",
    crest: "#e5cf9c",
    wet: "#aa8c60",
    shallow: "#568995",
    deep: "#376976",
    foam: "#d9e7df",
    rock: "#826f57",
    accent: "#a58e6b",
  }),
  Object.freeze({
    sand: "#cfb27a",
    crest: "#dfc994",
    wet: "#a38358",
    shallow: "#4f818e",
    deep: "#32616e",
    foam: "#d2e2da",
    rock: "#796650",
    accent: "#9c8565",
  }),
  Object.freeze({
    sand: "#ddc590",
    crest: "#ead6a7",
    wet: "#b09267",
    shallow: "#60929c",
    deep: "#3d707b",
    foam: "#e2ece5",
    rock: "#8b755b",
    accent: "#ae9671",
  }),
]);
const P = (x, y, r, sx, sy, a, b) => transformedPoint(x, y, r, sx, sy, a, b);
const path = (pts, x, y, r, sx, sy) => {
  const p = new Path2D();
  addPolygon(
    p,
    pts.map(([a, b]) => P(x, y, r, sx, sy, a, b))
  );
  return p;
};
const line = (pts, x, y, r, sx, sy) => {
  const result = new Path2D();
  pts.forEach(([a, b], index) => {
    const point = P(x, y, r, sx, sy, a, b);
    if (index === 0) result.moveTo(point.x, point.y);
    else result.lineTo(point.x, point.y);
  });
  return result;
};
function dune(t, x, y, r, sx, sy, p) {
  return [
    { path: path(t.points, x, y, r, sx, sy), style: p.sand },
    { path: line(t.crest, x, y, r, sx, sy), strokeStyle: p.crest, lineWidth: 8 },
  ];
}
function shore(t, x, y, r, sx, sy, p) {
  return [
    { path: path(t.bands[0], x, y, r, sx, sy), style: p.wet },
    { path: path(t.bands[1], x, y, r, sx, sy), style: p.shallow },
    { path: path(t.bands[2], x, y, r, sx, sy), style: p.deep },
    { path: line(t.foam, x, y, r, sx, sy), strokeStyle: p.foam, lineWidth: 7 },
  ];
}
function pebbles(t, x, y, r, sx, sy, p) {
  const body = new Path2D(),
    accent = new Path2D();
  t.rocks.forEach(([rx, ry, s], i) => {
    const pts = [
      [-1, 0],
      [-0.5, -0.65],
      [0.55, -0.55],
      [1, 0.1],
      [0.4, 0.7],
      [-0.55, 0.65],
    ].map(([a, b]) => P(x, y, r, sx, sy, rx + a * s, ry + b * s));
    addPolygon(i % 3 ? body : accent, pts);
  });
  return [
    { path: body, style: p.rock },
    { path: accent, style: p.accent },
  ];
}
export function buildAuthoredBeachScenery(options) {
  const b = buildAuthoredComposition({
    ...options,
    seedSuffix: "authored-beach",
    recipes: BEACH_COMPOSITION_RECIPES,
    palettes: PAL,
    groups: [
      {
        recipeKey: "dunes",
        outputKey: "largeFeatures",
        templates: BEACH_DUNE_TEMPLATES,
        kind: "beach-dune-mass",
        clearance: 100,
        cornerClearance: 130,
        scaleRange: [0.76, 0.98],
        buildLayers: dune,
      },
      {
        recipeKey: "shorelines",
        outputKey: "mediumFeatures",
        templates: BEACH_SHORELINE_TEMPLATES,
        kind: "beach-shoreline-system",
        clearance: 104,
        cornerClearance: 134,
        scaleRange: [0.58, 0.78],
        buildLayers: shore,
      },
      {
        recipeKey: "pebbles",
        outputKey: "smallFeatures",
        templates: BEACH_PEBBLE_TEMPLATES,
        kind: "beach-pebble-group",
        clearance: 58,
        cornerClearance: 88,
        scaleRange: [0.84, 1.16],
        buildLayers: pebbles,
      },
    ],
  });
  return b;
}
