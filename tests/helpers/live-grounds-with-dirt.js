// A fixed live-ground list with Street and Dirt. The tests of the series code
// mock the live grounds with this list, so they do not change when the game's
// list changes. Use it as:
// vi.mock('../game/track/live-grounds.js', () => import('./helpers/live-grounds-with-dirt.js'));
export const LIVE_GROUND_KEYS = Object.freeze(['tarmac', 'dirt']);

export function isLiveGround(ground) {
    return LIVE_GROUND_KEYS.includes(ground ?? 'tarmac');
}
