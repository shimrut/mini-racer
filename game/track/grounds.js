// A ground scales the car's driving settings for a whole track. The game and
// the server replay check both read it, so a ground's numbers are part of the
// race rules: once a track with that ground is live, do not change them.
// Tarmac multiplies by exactly 1, which keeps tarmac times bit-identical.
//
// The driving settings:
//   accel            acceleration
//   maxSpeed         top speed
//   grip             side grip: less grip makes the car slide wider
//   steerGripScale   side grip while the player steers
//   turnRate         how fast the car turns at full steering
//   angularResponse  how quickly the car starts and stops turning
//   highSpeedSteerTrim  how much less the car turns at top speed: more
//                    makes the front push wide
// These three are values, not multipliers. Tarmac has 0, which turns them off:
//   yawCarry         0 to 1: how much the car keeps turning after the
//                    player lets go
//   slideScrub       the forward speed that a slide takes, each second
//   slideCarry       0 to 1: how much of the sideways speed the car keeps
//                    as forward speed when the tyres grip again

export const DEFAULT_TRACK_GROUND_KEY = 'tarmac';

const TARMAC = Object.freeze({
    key: 'tarmac',
    label: 'Street',
    accel: 1,
    maxSpeed: 1,
    grip: 1,
    steerGripScale: 1,
    turnRate: 1,
    angularResponse: 1,
    highSpeedSteerTrim: 1,
    yawCarry: 0,
    slideScrub: 0,
    slideCarry: 0,
    skidMarkMinSlipRatio: 0.28
});

export const TRACK_GROUNDS = Object.freeze({
    tarmac: TARMAC,
    dirt: Object.freeze({
        key: 'dirt',
        label: 'Dirt',
        accel: 0.7,
        maxSpeed: 0.87,
        grip: 0.6,
        steerGripScale: 0.85,
        turnRate: 0.78,
        angularResponse: 0.6,
        highSpeedSteerTrim: 1.0,
        yawCarry: 0.1,
        slideScrub: 0,
        slideCarry: 0.7,
        skidMarkMinSlipRatio: 0.4
    }),
    snow: Object.freeze({
        key: 'snow',
        label: 'Snow',
        accel: 0.65,
        maxSpeed: 0.85,
        grip: 0.4,
        steerGripScale: 1,
        turnRate: 0.7,
        angularResponse: 0.6,
        highSpeedSteerTrim: 1.4,
        yawCarry: 0,
        slideScrub: 0,
        slideCarry: 0,
        skidMarkMinSlipRatio: 0.5
    }),
    // A race-circuit road: the car holds its line and almost never slides.
    // On tarmac, the slide makes the car's line change smoothly. With no
    // slide, the car starts and stops turning more slowly, so its line and
    // the camera stay as calm as on tarmac. A turn takes some speed, as the
    // slide does on tarmac, so a long turn does not go much wider.
    // It has its own car sound and its own cars.
    grip: Object.freeze({
        key: 'grip',
        label: 'Track',
        accel: 1.02,
        maxSpeed: 1.14,
        grip: 2,
        steerGripScale: 1,
        turnRate: 0.9,
        angularResponse: 0.5,
        highSpeedSteerTrim: 0.9,
        yawCarry: 0,
        slideScrub: 3,
        slideCarry: 0,
        skidMarkMinSlipRatio: 0.28
    }),
    // Open water: the jet ski is driven, not a car. The hull slides wide in
    // a turn, like on snow. The nose starts to turn slowly, and the jet ski
    // keeps turning a little after the player lets go. The water takes some speed
    // in a slide. A water lap is about 23% slower than tarmac, as on dirt.
    water: Object.freeze({
        key: 'water',
        label: 'Water',
        accel: 0.75,
        maxSpeed: 0.9,
        grip: 0.6,
        steerGripScale: 0.8,
        turnRate: 0.85,
        angularResponse: 0.55,
        highSpeedSteerTrim: 1,
        yawCarry: 0.25,
        slideScrub: 0.4,
        slideCarry: 0,
        skidMarkMinSlipRatio: 0.45
    }),
    // A space lane: the spaceship is driven, not a car. It speeds up
    // fastest and has the highest top speed. The nose turns quickly, but
    // the ship keeps its line and slides very wide, with no loss of speed.
    // A space lap takes about the same time as tarmac.
    space: Object.freeze({
        key: 'space',
        label: 'Space',
        accel: 1.15,
        maxSpeed: 1.08,
        grip: 0.55,
        steerGripScale: 1,
        turnRate: 1.05,
        angularResponse: 1.15,
        highSpeedSteerTrim: 1,
        yawCarry: 0,
        slideScrub: 0,
        slideCarry: 0,
        skidMarkMinSlipRatio: 0.45
    })
});

export const TRACK_GROUND_KEYS = Object.freeze(Object.keys(TRACK_GROUNDS));

export function isTrackGroundKey(value) {
    return typeof value === 'string' && Object.hasOwn(TRACK_GROUNDS, value);
}

// Unknown or missing names drive as tarmac on both the game and the server.
export function getTrackGround(track) {
    const key = track?.ground;
    return isTrackGroundKey(key) ? TRACK_GROUNDS[key] : TARMAC;
}

// The top speed the speed bar and engine sound treat as full on this track.
export function getTrackGroundMaxSpeedKph(baseMaxSpeedKph, track) {
    const base = Number(baseMaxSpeedKph);
    if (!Number.isFinite(base)) return baseMaxSpeedKph;
    return base * getTrackGround(track).maxSpeed;
}

// The ground key a track stores, or null for tarmac.
export function getStoredTrackGroundKey(track) {
    const { key } = getTrackGround(track);
    return key === DEFAULT_TRACK_GROUND_KEY ? null : key;
}
