import { RALLY_CAR } from "./rally.js";
import { mud } from "./parts/mud.js";

// The Snow car: the Rally car with studded tires, a four-lamp pod, and snow and frost in place of mud.

// Snow clumps on the side pods, engine cover, wings and nose.
const SNOW = {
  seed: 3,
  zones: [
    { x: [-20, 8], y: [-19, -12], count: 6, size: [1.2, 2.2] },
    { x: [-34, -22], y: [-9, -3], count: 2, size: [1, 1.8] },
    { x: [-49, -41], y: [-17, -4], count: 4, size: [1, 1.9] },
    { x: [12, 32], y: [-7, -3], count: 3, size: [0.8, 1.4] },
    { x: [37, 46], y: [-18, -7], count: 3, size: [0.8, 1.5] },
  ],
  lumps: 3,
  drops: [0, 1],
  opacity: [0.85, 1],
  dust: 0.35,
  dustTo: -8,
};

export const SNOW_CAR = {
  ...RALLY_CAR,

  livery: {
    main: "#e9f1f7",
    accent: "#1e88e5",
    tertiary: "#ff6d00",
  },

  decals: {
    ...RALLY_CAR.decals,
    centerStripe: "accent",
    sidePodStripes: "tertiary",
    noseTip: "accent",
    rearWingFlap: "accent",
    rearWingEnds: "tertiary",
    frontWingTips: "tertiary",
  },

  colors: {
    ...RALLY_CAR.colors,
    tire: "#212428",
    tireFace: "#4a5057",
    tireSide: "#6a727a",
    // The gaps between the blocks are packed with snow.
    tireLine: "#7f8e9b",
    stud: "#eef3f7",
    lamp: "#fff3c4",
    // Snow: a blue-white clump with a white top.
    mud: "#dce8f2",
    mudLight: "#ffffff",
  },

  // Rally parts with studded tires, a wider light pod and snow.
  parts: RALLY_CAR.parts.map((part) => {
    if (part.id === "rearTire" || part.id === "frontTire") {
      return { ...part, settings: { ...part.settings, studs: true } };
    }
    if (part.id === "lightPod") {
      return { ...part, settings: { lamps: 4, width: 16, lampRadius: 1.55 } };
    }
    if (part.id === "mud") return { id: "snow", part: mud, settings: SNOW };
    return part;
  }),
};
