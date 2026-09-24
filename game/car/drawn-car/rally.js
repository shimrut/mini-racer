import { FORMULA_CAR } from "./formula.js";
import { airScoop } from "./parts/air-scoop.js";
import { hub } from "./parts/hub.js";
import { knobbyTire } from "./parts/knobby-tire.js";
import { lightPod } from "./parts/light-pod.js";
import { louvers } from "./parts/louvers.js";
import { mud } from "./parts/mud.js";
import { mudFlap } from "./parts/mud-flap.js";

// The Rally car: the Formula car made for dirt roads. It has wider knobby
// tires, mud flaps, a light pod on the nose, an air scoop behind the cockpit,
// vent slots on the side pods and mud on the body. formula.js tells how a
// car file works.

const REAR_TIRE = { length: 18.4, width: 12.6 };
const FRONT_TIRE = { length: 17.6, width: 11.2 };

// The wider tires keep their inner edges where the Formula tires have them,
// so the arms still meet them.
const REAR_TIRE_Y = -18.2 - REAR_TIRE.width / 2;
const FRONT_TIRE_Y = -17.05 - FRONT_TIRE.width / 2;

const formulaPart = (id) => FORMULA_CAR.parts.find((part) => part.id === id);

export const RALLY_CAR = {
  ...FORMULA_CAR,

  livery: {
    main: "#e0161e",
    accent: "#ffffff",
    tertiary: "#ffcf1f",
  },

  decals: {
    ...FORMULA_CAR.decals,
    centerStripe: "accent",
    noseStripe: null,
    rearWingFlap: "accent",
    rearWingEnds: "tertiary",
    frontWingTips: "tertiary",
    scoop: "main",
  },

  colors: {
    ...FORMULA_CAR.colors,
    frame: "#34312d",
    frameLight: "#4d4943",
    tire: "#27231f",
    tireFace: "#5a534a",
    tireSide: "#6d665c",
    tireLine: "#120f0c",
    flap: "#1d1c1a",
    lamp: "#ffd84a",
    lampShine: "#fffbe0",
    mud: "#5a3f26",
    mudLight: "#8a6a45",
  },

  parts: [
    formulaPart("rearArmFront"),
    formulaPart("rearArmBack"),
    formulaPart("rearArmBar"),
    formulaPart("frontArmBack"),
    formulaPart("frontArmFront"),

    { id: "mudFlap", part: mudFlap, mirror: true },
    { id: "rearTire", part: knobbyTire, at: [-29.8, REAR_TIRE_Y], settings: REAR_TIRE, mirror: true },
    {
      id: "frontTire",
      part: knobbyTire,
      at: [26.8, FRONT_TIRE_Y],
      settings: FRONT_TIRE,
      mirror: true,
      steers: true,
    },
    { id: "rearHub", part: hub, at: [-29.8, REAR_TIRE_Y], settings: { ...REAR_TIRE, sideWidth: 0.26 }, mirror: true },
    {
      id: "frontHub",
      part: hub,
      at: [26.8, FRONT_TIRE_Y],
      settings: { ...FRONT_TIRE, sideWidth: 0.26 },
      mirror: true,
      steers: true,
    },

    formulaPart("gearbox"),
    formulaPart("brakeLight"),
    formulaPart("rearWing"),
    formulaPart("frontWing"),
    formulaPart("body"),
    { id: "louvers", part: louvers, mirror: true },
    formulaPart("sideIntake"),
    { id: "airScoop", part: airScoop },
    formulaPart("cockpit"),
    formulaPart("noseStripe"),
    { id: "lightPod", part: lightPod },
    { id: "mud", part: mud },
  ],
};
