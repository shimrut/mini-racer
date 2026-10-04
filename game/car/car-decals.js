import { DRAWN_CAR_ASSET_NAMES, DRAWN_CAR_SKINS, isDrawnCarAsset } from './drawn-car-skins.js';

// Existing skins supply paired body and wing maps for the same model. A
// style changes those maps without changing the skin's colors or identity.
export function getCarDecalStyleOptions(assetName) {
    if (!isDrawnCarAsset(assetName)) return [];
    const { car } = DRAWN_CAR_SKINS[assetName];
    return DRAWN_CAR_ASSET_NAMES.filter((name) => DRAWN_CAR_SKINS[name].car === car)
        .map((name) => ({ id: name, label: DRAWN_CAR_SKINS[name].label }));
}

export function normalizeCarDecalStyle(assetName, id) {
    if (!isDrawnCarAsset(assetName) || typeof id !== 'string') return null;
    const style = id.trim();
    if (!isDrawnCarAsset(style) || DRAWN_CAR_SKINS[style].car !== DRAWN_CAR_SKINS[assetName].car) return null;
    return style;
}

// Bound profile keys to drawn skins and choices to their compatible model.
// An explicit original style remains a choice, including during guest Merge.
export function normalizeCarDecals(value) {
    const decals = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return decals;
    for (const assetName of DRAWN_CAR_ASSET_NAMES) {
        if (!Object.hasOwn(value, assetName)) continue;
        const style = normalizeCarDecalStyle(assetName, value[assetName]);
        if (style) decals[assetName] = style;
    }
    return decals;
}
