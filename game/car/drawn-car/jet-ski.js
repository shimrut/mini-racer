import { FORMULA_CAR } from "./formula.js";
import { brakeLight } from "./parts/brake-light.js";
import { handlebar } from "./parts/handlebar.js";
import { grabHandle, rearMirror, sponson, windscreen } from "./parts/jet-ski-details.js";
import { jetNozzle } from "./parts/jet-nozzle.js";
import { jetSkiHull } from "./parts/jet-ski-hull.js";
import { jetSkiSeat } from "./parts/jet-ski-seat.js";
import { navLight } from "./parts/nav-light.js";
import { rider } from "./parts/rider.js";
import { wake } from "./parts/wake.js";

// The Jet Ski for water tracks, Formula-sized; its nozzle steers against the bars and its wake grows with speed.

export const JET_SKI = {
  boxSize: FORMULA_CAR.boxSize,
  outline: FORMULA_CAR.outline,

  livery: {
    main: "#f4f4ef",
    accent: "#e0161e",
    tertiary: "#1b3f8f",
  },

  // Each area takes "main", "accent", "tertiary", a color, or null.
  decals: {
    hull: "main",
    hullStripes: "accent",
    hoodStripe: "tertiary",
    noseTip: null,
    seat: null,
    mirrors: null,
    barPad: "tertiary",
    helmet: "accent",
    vest: "#ff8a1f",
  },

  colors: {
    outline: "#0b0b0c",
    glass: FORMULA_CAR.colors.glass,
    glassShade: FORMULA_CAR.colors.glassShade,
    glassShine: FORMULA_CAR.colors.glassShine,
    fender: "#1f2226",
    fenderLight: "#4a5058",
    mat: "#59626c",
    matLine: "#6b747e",
    matShade: "#3f474f",
    seat: "#1f2328",
    seatLight: "#3a4048",
    seatSeam: "#101316",
    bar: "#2a2e33",
    grip: "#121417",
    nozzle: "#23272c",
    nozzleLight: "#4a5057",
    suit: "#46546b",
    glove: "#101216",
    visor: "#1a2530",
    foam: "#f2faff",
    lamp: "#fff3c4",
    lampShine: "#ffffff",
    lightOff: FORMULA_CAR.colors.lightOff,
    lightOn: FORMULA_CAR.colors.lightOn,
    lightCore: FORMULA_CAR.colors.lightCore,
    lightGlow: FORMULA_CAR.colors.lightGlow,
  },

  parts: [
    // The jet wash is narrow at the nozzle and fans out behind it.
    {
      id: "wake",
      part: wake,
      settings: {
        sternX: -46,
        washHalfWidth: 6,
        washLength: [5, 38],
        washSpread: 12,
        bowWave: [0.5, 4.5],
        bowEdge: [[49.5, 0], [48, -3.6], [44, -7.6], [38, -12.4], [30, -17], [21, -21], [10, -24], [-2, -25.6], [-16, -25.8]],
      },
    },
    { id: "nozzle", part: jetNozzle, at: [-44, 0], steers: true, steerScale: -1 },
    // Two tail lights on the corners of the stern.
    { id: "tailLight", part: brakeLight, at: [0, -16.5], mirror: true, settings: { from: -47.6, to: -44.2, width: 4.2 } },
    { id: "sponson", part: sponson, mirror: true },
    { id: "hull", part: jetSkiHull },
    { id: "headlight", part: navLight, mirror: true, settings: { x: 40, y: -6.4, radius: 1.7, color: "lamp" } },
    { id: "mirror", part: rearMirror, mirror: true },
    { id: "windscreen", part: windscreen },
    { id: "seat", part: jetSkiSeat },
    { id: "grabHandle", part: grabHandle },
    { id: "handlebar", part: handlebar, at: [9, 0], steers: true },
    { id: "rider", part: rider, settings: { knee: [-3, 13], foot: [-11, 16] } },
  ],

  steering: {
    maxAngleDeg: 22,
    responseSec: 0.08,
  },
  // The jet ski has no wheels. The roll only moves the bubbles in the wake.
  wheelSpin: FORMULA_CAR.wheelSpin,
  brakes: FORMULA_CAR.brakes,
};
