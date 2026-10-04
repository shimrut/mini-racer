// The grounds that the Daily can use, and whose cars the Legacy Garage tab
// lists. A Daily track on any other ground stays hidden until its ground is
// added here. Campaign series do not use this list: a series is live when the
// Creator makes it live. The Mapmaker still shows every ground.
// This file has no imports, so the Mapmaker server can use it.
// Snow, water and space are held back for now: add one here to show it.
export const LIVE_GROUND_KEYS = Object.freeze(['tarmac', 'dirt', 'grip']);

// A missing ground is tarmac.
export function isLiveGround(ground) {
    return LIVE_GROUND_KEYS.includes(ground ?? 'tarmac');
}
