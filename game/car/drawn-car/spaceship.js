import { FORMULA_CAR } from "./formula.js";
import { body } from "./parts/body.js";
import { brakeLight } from "./parts/brake-light.js";
import { cockpit } from "./parts/cockpit.js";
import { engineFlame } from "./parts/engine-flame.js";
import { enginePod } from "./parts/engine-pod.js";
import { frontWing } from "./parts/front-wing.js";
import { gearbox } from "./parts/gearbox.js";
import { louvers } from "./parts/louvers.js";
import { navLight } from "./parts/nav-light.js";
import { noseStripe } from "./parts/nose-stripe.js";
import { shipWing } from "./parts/ship-wing.js";
import { sideIntake } from "./parts/side-intake.js";

// The Spaceship: a racer for space tracks, seen from above, nose to the
// right. It is as long and as wide as the Formula car, and it is drawn with
// the parts of the car: the body with its side pods and raised center, the
// glass cockpit, the front wing, the side intakes and vents, and the tail
// light. Swept wings with end plates, two engine pods with flames, and a red
// and a green light at the wing tips make it a spaceship. The flames grow
// with the speed and turn against the steering, as the nozzle of the jet ski
// does. formula.js tells how a car file works.

const POD_Y = -17.5;
const NOZZLE_X = -46;

export const SPACESHIP = {
  boxSize: FORMULA_CAR.boxSize,
  outline: FORMULA_CAR.outline,

  livery: {
    main: "#eef1f6",
    accent: "#2f6bff",
    tertiary: "#ff7a1a",
  },

  // Each area takes "main", "accent", "tertiary", a color, or null. The
  // areas of the car body, cockpit and front wing work as on the car.
  decals: {
    body: "main",
    centerStripe: "accent",
    sidePodStripes: "tertiary",
    noseTip: "accent",
    noseStripe: null,
    cockpitRim: "main",
    intakes: null,
    frontWing: "main",
    frontWingTips: "accent",
    frontWingEdge: null,
    wings: "main",
    wingTips: "accent",
    wingStripes: "tertiary",
    pods: null,
    podRing: "tertiary",
  },

  colors: {
    ...FORMULA_CAR.colors,
    frame: "#4a525c",
    frameLight: "#8b95a1",
    nozzle: "#1c2026",
    nozzleGlow: "#bff4ff",
    flame: "#3fd4ff",
    flameCore: "#effdff",
    navRed: "#ff3b30",
    navGreen: "#2ee86a",
    lampShine: "#ffffff",
  },

  parts: [
    // The flames turn around the nozzle, against the steering.
    {
      id: "flame",
      part: engineFlame,
      mirror: true,
      steers: true,
      steerScale: -1,
      pivot: [NOZZLE_X, POD_Y],
      settings: { x: NOZZLE_X, y: POD_Y, halfWidth: 3.6, length: [3, 9] },
    },
    {
      id: "wing",
      part: shipWing,
      mirror: true,
      settings: {
        corners: [[1, -13], [-22, -29], [-33.5, -29], [-38, -12.5]],
        tipFrom: -24,
        stripe: { from: [-2, -14.4], to: [-21, -27.6], width: 1.6 },
        panels: [[[-10, -15.6], [-29, -27]], [[-24, -14.6], [-35, -21.5]]],
        endPlate: { from: -35.5, to: -20.5, y: -29, width: 2.6 },
      },
    },
    { id: "pod", part: enginePod, mirror: true, settings: { from: NOZZLE_X, to: -14, y: POD_Y, ringAt: -22 } },
    { id: "engineBlock", part: gearbox, settings: { from: -44, to: -37, width: 13 } },
    { id: "tailLight", part: brakeLight, settings: { from: -48.4, to: -43.6, width: 4.4 } },
    { id: "frontWing", part: frontWing, mirror: true },
    {
      id: "body",
      part: body,
      settings: {
        shape: [
          [-40, 0], [-40, -7], [-37, -10.5], [-31, -13.5], [-22, -16], [-12, -17],
          [-2, -16], [8, -13], [18, -9.6], [28, -7], [38, -4.8], [46, -2.6], [51, 0],
        ],
        tub: [
          [-38, 0], [-37.4, -4], [-34, -6.4], [-26, -7.4], [-16, -8.6], [-6, -9.4],
          [3, -9], [10, -7.8], [18, -6], [28, -4.6], [38, -3.2], [45.5, -1.8], [49, 0],
        ],
        rearChevron: [[-37, 0], [-34, -1.8], [-28, -4.2], [-20, -6], [-13, -6.6], [-9, 0]],
        noseChevron: [[20, 0], [21, -3.8], [26, -3.4], [30, -2.4], [33, -1.2], [35, 0]],
        centerStripe: { from: -38, to: 51, rearHalf: 2, noseHalf: 0.7 },
        sidePodStripe: {
          points: [[-30, -12.6], [-20, -14.6], [-10, -15.4], [-1, -14.6], [8, -11.8], [18, -8.6], [30, -6.2], [40, -4.2]],
          width: 1.2,
        },
        noseTipFrom: 45,
      },
    },
    { id: "sideIntake", part: sideIntake, mirror: true },
    { id: "louvers", part: louvers, mirror: true },
    { id: "canopy", part: cockpit, settings: { x: 10, length: 22, width: 11.5, rim: 1.4 } },
    { id: "noseStripe", part: noseStripe },
    // A red light on the left wing tip and a green light on the right.
    { id: "navLightLeft", part: navLight, settings: { x: -18.6, y: -29, radius: 1.5, color: "navRed" } },
    { id: "navLightRight", part: navLight, settings: { x: -18.6, y: 29, radius: 1.5, color: "navGreen" } },
  ],

  steering: {
    maxAngleDeg: 20,
    responseSec: 0.06,
  },
  // The ship has no wheels. The roll only makes the flames flicker.
  wheelSpin: FORMULA_CAR.wheelSpin,
  brakes: FORMULA_CAR.brakes,
};
