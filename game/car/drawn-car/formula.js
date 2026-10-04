import { body } from "./parts/body.js";
import { brakeLight } from "./parts/brake-light.js";
import { cockpit } from "./parts/cockpit.js";
import { frontWing } from "./parts/front-wing.js";
import { gearbox } from "./parts/gearbox.js";
import { hub } from "./parts/hub.js";
import { noseStripe } from "./parts/nose-stripe.js";
import { rearWing } from "./parts/rear-wing.js";
import { sideIntake } from "./parts/side-intake.js";
import { suspensionArm } from "./parts/suspension-arm.js";
import { tire } from "./parts/tire.js";

// The Formula car: the red open-wheel car, seen from above, nose to the right.
//
// All sizes are in car units. The car is 100 units long: the rear wing is at
// x = -50 and the nose tip is at x = 50. Negative y is the left side of the
// car and positive y is the right side.
//
// "parts" is the list of parts, in drawing order: a part covers the parts
// before it. Each item has:
//   id        the name that a skin uses to change this part
//   part      the part file that draws it
//   settings  changes to the part's own settings (sizes and shapes)
//   mirror    true: the part is also drawn as a mirror copy on the right side
//   steers    true: the part turns with the steering, around "pivot"
//   steerScale  optional: a multiplier on the steering angle; -1 turns the
//             part the other way
//   pivot     the turn point, from the center of the part (default: the
//             center)
//
// A tire and its hub use the same sizes.
const FRONT_TIRE = { length: 17, width: 9.5 };

// "livery" gives the three paint colors, and "decals" gives the paint of
// each decal area. game/car/drawn-car.js tells how they work. "colors" are
// the materials that are not paint: glass, frame, tires, lights.
export const FORMULA_CAR = {
  // The square that holds the car. The car is 100 units of it.
  boxSize: 110,
  outline: 1.3,

  livery: {
    // The tones of the red in the picture that this car copies.
    main: { base: "#f90815", shade: "#b40106", deep: "#960000", light: "#ff3c40" },
    accent: "#feed4c",
    tertiary: "#ffffff",
  },

  // Each area takes "main", "accent", "tertiary", a color, or null.
  decals: {
    body: "main",
    centerStripe: null,
    sidePodStripes: null,
    noseTip: null,
    noseStripe: "accent",
    cockpitRim: "main",
    intakes: null,
    rearWing: "main",
    rearWingFlap: null,
    rearWingEnds: null,
    frontWing: "main",
    frontWingTips: null,
    frontWingEdge: null,
  },

  colors: {
    glass: "#40515b",
    glassShade: "#2c3944",
    glassShine: "#8295a1",
    intake: "#39454c",
    intakeLight: "#5a5c69",
    frame: "#3b4242",
    frameLight: "#4e5051",
    tire: "#232828",
    tireFace: "#3e4243",
    tireSide: "#4e5051",
    tireLine: "#141919",
    outline: "#0b0b0c",
    lightOff: "#5c1418",
    lightOn: "#ff3b30",
    lightCore: "#ffe6de",
    lightGlow: "#ff2d23",
  },

  parts: [
    { id: "rearArmFront", part: suspensionArm, mirror: true, settings: { from: [-29.5, -20], to: [-26, -9] } },
    { id: "rearArmBack", part: suspensionArm, mirror: true, settings: { from: [-30.5, -20], to: [-34.5, -9.5] } },
    { id: "rearArmBar", part: suspensionArm, mirror: true, settings: { from: [-40, -12.5], to: [-30, -8] } },
    // The front arms meet at the joint on the inner edge of the front tire.
    { id: "frontArmBack", part: suspensionArm, mirror: true, settings: { from: [26.3, -17.8], to: [19.1, -8] } },
    { id: "frontArmFront", part: suspensionArm, mirror: true, settings: { from: [27.3, -17.8], to: [31.8, -5.5] } },

    // Each tire is a mirror pair, so the side wall and the hub face the body
    // on both sides of the car.
    { id: "rearTire", part: tire, at: [-29.8, -23.6], mirror: true },
    // A front tire and its hub turn in place, on the center of the tire. The
    // arms stay still.
    { id: "frontTire", part: tire, at: [26.8, -21.8], settings: FRONT_TIRE, mirror: true, steers: true },
    { id: "rearHub", part: hub, at: [-29.8, -23.6], mirror: true },
    { id: "frontHub", part: hub, at: [26.8, -21.8], settings: FRONT_TIRE, mirror: true, steers: true },

    { id: "gearbox", part: gearbox },
    { id: "brakeLight", part: brakeLight },
    { id: "rearWing", part: rearWing },
    { id: "frontWing", part: frontWing, mirror: true },
    { id: "body", part: body },
    { id: "sideIntake", part: sideIntake, mirror: true },
    { id: "cockpit", part: cockpit },
    { id: "noseStripe", part: noseStripe },
  ],

  steering: {
    // The turn angle of the front wheels at full steering.
    maxAngleDeg: 24,
    // The time the wheels take to go most of the way to a new angle.
    responseSec: 0.06,
  },
  wheelSpin: {
    // The tires roll by this distance in one frame, or less. A larger step
    // makes a fast wheel look like it turns backward.
    maxStepPerFrame: 1.3,
    // At this distance in one frame, the grooves are fully blurred.
    blurStep: 3.5,
  },
  brakes: {
    // The light comes on when the car loses more speed than this.
    decelKphPerSec: 60,
    // The light stays on for this time after the car stops losing speed.
    holdSec: 0.22,
    onSec: 0.05,
    offSec: 0.18,
  },
};

// The race and Mapmaker draw this car in a square of this many pixels.
export const DRAWN_CAR_DRAW_PIXELS = 52;

// Width of this picture in world units. The rear tires are the widest part.
// pixelsPerWorldUnit is the race grid size: that many pixels are one unit.
export function normalCarPictureWidth(pixelsPerWorldUnit) {
  const rear = FORMULA_CAR.parts.find((part) => part.id === "rearTire");
  const tireWidth = rear.settings?.width ?? tire.defaults.width;
  const artWidth = 2 * (Math.abs(rear.at[1]) + tireWidth / 2);
  return artWidth / FORMULA_CAR.boxSize * DRAWN_CAR_DRAW_PIXELS / pixelsPerWorldUnit;
}
