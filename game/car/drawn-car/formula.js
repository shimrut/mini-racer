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

// The Formula car from above, nose on +x: 100 units long (x = -50 to 50), -y is the left side.
// Each part: id (for skins), part, settings, mirror, steers/steerScale, pivot; later parts cover earlier ones.
const FRONT_TIRE = { length: 17, width: 9.5 };

// livery: three paint colors; decals: paint per area; colors: glass, frame, tires and lights.
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

    // Mirror pairs, so the side wall and hub face the body on both sides.
    { id: "rearTire", part: tire, at: [-29.8, -23.6], mirror: true },
    // Front tires and hubs turn on the tire center; the arms stay still.
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
    // Max roll per frame; a larger step makes a fast wheel look reversed.
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

// Picture width in world units (the rear tires are widest); pixelsPerWorldUnit is the race grid size.
export function normalCarPictureWidth(pixelsPerWorldUnit) {
  const rear = FORMULA_CAR.parts.find((part) => part.id === "rearTire");
  const tireWidth = rear.settings?.width ?? tire.defaults.width;
  const artWidth = 2 * (Math.abs(rear.at[1]) + tireWidth / 2);
  return artWidth / FORMULA_CAR.boxSize * DRAWN_CAR_DRAW_PIXELS / pixelsPerWorldUnit;
}
