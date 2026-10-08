import { DRAWN_CAR_ASSET_NAMES, DRAWN_CAR_SKINS, isDrawnCarAsset } from './drawn-car-skins.js';

// A decal style swaps a skin's body and wing maps; colors and skin identity stay.
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

// Keys must be drawn skins and choices must fit the model; an explicit original style is a choice.
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
