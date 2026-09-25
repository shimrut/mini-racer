import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from './car-unlock-policy.js';

// Each car skin belongs to one ground. The file name says which:
// mr_dirt_*.webp is a dirt skin, mr_snow_*.webp a snow skin, and every other
// skin is a tarmac skin. A player picks one skin for each ground.

export const CAR_SKIN_GROUND_KEYS = Object.freeze(['tarmac', 'dirt', 'snow']);

const GROUND_FILE_PREFIXES = Object.freeze({
    dirt: 'mr_dirt_',
    snow: 'mr_snow_',
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
