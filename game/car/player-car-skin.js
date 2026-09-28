import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from './sprite.js';
import {
    DEFAULT_CAR_UNLOCK_SNAPSHOT,
    formatCarUnlockRequirement,
    getCarUnlockRequirementProgress,
    isCarAssetUnlocked,
    normalizeCarUnlockSnapshot,
} from './car-unlock-policy.js';
import {
    CAR_SKIN_GROUND_KEYS,
    getCarAssetGround,
    getDefaultCarAssetForGround,
    normalizeCarSkinGround,
} from './car-skin-grounds.js';
import { DRAWN_CAR_SKINS, isDrawnCarAsset } from './drawn-car-skins.js';
import { isLiveGround } from '../track/live-grounds.js';

export const PLAYER_CAR_SKIN_STORAGE_KEY = 'MiniRacerPlayerCarSkin';

// One stored choice for each ground. Tarmac keeps the original key.
const PLAYER_CAR_SKIN_STORAGE_KEYS = Object.freeze({
    tarmac: PLAYER_CAR_SKIN_STORAGE_KEY,
    grip: 'MiniRacerPlayerCarSkinGrip',
    dirt: 'MiniRacerPlayerCarSkinDirt',
    snow: 'MiniRacerPlayerCarSkinSnow',
    water: 'MiniRacerPlayerCarSkinWater',
    space: 'MiniRacerPlayerCarSkinSpace',
});

function titleCaseUnderscored(s) {
    return s
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

function skinIdForAsset(assetName) {
    if (isDrawnCarAsset(assetName)) return assetName.replace(/[^a-z0-9]+/gi, '-');
    const m = /^assets\/cars\/mr_(.+)\.webp$/i.exec(assetName);
    if (m) return m[1].replace(/_/g, '-');
    return assetName.replace(/[^a-z0-9]+/gi, '-');
}

function skinLabelForAsset(assetName) {
    if (isDrawnCarAsset(assetName)) return DRAWN_CAR_SKINS[assetName].label;
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
    if (rest.toLowerCase().startsWith('dirt_')) {
        return titleCaseUnderscored(rest.slice(5));
    }
    if (rest.toLowerCase().startsWith('snow_')) {
        return titleCaseUnderscored(rest.slice(5));
    }
    return titleCaseUnderscored(rest);
}

function skinSeriesIdForAsset(assetName) {
    if (isDrawnCarAsset(assetName)) return DRAWN_CAR_SKINS[assetName].series;
    const m = /^assets\/cars\/mr_(.+)\.webp$/i.exec(assetName);
    if (!m) return 'mini';
    const rest = m[1].toLowerCase();
    if (rest.startsWith('mr_')) return 'mini';
    if (rest.startsWith('cyber_')) return 'cyberpunk';
    if (rest.startsWith('steam_')) return 'steampunk';
    if (rest.startsWith('extra_')) return 'extra';
    if (rest.startsWith('dirt_')) return 'dirt';
    if (rest.startsWith('snow_')) return 'snow';
    return 'mini';
}

export const PLAYER_CAR_SKIN_SECTION_META = Object.freeze([
    Object.freeze({ id: 'formula', title: 'Formula cars' }),
    Object.freeze({ id: 'extra', title: 'Extra cars' }),
    Object.freeze({ id: 'mini', title: 'Mini cars' }),
    Object.freeze({ id: 'cyberpunk', title: 'Cyberpunk cars' }),
    Object.freeze({ id: 'steampunk', title: 'Steampunk cars' }),
    Object.freeze({ id: 'grip', title: 'Circuit cars' }),
    Object.freeze({ id: 'dirt', title: 'Dirt cars' }),
    Object.freeze({ id: 'snow', title: 'Snow cars' }),
    Object.freeze({ id: 'water', title: 'Jet skis' }),
    Object.freeze({ id: 'space', title: 'Spaceships' })
]);

export const PLAYER_CAR_SKINS = Object.freeze(
    PLAYER_SELECTABLE_CAR_ASSETS.map((assetName) =>
        Object.freeze({
            id: skinIdForAsset(assetName),
            label: skinLabelForAsset(assetName),
            series: skinSeriesIdForAsset(assetName),
            ground: getCarAssetGround(assetName),
            assetName,
        })
    )
);

// Garage sections that players do not see for now. Their cars stay valid.
// The Formula cars are held back: remove 'formula' to show them.
const HELD_BACK_SKIN_SECTION_IDS = Object.freeze(['formula']);

// The garage shows only the cars of live grounds, and not the held-back sections.
function buildPlayerCarSkinSections() {
    const byId = new Map(PLAYER_CAR_SKIN_SECTION_META.map((m) => [m.id, []]));
    for (const skin of PLAYER_CAR_SKINS) {
        if (!isLiveGround(skin.ground) || HELD_BACK_SKIN_SECTION_IDS.includes(skin.series)) continue;
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

export const PLAYER_CAR_SKIN_SECTIONS = buildPlayerCarSkinSections();

const ALLOWED = new Set(PLAYER_CAR_SKINS.map((s) => s.assetName));
let currentCarUnlockSnapshot = DEFAULT_CAR_UNLOCK_SNAPSHOT;

function readStoredPlayerCarSkinAssetName(ground = 'tarmac') {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
        const raw = window.localStorage.getItem(PLAYER_CAR_SKIN_STORAGE_KEYS[normalizeCarSkinGround(ground)]);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
    } catch (error) {
        console.error('Error reading player car skin:', error);
        return null;
    }
}

function writeStoredPlayerCarSkinAssetName(assetName, ground = 'tarmac') {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const key = PLAYER_CAR_SKIN_STORAGE_KEYS[normalizeCarSkinGround(ground)];
    try {
        if (assetName) {
            window.localStorage.setItem(key, JSON.stringify(assetName));
        } else {
            window.localStorage.removeItem(key);
        }
    } catch (error) {
        console.error('Error saving player car skin:', error);
    }
}

function isUsableGroundSkin(assetName, ground) {
    return Boolean(assetName)
        && ALLOWED.has(assetName)
        && getCarAssetGround(assetName) === ground
        && isPlayerCarSkinUnlocked(assetName);
}

export function setPlayerCarUnlockSnapshot(snapshot, { authoritative = true } = {}) {
    currentCarUnlockSnapshot = normalizeCarUnlockSnapshot(snapshot);
    if (!authoritative) return currentCarUnlockSnapshot;
    for (const ground of CAR_SKIN_GROUND_KEYS) {
        const current = readStoredPlayerCarSkinAssetName(ground);
        if (current && !isCarAssetUnlocked(current, currentCarUnlockSnapshot)) {
            writeStoredPlayerCarSkinAssetName(ground === 'tarmac' ? STOCK_CAR_ASSET_NAME : null, ground);
        }
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

// The skin the player picked for a ground, or null when they never picked one.
export function readPlayerGroundCarSkinChoice(ground) {
    const key = normalizeCarSkinGround(ground);
    const name = readStoredPlayerCarSkinAssetName(key);
    return isUsableGroundSkin(name, key) ? name : null;
}

// The skin the player drives on a ground: their pick, else the ground's
// default skin, else their tarmac skin when the ground has no skins yet.
export function readPlayerCarSkinAssetName(ground = 'tarmac') {
    const key = normalizeCarSkinGround(ground);
    const picked = readPlayerGroundCarSkinChoice(key);
    if (picked) return picked;
    if (key === 'tarmac') return STOCK_CAR_ASSET_NAME;
    const fallback = getDefaultCarAssetForGround(key);
    return fallback && isUsableGroundSkin(fallback, key)
        ? fallback
        : readPlayerCarSkinAssetName('tarmac');
}

// Stores a skin for its own ground. An invalid skin resets tarmac to the stock
// car and clears the pick of any other ground. Returns the skin the player now drives
// on that ground.
export function writePlayerCarSkinAssetName(assetName, ground = getCarAssetGround(assetName)) {
    const key = normalizeCarSkinGround(ground);
    const fallback = key === 'tarmac' ? STOCK_CAR_ASSET_NAME : null;
    const next = isUsableGroundSkin(assetName, key) ? assetName : fallback;
    writeStoredPlayerCarSkinAssetName(next, key);
    return readPlayerCarSkinAssetName(key);
}
