// A fixed Street and Dirt live-ground list, so series tests do not follow the game's list. Use:
// vi.mock('../game/track/live-grounds.js', () => import('./helpers/live-grounds-with-dirt.js'));
export const LIVE_GROUND_KEYS = Object.freeze(['tarmac', 'dirt']);

export function isLiveGround(ground) {
    return LIVE_GROUND_KEYS.includes(ground ?? 'tarmac');
}
