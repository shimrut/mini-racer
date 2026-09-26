// Garage skins that game/car/drawn-car.js draws in code. They have no image
// file. The key is the skin name that the garage, the unlock rules and the
// server keep for the player. A name whose last part starts with mr_grip_,
// mr_dirt_, mr_snow_, mr_water_ or mr_space_ is a skin for that ground, as
// for the image skins.
//
// To make a skin, add an entry:
//   label   the name in the garage
//   series  the garage section, such as "formula"
//   car     the car file in game/car/drawn-car/: "formula", "circuit",
//           "rally", "snow", "jetski" or "spaceship"
//   livery  the main, accent and tertiary colors
//   decals  the paint of each area: "main", "accent", "tertiary", a color
//           such as "#ffffff", or null for no paint
//   colors  optional: new material colors, such as the rally lamps
//   parts   optional: changes to one part, such as a new mud pattern
// An area that the skin does not name keeps the paint of the car file.
//
// The decal areas of the Formula car:
//   body, centerStripe, sidePodStripes, noseTip, noseStripe, cockpitRim,
//   intakes, rearWing, rearWingFlap, rearWingEnds, frontWing,
//   frontWingTips, frontWingEdge
// The Circuit car has the same areas.
// The Rally and Snow cars have the same areas, and also:
//   scoop
// The Jet Ski has other areas:
//   hull, hullStripes, hoodStripe, noseTip, seat, mirrors, barPad, helmet,
//   vest
// The Spaceship has the areas of the Formula car body, cockpit and front
// wing, and also:
//   wings, wingTips, wingStripes, pods, podRing
//
// For example, a blue car with orange wing ends and green side stripes:
//   'drawn/formula-blue': {
//       label: 'Blue', series: 'formula', car: 'formula',
//       livery: { main: '#1f4fe0', accent: '#ff6a00', tertiary: '#b6ff3a' },
//       decals: { rearWingEnds: 'accent', frontWingTips: 'accent', sidePodStripes: 'tertiary' },
//   },
//
// This file holds only data, because the server reads the skin names.

export const DRAWN_CAR_SKINS = Object.freeze({
    'drawn/formula-red': Object.freeze({
        label: 'Red',
        series: 'formula',
        car: 'formula',
    }),
    'drawn/formula-gold': Object.freeze({
        label: 'Gold',
        series: 'formula',
        car: 'formula',
        livery: Object.freeze({ main: '#f6b40e', accent: '#ff6a00', tertiary: '#fff1b8' }),
        decals: Object.freeze({
            rearWingFlap: 'accent',
            frontWingTips: 'accent',
            frontWingEdge: 'accent',
            noseStripe: 'tertiary',
        }),
    }),
    'drawn/formula-lime': Object.freeze({
        label: 'Lime',
        series: 'formula',
        car: 'formula',
        livery: Object.freeze({ main: '#3cc43c', accent: '#ffffff', tertiary: '#1b5e20' }),
        decals: Object.freeze({
            centerStripe: 'accent',
            rearWingFlap: 'accent',
            frontWingEdge: 'tertiary',
            noseStripe: null,
        }),
    }),
    'drawn/formula-arctic': Object.freeze({
        label: 'Arctic',
        series: 'formula',
        car: 'formula',
        livery: Object.freeze({ main: '#eef3f8', accent: '#1e90ff', tertiary: '#0d2b55' }),
        decals: Object.freeze({
            centerStripe: 'accent',
            noseTip: 'accent',
            noseStripe: null,
            rearWingEnds: 'tertiary',
            frontWingTips: 'tertiary',
        }),
    }),
    // Circuit skins: players drive them on circuit tracks. The end plates of
    // the rear wing take paint, so each skin shows its wing from far away.
    'drawn/mr_grip_circuit': Object.freeze({
        label: 'Red',
        series: 'grip',
        car: 'circuit',
    }),
    'drawn/mr_grip_circuit-silver': Object.freeze({
        label: 'Silver',
        series: 'grip',
        car: 'circuit',
        livery: Object.freeze({ main: '#c3ccd4', accent: '#00a19b', tertiary: '#1b1f24' }),
        decals: Object.freeze({ noseStripe: 'accent', rearWingEnds: 'tertiary', frontWingTips: 'accent' }),
    }),
    'drawn/mr_grip_circuit-blue': Object.freeze({
        label: 'Blue',
        series: 'grip',
        car: 'circuit',
        livery: Object.freeze({ main: '#1f3f9e', accent: '#ffcc00', tertiary: '#e0161e' }),
        decals: Object.freeze({ noseTip: 'accent', noseStripe: 'tertiary', rearWingEnds: 'accent' }),
    }),
    'drawn/mr_grip_circuit-orange': Object.freeze({
        label: 'Orange',
        series: 'grip',
        car: 'circuit',
        livery: Object.freeze({ main: '#ff7a00', accent: '#1b1f24', tertiary: '#3fa9ff' }),
        decals: Object.freeze({ noseStripe: 'tertiary', rearWingEnds: 'accent', frontWingTips: 'accent' }),
    }),
    'drawn/mr_grip_circuit-black': Object.freeze({
        label: 'Black',
        series: 'grip',
        car: 'circuit',
        livery: Object.freeze({ main: '#1c1e22', accent: '#d9a520', tertiary: '#ffffff' }),
        decals: Object.freeze({ sidePodStripes: 'accent', noseStripe: 'accent', rearWingEnds: 'accent' }),
    }),
    // Dirt skins: players drive them on dirt tracks. Each rally skin has its
    // own mud pattern, so no two look the same.
    'drawn/mr_dirt_rally': Object.freeze({
        label: 'Red',
        series: 'dirt',
        car: 'rally',
    }),
    'drawn/mr_dirt_rally-blue': Object.freeze({
        label: 'Blue',
        series: 'dirt',
        car: 'rally',
        livery: Object.freeze({ main: '#1d4fb8', accent: '#ffd21f', tertiary: '#ffffff' }),
        decals: Object.freeze({
            centerStripe: null,
            sidePodStripes: 'accent',
            noseTip: 'accent',
            rearWingFlap: 'accent',
            rearWingEnds: 'tertiary',
            frontWingTips: 'accent',
        }),
        parts: Object.freeze({ mud: Object.freeze({ settings: Object.freeze({ seed: 11 }) }) }),
    }),
    'drawn/mr_dirt_rally-white': Object.freeze({
        label: 'White',
        series: 'dirt',
        car: 'rally',
        livery: Object.freeze({ main: '#f1f1ec', accent: '#1b3f8f', tertiary: '#e0161e' }),
        decals: Object.freeze({
            centerStripe: 'accent',
            sidePodStripes: 'tertiary',
            noseTip: 'accent',
            rearWingFlap: 'tertiary',
            rearWingEnds: 'accent',
            frontWingTips: 'tertiary',
        }),
        parts: Object.freeze({ mud: Object.freeze({ settings: Object.freeze({ seed: 23 }) }) }),
    }),
    'drawn/mr_dirt_rally-green': Object.freeze({
        label: 'Green',
        series: 'dirt',
        car: 'rally',
        livery: Object.freeze({ main: '#2f6b2f', accent: '#ff7a1a', tertiary: '#f2efe6' }),
        decals: Object.freeze({
            centerStripe: null,
            sidePodStripes: 'accent',
            noseTip: 'accent',
            rearWingFlap: 'tertiary',
            rearWingEnds: 'accent',
            frontWingTips: 'accent',
            scoop: 'tertiary',
        }),
        parts: Object.freeze({ mud: Object.freeze({ settings: Object.freeze({ seed: 5 }) }) }),
    }),
    'drawn/mr_dirt_rally-black': Object.freeze({
        label: 'Black',
        series: 'dirt',
        car: 'rally',
        livery: Object.freeze({ main: '#1f2024', accent: '#ffcf1f', tertiary: '#e0161e' }),
        decals: Object.freeze({
            centerStripe: 'accent',
            sidePodStripes: 'tertiary',
            rearWingFlap: null,
            rearWingEnds: 'accent',
            frontWingTips: 'accent',
        }),
        colors: Object.freeze({ lamp: '#f4f7ff', lampShine: '#ffffff' }),
        parts: Object.freeze({ mud: Object.freeze({ settings: Object.freeze({ seed: 41 }) }) }),
    }),
    // Snow skins: players drive them on snow tracks. Each has its own snow
    // pattern.
    'drawn/mr_snow_ice': Object.freeze({
        label: 'White',
        series: 'snow',
        car: 'snow',
    }),
    'drawn/mr_snow_ice-red': Object.freeze({
        label: 'Red',
        series: 'snow',
        car: 'snow',
        livery: Object.freeze({ main: '#c8102e', accent: '#ffffff', tertiary: '#9ad7ff' }),
        decals: Object.freeze({
            centerStripe: 'accent',
            sidePodStripes: 'tertiary',
            noseTip: 'accent',
            rearWingFlap: 'accent',
            rearWingEnds: 'tertiary',
            frontWingTips: 'accent',
        }),
        parts: Object.freeze({ snow: Object.freeze({ settings: Object.freeze({ seed: 13 }) }) }),
    }),
    'drawn/mr_snow_ice-black': Object.freeze({
        label: 'Black',
        series: 'snow',
        car: 'snow',
        livery: Object.freeze({ main: '#1c1e22', accent: '#35c7ff', tertiary: '#ffffff' }),
        decals: Object.freeze({
            centerStripe: null,
            sidePodStripes: 'accent',
            noseTip: 'accent',
            rearWingFlap: 'tertiary',
            rearWingEnds: 'accent',
            frontWingTips: 'accent',
            scoop: 'accent',
        }),
        colors: Object.freeze({ lamp: '#e8f6ff' }),
        parts: Object.freeze({ snow: Object.freeze({ settings: Object.freeze({ seed: 29 }) }) }),
    }),
    'drawn/mr_snow_ice-teal': Object.freeze({
        label: 'Teal',
        series: 'snow',
        car: 'snow',
        livery: Object.freeze({ main: '#0f8b8d', accent: '#f7f7f2', tertiary: '#ffb000' }),
        decals: Object.freeze({
            centerStripe: 'accent',
            sidePodStripes: null,
            noseTip: 'tertiary',
            rearWingFlap: 'tertiary',
            rearWingEnds: 'accent',
            frontWingTips: 'tertiary',
        }),
        parts: Object.freeze({ snow: Object.freeze({ settings: Object.freeze({ seed: 17 }) }) }),
    }),
    'drawn/mr_snow_ice-purple': Object.freeze({
        label: 'Purple',
        series: 'snow',
        car: 'snow',
        livery: Object.freeze({ main: '#5b2a86', accent: '#9ad7ff', tertiary: '#ffffff' }),
        decals: Object.freeze({
            centerStripe: 'tertiary',
            sidePodStripes: 'accent',
            noseTip: 'accent',
            rearWingFlap: 'accent',
            rearWingEnds: 'tertiary',
            frontWingTips: 'accent',
        }),
        parts: Object.freeze({ snow: Object.freeze({ settings: Object.freeze({ seed: 37 }) }) }),
    }),
    // Jet skis: players drive them on water tracks.
    'drawn/mr_water_jetski': Object.freeze({
        label: 'White',
        series: 'water',
        car: 'jetski',
    }),
    'drawn/mr_water_jetski-red': Object.freeze({
        label: 'Red',
        series: 'water',
        car: 'jetski',
        livery: Object.freeze({ main: '#d62828', accent: '#ffffff', tertiary: '#ffd23f' }),
        decals: Object.freeze({ noseTip: 'tertiary', helmet: 'tertiary', vest: '#1b1b1f' }),
    }),
    'drawn/mr_water_jetski-yellow': Object.freeze({
        label: 'Yellow',
        series: 'water',
        car: 'jetski',
        livery: Object.freeze({ main: '#ffc72c', accent: '#1b1b1f', tertiary: '#e0161e' }),
        decals: Object.freeze({ helmet: 'tertiary', vest: 'accent', barPad: 'accent' }),
    }),
    'drawn/mr_water_jetski-blue': Object.freeze({
        label: 'Blue',
        series: 'water',
        car: 'jetski',
        livery: Object.freeze({ main: '#1d4fb8', accent: '#ffffff', tertiary: '#ff7a1a' }),
        decals: Object.freeze({ noseTip: 'tertiary', helmet: 'accent', vest: 'tertiary' }),
    }),
    'drawn/mr_water_jetski-black': Object.freeze({
        label: 'Black',
        series: 'water',
        car: 'jetski',
        livery: Object.freeze({ main: '#1c1e22', accent: '#35c7ff', tertiary: '#ffffff' }),
        decals: Object.freeze({ hoodStripe: 'accent', noseTip: 'tertiary', helmet: 'tertiary', vest: 'accent' }),
    }),
    // Spaceships: players drive them on space tracks.
    'drawn/mr_space_ship': Object.freeze({
        label: 'White',
        series: 'space',
        car: 'spaceship',
    }),
    'drawn/mr_space_ship-red': Object.freeze({
        label: 'Red',
        series: 'space',
        car: 'spaceship',
        livery: Object.freeze({ main: '#d7263d', accent: '#ffd23f', tertiary: '#1b1b1f' }),
        decals: Object.freeze({ wingStripes: 'accent', podRing: 'accent', frontWingTips: 'tertiary', noseTip: 'tertiary' }),
    }),
    'drawn/mr_space_ship-black': Object.freeze({
        label: 'Black',
        series: 'space',
        car: 'spaceship',
        livery: Object.freeze({ main: '#1d1f27', accent: '#3de8ff', tertiary: '#ff4fd8' }),
        decals: Object.freeze({ cockpitRim: 'accent', pods: 'main' }),
    }),
    'drawn/mr_space_ship-gold': Object.freeze({
        label: 'Gold',
        series: 'space',
        car: 'spaceship',
        livery: Object.freeze({ main: '#f2b705', accent: '#1b1b1f', tertiary: '#ffffff' }),
        decals: Object.freeze({ wingTips: 'tertiary', wingStripes: 'accent', sidePodStripes: 'accent' }),
    }),
    'drawn/mr_space_ship-purple': Object.freeze({
        label: 'Purple',
        series: 'space',
        car: 'spaceship',
        livery: Object.freeze({ main: '#6a3fd1', accent: '#3de8ff', tertiary: '#ffffff' }),
        decals: Object.freeze({ noseTip: 'tertiary', wingStripes: 'tertiary', podRing: 'accent', pods: 'main' }),
    }),
});

export const DRAWN_CAR_ASSET_NAMES = Object.freeze(Object.keys(DRAWN_CAR_SKINS));

export function isDrawnCarAsset(assetName) {
    return typeof assetName === 'string' && Object.hasOwn(DRAWN_CAR_SKINS, assetName);
}
