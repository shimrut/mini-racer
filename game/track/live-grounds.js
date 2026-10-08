// Grounds the Daily and the Legacy Garage tab use (not Campaign; the Mapmaker shows all). No imports.
// Snow, water and space are held back; add one here to show it.
export const LIVE_GROUND_KEYS = Object.freeze(['tarmac', 'dirt', 'grip']);

// A missing ground is tarmac.
export function isLiveGround(ground) {
    return LIVE_GROUND_KEYS.includes(ground ?? 'tarmac');
}
