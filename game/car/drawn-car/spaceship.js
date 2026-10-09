import { FORMULA_CAR } from "./formula.js";
import { engineFlame } from "./parts/engine-flame.js";
import { noseStripe } from "./parts/nose-stripe.js";
import { shipEngine } from "./parts/ship-engine.js";
import { shipHull } from "./parts/ship-hull.js";
import { shipWing } from "./parts/ship-wing.js";

// The Spaceship: a dart hull with a big canopy, swept wings with tip lights, and two engines side by side.
// Shapes are traced from the concept art; WIDTH narrows them to the car's width.
const WIDTH = 0.71;

const at = (points) => points.map(([x, y]) => [x, y * WIDTH]);
const ENGINE_Y = -7.3 * WIDTH;
const NOZZLE_X = -48;

export const SPACESHIP = {
  boxSize: FORMULA_CAR.boxSize,
  outline: FORMULA_CAR.outline,

  livery: {
    main: "#eef1f6",
    accent: "#2f6bff",
    tertiary: "#ff7a1a",
  },

  // Areas take main, accent, tertiary, a color or null.
  decals: {
    body: "main",
    wings: "main",
    wingTips: "accent",
    noseStripe: "accent",
    engineRing: "tertiary",
  },

  colors: {
    ...FORMULA_CAR.colors,
    frame: "#2b3038",
    frameLight: "#4b535d",
    engine: "#25282d",
    engineLight: "#3c4148",
    nozzle: "#1c2026",
    flame: "#3fa8ff",
    flameCore: "#e6f6ff",
    glassShine: "#9db0c0",
  },

  parts: [
    // The flames turn around the nozzle, against the steering.
    {
      id: "flame",
      part: engineFlame,
      mirror: true,
      steers: true,
      steerScale: -1,
      pivot: [NOZZLE_X, ENGINE_Y],
      settings: { x: NOZZLE_X, y: ENGINE_Y, halfWidth: 3.6 * WIDTH, length: [3, 7] },
    },
    {
      id: "wing",
      part: shipWing,
      mirror: true,
      settings: {
        under: at([
          [10.5, -11], [5, -13.5], [0, -15], [-5, -16.6], [-10, -18.4], [-20, -22.8], [-30, -30],
          [-40, -37.5], [-45, -40.3], [-50.2, -40.6], [-51.5, -39.6], [-51.2, -36], [-49.4, -30],
          [-47, -24.5], [-44.6, -20.4], [-41.6, -16.4], [-38.6, -14], [-30, -12.5], [0, -11],
        ]),
        top: at([
          [10.5, -11], [5, -13.5], [0, -15], [-5, -16.6], [-10, -18.4], [-20, -22.8], [-30, -30],
          [-40, -37.5], [-45, -40.3], [-50.2, -40.6], [-50.9, -39.6], [-46.8, -36], [-42.5, -30],
          [-38, -24], [-34, -18.5], [-31, -15.2], [-29, -14.2], [-22, -13.6], [0, -11],
        ]),
        facet: at([[-44.5, -27], [-37.4, -14.6], [-35.2, -14.8], [-41.4, -24.6]]),
        strip: at([[-50.6, -35.2], [-48, -36.8], [-41, -22.4], [-43.6, -20.8]]),
        stripLine: at([[-46.6, -27.2], [-43, -26]]),
      },
    },
    {
      id: "engine",
      part: shipEngine,
      mirror: true,
      settings: {
        y: ENGINE_Y,
        halfWidth: 5.8 * WIDTH,
        housing: at([[-39.5, -13.4], [-30.5, -13.4], [-26, -9.4], [-31, -6.8], [-37.2, -4.6], [-39.5, -4.6]]),
        housingFacet: at([[-37, -12.8], [-31.6, -12.8], [-29.6, -10.6], [-35.6, -10.6]]),
        glint: { from: -44.5, to: -37.5, y: -8.9 * WIDTH },
      },
    },
    {
      id: "body",
      part: shipHull,
      settings: {
        strake: at([
          [-25, -12.6], [-21, -13.9], [-10, -14.3], [0, -13.5], [8, -11.8], [16, -9.4], [20, -7.6],
          [10, -9.6], [0, -10.2], [-10, -10], [-18, -9.4],
        ]),
        ventRim: at([[-36, -6], [-29.5, -10.6], [-25.5, -11.4], [-22, -10.6], [-16.6, -8.8], [-22, -8.2], [-30, -7]]),
        ventSlot: at([[-31, -7.4], [-27, -9.9], [-24.5, -10.3], [-17.8, -8.8], [-24, -8.4], [-28.5, -7.8]]),
        pod: at([
          [-38.6, 0], [-38.6, -2.6], [-37.6, -4.4], [-33, -6], [-28, -7.6], [-22, -8.8], [-14, -9.6],
          [-4, -10], [4, -9.9], [10, -9.8], [20, -7.9], [30, -5.9], [40, -4.2], [46, -3.4], [49.6, -2.8], [51.2, -1.6], [51.6, 0],
        ]),
        recess: at([[-36.4, 0], [-36.4, -2.4], [-34, -3.2], [-24, -3.6], [-21.4, -1.6], [-21, 0]]),
        chevron: at([[14.4, 0], [14.6, -3], [17, -2.8], [21, -1.6], [24, 0]]),
        canopy: at([
          [-20.6, 0], [-20.2, -3.8], [-18.4, -6], [-14.5, -7.1], [-8, -7.2], [-1, -6.5], [5, -5], [9, -2.8], [10.8, 0],
        ]),
        shine: at([
          [-12.6, -4.6], [-10, -5.4], [0, -4.6], [6, -3], [8.4, -1.4], [7.6, -1], [0, -2.8], [-10, -3.4], [-12.4, -3.6],
        ]),
      },
    },
    {
      id: "noseStripe",
      part: noseStripe,
      settings: { from: 34, to: 47.5, width: 3.6 * WIDTH, frontWidth: 1.8 * WIDTH },
    },
  ],

  steering: {
    maxAngleDeg: 20,
    responseSec: 0.06,
  },
  // The ship has no wheels. The roll only makes the flames flicker.
  wheelSpin: FORMULA_CAR.wheelSpin,
  brakes: FORMULA_CAR.brakes,
};
