import {
  addPolygon,
  buildAuthoredComposition,
  transformedPoint,
} from "./authored-scenery.js";

const polygon = (points) =>
  Object.freeze(points.map((point) => Object.freeze(point)));
const template = (value) => Object.freeze(value);

export const MOUNTAIN_RIDGE_TEMPLATES = Object.freeze([
  template({
    id: "mountain-ridge-01",
    radius: 330,
    body: polygon([
      [-310, 90],
      [-245, -92],
      [-104, -238],
      [38, -116],
      [142, -254],
      [302, -76],
      [286, 130],
      [80, 230],
      [-142, 210],
    ]),
    face: polygon([
      [-245, -92],
      [-104, -238],
      [38, -116],
      [80, 230],
      [-142, 210],
    ]),
    crest: polygon([
      [-245, -92],
      [-104, -238],
      [38, -116],
      [142, -254],
      [302, -76],
    ]),
  }),
  template({
    id: "mountain-ridge-02",
    radius: 315,
    body: polygon([
      [-292, 122],
      [-260, -48],
      [-122, -218],
      [18, -178],
      [118, -74],
      [226, -194],
      [296, 24],
      [210, 202],
      [-30, 236],
      [-238, 198],
    ]),
    face: polygon([
      [-122, -218],
      [18, -178],
      [118, -74],
      [-30, 236],
      [-238, 198],
    ]),
    crest: polygon([
      [-260, -48],
      [-122, -218],
      [18, -178],
      [118, -74],
      [226, -194],
    ]),
  }),
  template({
    id: "mountain-ridge-03",
    radius: 340,
    body: polygon([
      [-326, 18],
      [-214, -172],
      [-48, -230],
      [74, -106],
      [214, -226],
      [326, -24],
      [272, 170],
      [94, 244],
      [-132, 220],
      [-286, 136],
    ]),
    face: polygon([
      [-214, -172],
      [-48, -230],
      [74, -106],
      [94, 244],
      [-132, 220],
    ]),
    crest: polygon([
      [-214, -172],
      [-48, -230],
      [74, -106],
      [214, -226],
      [326, -24],
    ]),
  }),
]);

export const MOUNTAIN_ROCK_FIELD_TEMPLATES = Object.freeze([
  template({
    id: "mountain-rock-field-01",
    radius: 150,
    rocks: Object.freeze([
      [-112, 18, 46],
      [-54, -48, 38],
      [10, 26, 52],
      [70, -34, 34],
      [118, 42, 26],
    ]),
  }),
  template({
    id: "mountain-rock-field-02",
    radius: 156,
    rocks: Object.freeze([
      [-118, -30, 34],
      [-74, 48, 48],
      [-12, -14, 42],
      [52, 42, 34],
      [112, -28, 46],
    ]),
  }),
  template({
    id: "mountain-rock-field-03",
    radius: 148,
    rocks: Object.freeze([
      [-106, 42, 38],
      [-48, -36, 48],
      [18, -52, 30],
      [58, 30, 50],
      [112, 2, 28],
    ]),
  }),
]);

export const MOUNTAIN_BOULDER_TEMPLATES = Object.freeze([
  template({
    id: "mountain-boulders-01",
    radius: 96,
    rocks: Object.freeze([
      [-46, 8, 42],
      [18, -20, 34],
      [50, 28, 24],
    ]),
  }),
  template({
    id: "mountain-boulders-02",
    radius: 92,
    rocks: Object.freeze([
      [-42, -20, 30],
      [4, 16, 44],
      [50, -6, 28],
    ]),
  }),
]);

export const MOUNTAIN_TREE_GROUP_TEMPLATES = Object.freeze([
  template({
    id: "mountain-trees-01",
    radius: 105,
    trees: Object.freeze([
      [-70, 22, 0.8],
      [-18, -34, 1],
      [40, 18, 0.72],
      [78, -18, 0.86],
    ]),
  }),
  template({
    id: "mountain-trees-02",
    radius: 110,
    trees: Object.freeze([
      [-76, -18, 0.72],
      [-26, 28, 0.92],
      [30, -30, 0.82],
      [76, 24, 1],
    ]),
  }),
  template({
    id: "mountain-trees-03",
    radius: 102,
    trees: Object.freeze([
      [-66, 30, 0.86],
      [-22, -24, 0.74],
      [28, 18, 1],
      [70, -30, 0.78],
    ]),
  }),
]);

const edge = [
  [0.08, 0.12],
  [0.27, 0.08],
  [0.5, 0.07],
  [0.73, 0.09],
  [0.92, 0.16],
  [0.93, 0.5],
  [0.87, 0.86],
  [0.52, 0.93],
  [0.18, 0.9],
  [0.07, 0.55],
];
export const MOUNTAIN_COMPOSITION_RECIPES = Object.freeze([
  Object.freeze({
    id: "MOUNTAINS_A",
    ridges: Object.freeze(edge.slice(0, 8)),
    rocks: Object.freeze([
      [0.1, 0.3],
      [0.3, 0.11],
      [0.65, 0.1],
      [0.9, 0.34],
      [0.86, 0.77],
      [0.24, 0.88],
    ]),
    boulders: Object.freeze([
      [0.08, 0.72],
      [0.5, 0.92],
      [0.92, 0.62],
      [0.72, 0.9],
    ]),
    trees: Object.freeze([
      [0.16, 0.14],
      [0.38, 0.08],
      [0.82, 0.16],
      [0.14, 0.86],
    ]),
  }),
  Object.freeze({
    id: "MOUNTAINS_B",
    ridges: Object.freeze([
      [0.08, 0.18],
      [0.08, 0.46],
      [0.1, 0.78],
      [0.35, 0.92],
      [0.66, 0.9],
      [0.91, 0.74],
      [0.92, 0.38],
    ]),
    rocks: Object.freeze([
      [0.2, 0.1],
      [0.46, 0.08],
      [0.77, 0.12],
      [0.9, 0.55],
      [0.68, 0.9],
      [0.18, 0.86],
      [0.07, 0.62],
    ]),
    boulders: Object.freeze([
      [0.08, 0.08],
      [0.92, 0.12],
      [0.9, 0.9],
    ]),
    trees: Object.freeze([
      [0.3, 0.1],
      [0.72, 0.1],
      [0.88, 0.58],
      [0.28, 0.9],
      [0.08, 0.52],
    ]),
  }),
  Object.freeze({
    id: "MOUNTAINS_C",
    ridges: Object.freeze([
      [0.08, 0.1],
      [0.36, 0.08],
      [0.68, 0.08],
      [0.92, 0.2],
      [0.92, 0.54],
      [0.86, 0.88],
    ]),
    rocks: Object.freeze([
      [0.14, 0.2],
      [0.52, 0.08],
      [0.84, 0.18],
      [0.91, 0.7],
      [0.58, 0.91],
    ]),
    boulders: Object.freeze([
      [0.08, 0.5],
      [0.18, 0.88],
      [0.82, 0.9],
      [0.94, 0.46],
      [0.48, 0.94],
    ]),
    trees: Object.freeze([
      [0.12, 0.12],
      [0.76, 0.1],
      [0.92, 0.38],
    ]),
  }),
]);

const PALETTES = Object.freeze([
  Object.freeze({
    base: "#172238",
    face: "#202f49",
    crest: "#3a4962",
    rock: "#27354d",
    accent: "#52617a",
    tree: "#142837",
    treeAccent: "#2a4350",
  }),
  Object.freeze({
    base: "#1b2840",
    face: "#263650",
    crest: "#43526a",
    rock: "#2c3a52",
    accent: "#5a6981",
    tree: "#172d3d",
    treeAccent: "#304a57",
  }),
  Object.freeze({
    base: "#202d45",
    face: "#2b3b55",
    crest: "#4a5971",
    rock: "#314058",
    accent: "#627188",
    tree: "#1a3242",
    treeAccent: "#36505d",
  }),
]);

function local(x, y, r, sx, sy, px, py) {
  return transformedPoint(x, y, r, sx, sy, px, py);
}
function ridgeLayers(t, x, y, r, sx, sy, p) {
  const build = (points) => {
    const path = new Path2D();
    addPolygon(
      path,
      points.map(([px, py]) => local(x, y, r, sx, sy, px, py))
    );
    return path;
  };
  return [
    { path: build(t.body), style: p.base },
    { path: build(t.face), style: p.face },
    { path: build(t.crest), style: p.crest },
  ];
}
function rockLayers(t, x, y, r, sx, sy, p) {
  const body = new Path2D();
  const accent = new Path2D();
  t.rocks.forEach(([rx, ry, size]) => {
    const pts = [
      [-0.9, -0.35],
      [-0.22, -0.8],
      [0.82, -0.42],
      [0.72, 0.54],
      [-0.48, 0.76],
    ].map(([px, py]) => local(x, y, r, sx, sy, rx + px * size, ry + py * size));
    addPolygon(body, pts);
    addPolygon(accent, [pts[0], pts[1], local(x, y, r, sx, sy, rx, ry)]);
  });
  return [
    { path: body, style: p.rock },
    { path: accent, style: p.accent },
  ];
}
function treeLayers(t, x, y, r, sx, sy, p) {
  const body = new Path2D();
  const accent = new Path2D();
  t.trees.forEach(([tx, ty, s], i) => {
    const pts = [
      [0, -30],
      [20, 28],
      [-20, 28],
    ].map(([px, py]) => local(x, y, r, sx, sy, tx + px * s, ty + py * s));
    addPolygon(i % 3 === 0 ? accent : body, pts);
  });
  return [
    { path: body, style: p.tree },
    { path: accent, style: p.treeAccent },
  ];
}

export function buildAuthoredMountainScenery(options) {
  const built = buildAuthoredComposition({
    ...options,
    seedSuffix: "authored-mountains",
    recipes: MOUNTAIN_COMPOSITION_RECIPES,
    palettes: PALETTES,
    groups: [
      {
        recipeKey: "ridges",
        outputKey: "largeFeatures",
        templates: MOUNTAIN_RIDGE_TEMPLATES,
        kind: "mountain-ridge",
        clearance: 100,
        cornerClearance: 130,
        scaleRange: [0.72, 0.94],
        buildLayers: ridgeLayers,
      },
      {
        recipeKey: "rocks",
        outputKey: "mediumFeatures",
        templates: MOUNTAIN_ROCK_FIELD_TEMPLATES,
        kind: "mountain-rock-field",
        clearance: 64,
        cornerClearance: 100,
        scaleRange: [0.8, 1.08],
        buildLayers: rockLayers,
      },
      {
        recipeKey: "boulders",
        outputKey: "boulderFeatures",
        templates: MOUNTAIN_BOULDER_TEMPLATES,
        kind: "mountain-boulder-cluster",
        clearance: 60,
        cornerClearance: 92,
        scaleRange: [0.82, 1.12],
        buildLayers: rockLayers,
      },
      {
        recipeKey: "trees",
        outputKey: "treeFeatures",
        templates: MOUNTAIN_TREE_GROUP_TEMPLATES,
        kind: "mountain-sparse-tree-group",
        clearance: 58,
        cornerClearance: 88,
        scaleRange: [0.82, 1.08],
        buildLayers: treeLayers,
      },
    ],
  });
  return {
    ...built,
    smallFeatures: [...built.boulderFeatures, ...built.treeFeatures],
  };
}
