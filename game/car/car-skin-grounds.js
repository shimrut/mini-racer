import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from './car-unlock-policy.js';
import { isDrawnCarAsset } from './drawn-car-skins.js';

// A skin's ground comes from its name (mr_grip_, mr_dirt_, mr_snow_, mr_water_, mr_space_); others are tarmac.

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

// The default skin on a ground, or null when the ground has no skins.
export function getDefaultCarAssetForGround(ground) {
    const key = normalizeCarSkinGround(ground);
    if (key === 'tarmac') return STOCK_CAR_ASSET_NAME;
    return getCarAssetsForGround(key)[0] ?? null;
}

// Authoring previews use the ground's first drawn preset; the player's default stays.
export function getDefaultDrawnCarAssetForGround(ground) {
    return getCarAssetsForGround(ground).find(isDrawnCarAsset) ?? null;
}
