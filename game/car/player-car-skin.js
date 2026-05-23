import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from './sprite.js';

export const PLAYER_CAR_SKIN_STORAGE_KEY = 'MiniRacerPlayerCarSkin';

function titleCaseUnderscored(s) {
    return s
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

function skinIdForAsset(assetName) {
    const m = /^assets\/cars\/mr_(.+)\.webp$/i.exec(assetName);
    if (m) return m[1].replace(/_/g, '-');
    return assetName.replace(/[^a-z0-9]+/gi, '-');
}

function skinLabelForAsset(assetName) {
    const m = /^assets\/cars\/mr_(.+)\.webp$/i.exec(assetName);
    if (!m) return 'Car';
    const rest = m[1];
    if (rest.toLowerCase().startsWith('mr_')) {
        return `MR ${titleCaseUnderscored(rest.slice(3))}`;
    }
    if (rest.toLowerCase().startsWith('cyber_')) {
        return `Cyber ${titleCaseUnderscored(rest.slice(6))}`;
    }
    if (rest.toLowerCase().startsWith('steam_')) {
        return `Steam ${titleCaseUnderscored(rest.slice(6))}`;
    }
    return titleCaseUnderscored(rest);
}

/** @typedef {'mr' | 'cyberpunk' | 'steampunk'} PlayerCarSkinSeriesId */

/** @param {string} assetName */
function skinSeriesIdForAsset(assetName) {
    const m = /^assets\/cars\/mr_(.+)\.webp$/i.exec(assetName);
    if (!m) return 'mr';
    const rest = m[1].toLowerCase();
    if (rest.startsWith('mr_')) return 'mr';
    if (rest.startsWith('cyber_')) return 'cyberpunk';
    if (rest.startsWith('steam_')) return 'steampunk';
    return 'mr';
}

/** Garage UI section order and headings. */
export const PLAYER_CAR_SKIN_SECTION_META = Object.freeze([
    Object.freeze({ id: 'mr', title: 'MR cars' }),
    Object.freeze({ id: 'cyberpunk', title: 'Cyberpunk cars' }),
    Object.freeze({ id: 'steampunk', title: 'Steampunk cars' })
]);

/** Player-selectable skins (flat list; order matches ship list). */
export const PLAYER_CAR_SKINS = Object.freeze(
    PLAYER_SELECTABLE_CAR_ASSETS.map((assetName) =>
        Object.freeze({
            id: skinIdForAsset(assetName),
            label: skinLabelForAsset(assetName),
            /** @type {PlayerCarSkinSeriesId} */
            series: skinSeriesIdForAsset(assetName),
            assetName
        })
    )
);

function buildPlayerCarSkinSections() {
    const byId = new Map(PLAYER_CAR_SKIN_SECTION_META.map((m) => [m.id, []]));
    for (const skin of PLAYER_CAR_SKINS) {
        const bucket = byId.get(skin.series) ?? byId.get('mr');
        bucket.push(skin);
    }
    return Object.freeze(
        PLAYER_CAR_SKIN_SECTION_META.map((meta) =>
            Object.freeze({
                ...meta,
                skins: Object.freeze([...(byId.get(meta.id) ?? [])])
            })
        ).filter((sec) => sec.skins.length > 0)
    );
}

/** Skins grouped for garage display (subsections). */
export const PLAYER_CAR_SKIN_SECTIONS = buildPlayerCarSkinSections();

const ALLOWED = new Set(PLAYER_CAR_SKINS.map((s) => s.assetName));

export function readPlayerCarSkinAssetName() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return STOCK_CAR_ASSET_NAME;
    }
    try {
        const raw = window.localStorage.getItem(PLAYER_CAR_SKIN_STORAGE_KEY);
        if (!raw) return STOCK_CAR_ASSET_NAME;
        const parsed = JSON.parse(raw);
        const name = typeof parsed === 'string' ? parsed.trim() : '';
        if (name && ALLOWED.has(name)) return name;
    } catch (error) {
        console.error('Error reading player car skin:', error);
    }
    return STOCK_CAR_ASSET_NAME;
}

export function writePlayerCarSkinAssetName(assetName) {
    const next = ALLOWED.has(assetName) ? assetName : STOCK_CAR_ASSET_NAME;
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            window.localStorage.setItem(PLAYER_CAR_SKIN_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
            console.error('Error saving player car skin:', error);
        }
    }
    return next;
}
