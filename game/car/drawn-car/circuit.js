import { FORMULA_CAR } from "./formula.js";

// The Circuit car: the Formula car with a larger rear wing, tall end plates and wider rear tires.

// Wider tires keep the Formula inner edge, so the arms still meet them.
const REAR_TIRE = { length: 18.6, width: 14, sideWidth: 0.24 };
const REAR_TIRE_AT = [-29.8, -18.2 - REAR_TIRE.width / 2];

// The end plates stand mostly behind the wider wing, clear of the rear tires.
const REAR_WING = {
  from: -51.2,
  width: 48,
  flapX: -47,
  flapWidth: 24,
  endLength: 4.2,
  endFront: 0.4,
  endBack: 2.4,
};
// The brake light moves back with the wing, so the wing does not cover it.
const BRAKE_LIGHT = { from: -54.5, to: -48.6 };

// The Formula parts with these changes.
const CHANGES = {
  rearTire: { at: REAR_TIRE_AT, settings: REAR_TIRE },
  rearHub: { at: REAR_TIRE_AT, settings: REAR_TIRE },
  brakeLight: { settings: BRAKE_LIGHT },
  rearWing: { settings: REAR_WING },
};

export const CIRCUIT_CAR = {
  ...FORMULA_CAR,

  decals: {
    ...FORMULA_CAR.decals,
    rearWingEnds: "accent",
  },

  parts: FORMULA_CAR.parts.map((item) => ({ ...item, ...(CHANGES[item.id] || {}) })),
};
