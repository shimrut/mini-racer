// A ground scales the car's driving settings for a track; the game and the replay check both read it.
// The numbers are race rules: never change them once a track on that ground is live. Tarmac is exactly 1.
// steerGripScale: grip while steering; highSpeedSteerTrim: less turn at top speed (more pushes wide).
// yawCarry (0 to 1, turn kept after release) and slideScrub (speed lost per second sliding) are values; 0 is off.

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
    skidMarkMinSlipRatio: 0.28
});

export const TRACK_GROUNDS = Object.freeze({
    tarmac: TARMAC,
    dirt: Object.freeze({
        key: 'dirt',
        label: 'Dirt',
        accel: 0.7,
        maxSpeed: 0.87,
        grip: 0.61,
        steerGripScale: 0.82,
        turnRate: 0.78,
        angularResponse: 0.6,
        highSpeedSteerTrim: 1.0,
        yawCarry: 0.05,
        slideScrub: 0,
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
        skidMarkMinSlipRatio: 0.5
    }),
    // Grip: almost no slide, so turning starts and stops slower to keep the line and camera calm; turns cost speed.
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
        skidMarkMinSlipRatio: 0.28
    }),
    // Water (jet ski): wide slides, slow turn-in with carry, speed lost sliding; about 23% slower than tarmac.
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
        skidMarkMinSlipRatio: 0.45
    }),
    // Space (spaceship): fastest, quick nose, very wide slides without speed loss; laps about tarmac time.
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
