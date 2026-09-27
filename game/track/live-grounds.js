// The grounds that players can see. A Campaign series, a garage car or a Daily
// track on any other ground stays hidden until its ground is added here. The
// Mapmaker still shows every ground.
// This file has no imports, so the Mapmaker server can use it.
export const LIVE_GROUND_KEYS = Object.freeze(['tarmac', 'dirt']);

// A missing ground is tarmac.
export function isLiveGround(ground) {
    return LIVE_GROUND_KEYS.includes(ground ?? 'tarmac');
}
