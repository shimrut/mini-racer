import { body } from "./parts/body.js";
import { brakeLight } from "./parts/brake-light.js";
import { cockpit } from "./parts/cockpit.js";
import { frontWing } from "./parts/front-wing.js";
import { gearbox } from "./parts/gearbox.js";
import { noseStripe } from "./parts/nose-stripe.js";
import { rearWing } from "./parts/rear-wing.js";
import { sideIntake } from "./parts/side-intake.js";
import { suspensionArm } from "./parts/suspension-arm.js";
import { wheel } from "./parts/wheel.js";

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
//   pivot     the turn point, from the center of the part
//
// "colors" are the named colors that all parts use. A skin can change them
// for the whole car or for one part.
export const FORMULA_CAR = {
  // The square that holds the car. The car is 100 units of it.
  boxSize: 110,
  outline: 1.3,

  colors: {
    paint: "#f90815",
    paintShade: "#b40106",
    paintDeep: "#960000",
    paintLight: "#ff3c40",
    stripe: "#feed4c",
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

    { id: "rearWheelLeft", part: wheel, at: [-29.8, -23.6] },
    { id: "rearWheelRight", part: wheel, at: [-29.8, 23.6] },
    // A front tire turns on the joint where its arms meet it: the middle of
    // its inner edge.
    {
      id: "frontWheelLeft",
      part: wheel,
      at: [26.8, -21.8],
      settings: { length: 17, width: 9.5 },
      steers: true,
      pivot: [0, 4.75],
    },
    {
      id: "frontWheelRight",
      part: wheel,
      at: [26.8, 21.8],
      settings: { length: 17, width: 9.5 },
      steers: true,
      pivot: [0, -4.75],
    },

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
