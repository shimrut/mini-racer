import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from './sprite.js';
import {
    CAR_UNLOCK_REQUIREMENTS,
    DEFAULT_CAR_UNLOCK_SNAPSHOT,
    formatCarUnlockRequirement,
    getCarUnlockRequirementProgress,
    isCarAssetUnlocked,
    normalizeCarUnlockSnapshot,
} from './car-unlock-policy.js';

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
        return titleCaseUnderscored(rest.slice(3));
    }
    if (rest.toLowerCase().startsWith('cyber_')) {
        return titleCaseUnderscored(rest.slice(6));
    }
    if (rest.toLowerCase().startsWith('steam_')) {
        return titleCaseUnderscored(rest.slice(6));
    }
    if (rest.toLowerCase().startsWith('extra_')) {
        return titleCaseUnderscored(rest.slice(6));
    }
    return titleCaseUnderscored(rest);
}

/** @typedef {'mini' | 'cyberpunk' | 'steampunk' | 'extra'} PlayerCarSkinSeriesId */

/** @param {string} assetName */
function skinSeriesIdForAsset(assetName) {
    const m = /^assets\/cars\/mr_(.+)\.webp$/i.exec(assetName);
    if (!m) return 'mini';
    const rest = m[1].toLowerCase();
    if (rest.startsWith('mr_')) return 'mini';
    if (rest.startsWith('cyber_')) return 'cyberpunk';
    if (rest.startsWith('steam_')) return 'steampunk';
    if (rest.startsWith('extra_')) return 'extra';
    return 'mini';
}

/** Garage UI section order and headings. */
export const PLAYER_CAR_SKIN_SECTION_META = Object.freeze([
    Object.freeze({ id: 'extra', title: 'Extra cars' }),
    Object.freeze({ id: 'mini', title: 'Mini cars' }),
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
            assetName,
            unlockRequirement: CAR_UNLOCK_REQUIREMENTS[assetName] ?? null,
        })
    )
);

function buildPlayerCarSkinSections() {
    const byId = new Map(PLAYER_CAR_SKIN_SECTION_META.map((m) => [m.id, []]));
    for (const skin of PLAYER_CAR_SKINS) {
        const bucket = byId.get(skin.series) ?? byId.get('mini');
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
let currentCarUnlockSnapshot = DEFAULT_CAR_UNLOCK_SNAPSHOT;

function readStoredPlayerCarSkinAssetName() {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
        const raw = window.localStorage.getItem(PLAYER_CAR_SKIN_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
    } catch (error) {
        console.error('Error reading player car skin:', error);
        return null;
    }
}

function writeStoredPlayerCarSkinAssetName(assetName) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.setItem(PLAYER_CAR_SKIN_STORAGE_KEY, JSON.stringify(assetName));
    } catch (error) {
        console.error('Error saving player car skin:', error);
    }
}

export function getPlayerCarUnlockSnapshot() {
    return currentCarUnlockSnapshot;
}

export function setPlayerCarUnlockSnapshot(snapshot) {
    currentCarUnlockSnapshot = normalizeCarUnlockSnapshot(snapshot);
    const current = readStoredPlayerCarSkinAssetName();
    if (current && !isCarAssetUnlocked(current, currentCarUnlockSnapshot)) {
        writeStoredPlayerCarSkinAssetName(STOCK_CAR_ASSET_NAME);
    }
    return currentCarUnlockSnapshot;
}

export function isPlayerCarSkinUnlocked(assetName) {
    return isCarAssetUnlocked(assetName, currentCarUnlockSnapshot);
}

export function getPlayerCarSkinUnlockLabel(assetName) {
    return formatCarUnlockRequirement(assetName, currentCarUnlockSnapshot);
}

export function getPlayerCarSkinUnlockProgress(assetName) {
    return getCarUnlockRequirementProgress(assetName, currentCarUnlockSnapshot);
}

export function readPlayerCarSkinAssetName() {
    const name = readStoredPlayerCarSkinAssetName();
    if (name && ALLOWED.has(name) && isPlayerCarSkinUnlocked(name)) return name;
    return STOCK_CAR_ASSET_NAME;
}

export function writePlayerCarSkinAssetName(assetName) {
    const next = ALLOWED.has(assetName) && isPlayerCarSkinUnlocked(assetName)
        ? assetName
        : STOCK_CAR_ASSET_NAME;
    writeStoredPlayerCarSkinAssetName(next);
    return next;
}
