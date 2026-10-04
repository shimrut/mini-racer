import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from './car-unlock-policy.js';
import { isDrawnCarAsset } from './drawn-car-skins.js';

// Each car skin belongs to one ground. The file name says which:
// mr_grip_* is a circuit skin, mr_dirt_*.webp a dirt skin, mr_snow_*.webp a
// snow skin, mr_water_* a jet ski and mr_space_* a spaceship. Every other
// skin is a tarmac skin. A player picks one skin for each ground.

export const CAR_SKIN_GROUND_KEYS = Object.freeze(['tarmac', 'grip', 'dirt', 'snow', 'water', 'space']);

const GROUND_FILE_PREFIXES = Object.freeze({
    grip: 'mr_grip_',
    dirt: 'mr_dirt_',
    snow: 'mr_snow_',
    water: 'mr_water_',
    space: 'mr_space_',
});

export function getCarAssetGround(assetName) {
    const fileName = String(assetName ?? '').split('/').pop().toLowerCase();
    for (const [ground, prefix] of Object.entries(GROUND_FILE_PREFIXES)) {
        if (fileName.startsWith(prefix)) return ground;
    }
    return 'tarmac';
}

export function normalizeCarSkinGround(ground) {
    return CAR_SKIN_GROUND_KEYS.includes(ground) ? ground : 'tarmac';
}

export function getCarAssetsForGround(ground) {
    const key = normalizeCarSkinGround(ground);
    return PLAYER_SELECTABLE_CAR_ASSETS.filter(
        (assetName) => getCarAssetGround(assetName) === key,
    );
}

// The skin a player gets on a ground before they pick one, or null when the
// ground has no skins yet.
export function getDefaultCarAssetForGround(ground) {
    const key = normalizeCarSkinGround(ground);
    if (key === 'tarmac') return STOCK_CAR_ASSET_NAME;
    return getCarAssetsForGround(key)[0] ?? null;
}

// Authoring previews use the first full drawn preset for the ground, including
// Formula on tarmac, without changing the player's stock/Legacy default.
export function getDefaultDrawnCarAssetForGround(ground) {
    return getCarAssetsForGround(ground).find(isDrawnCarAsset) ?? null;
}
