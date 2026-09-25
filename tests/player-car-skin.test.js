import { readdirSync } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    PLAYER_CAR_SKIN_SECTIONS,
    PLAYER_CAR_SKIN_STORAGE_KEY,
    PLAYER_CAR_SKINS,
    readPlayerCarSkinAssetName,
    setPlayerCarUnlockSnapshot,
    writePlayerCarSkinAssetName
} from '../game/car/player-car-skin.js';
import {
    DEFAULT_CAR_UNLOCK_SNAPSHOT,
    EXTRA_CAR_ASSETS,
    buildCarUnlockSnapshot,
} from '../game/car/car-unlock-policy.js';
import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from '../game/car/sprite.js';
import { DRAWN_CAR_ASSET_NAMES, isDrawnCarAsset } from '../game/car/drawn-car-skins.js';

describe('player car skin', () => {
    const store = new Map();

    beforeEach(() => {
        store.clear();
        setPlayerCarUnlockSnapshot(DEFAULT_CAR_UNLOCK_SNAPSHOT);
        globalThis.window = {
            localStorage: {
                getItem: (key) => (store.has(key) ? store.get(key) : null),
                setItem: (key, value) => {
                    store.set(key, String(value));
                },
                removeItem: (key) => {
                    store.delete(key);
                }
            }
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('defaults to the stock asset when nothing is stored', () => {
        expect(readPlayerCarSkinAssetName()).toBe(STOCK_CAR_ASSET_NAME);
    });

    it('persists a valid skin choice', () => {
        const alt = PLAYER_CAR_SKINS.find((s) => s.assetName !== STOCK_CAR_ASSET_NAME);
        expect(alt).toBeTruthy();
        writePlayerCarSkinAssetName(alt.assetName);
        expect(readPlayerCarSkinAssetName()).toBe(alt.assetName);
    });

    it('falls back to stock for unknown stored values', () => {
        store.set(PLAYER_CAR_SKIN_STORAGE_KEY, JSON.stringify('assets/cars/nope.webp'));
        expect(readPlayerCarSkinAssetName()).toBe(STOCK_CAR_ASSET_NAME);
    });

    it('rejects a locked car locally and accepts it after the server unlock snapshot arrives', () => {
        expect(writePlayerCarSkinAssetName(EXTRA_CAR_ASSETS.crimson)).toBe(STOCK_CAR_ASSET_NAME);
        expect(readPlayerCarSkinAssetName()).toBe(STOCK_CAR_ASSET_NAME);

        setPlayerCarUnlockSnapshot(buildCarUnlockSnapshot({ completedRace: true }));

        expect(writePlayerCarSkinAssetName(EXTRA_CAR_ASSETS.crimson)).toBe(EXTRA_CAR_ASSETS.crimson);
        expect(readPlayerCarSkinAssetName()).toBe(EXTRA_CAR_ASSETS.crimson);
    });

    it('retires a selection the server says is locked', () => {
        setPlayerCarUnlockSnapshot(buildCarUnlockSnapshot({ completedRace: true }));
        writePlayerCarSkinAssetName(EXTRA_CAR_ASSETS.crimson);

        setPlayerCarUnlockSnapshot(DEFAULT_CAR_UNLOCK_SNAPSHOT);

        expect(JSON.parse(store.get(PLAYER_CAR_SKIN_STORAGE_KEY))).toBe(STOCK_CAR_ASSET_NAME);
    });

    it('keeps a stored selection when the unlock snapshot is not authoritative', () => {
        setPlayerCarUnlockSnapshot(buildCarUnlockSnapshot({ completedRace: true }));
        writePlayerCarSkinAssetName(EXTRA_CAR_ASSETS.crimson);

        setPlayerCarUnlockSnapshot(DEFAULT_CAR_UNLOCK_SNAPSHOT, { authoritative: false });

        expect(JSON.parse(store.get(PLAYER_CAR_SKIN_STORAGE_KEY))).toBe(EXTRA_CAR_ASSETS.crimson);
        setPlayerCarUnlockSnapshot(buildCarUnlockSnapshot({ completedRace: true }));
        expect(readPlayerCarSkinAssetName()).toBe(EXTRA_CAR_ASSETS.crimson);
    });

    it('includes every shipped player car WebP as a selectable skin', () => {
        const names = PLAYER_CAR_SKINS.map((s) => s.assetName);
        for (const path of PLAYER_SELECTABLE_CAR_ASSETS) {
            expect(names).toContain(path);
        }
        expect(names).toHaveLength(PLAYER_SELECTABLE_CAR_ASSETS.length);
    });

    it('includes every mr_ variant from the car assets folder, then the cars drawn in code', () => {
        const carAssetDir = new URL('../public/assets/cars/', import.meta.url);
        const mrAssets = readdirSync(carAssetDir)
            .filter((fileName) => /^mr_.+\.webp$/.test(fileName))
            .map((fileName) => `assets/cars/${fileName}`)
            .sort();

        const imageAssets = PLAYER_SELECTABLE_CAR_ASSETS.filter((assetName) => !isDrawnCarAsset(assetName));
        expect([...imageAssets].sort()).toEqual(mrAssets);
        expect(PLAYER_SELECTABLE_CAR_ASSETS.slice(imageAssets.length)).toEqual(DRAWN_CAR_ASSET_NAMES);
    });

    it('offers the Formula cars drawn in code as unlocked tarmac skins in the first garage section', () => {
        const [first] = PLAYER_CAR_SKIN_SECTIONS;
        expect(first).toMatchObject({ id: 'formula', title: 'Formula cars' });
        expect(first.skins.map((s) => s.label)).toEqual(['Red', 'Gold', 'Lime', 'Arctic']);

        for (const skin of first.skins) {
            expect(skin.ground).toBe('tarmac');
            expect(writePlayerCarSkinAssetName(skin.assetName)).toBe(skin.assetName);
            expect(readPlayerCarSkinAssetName()).toBe(skin.assetName);
        }
    });

    it('offers the Snow cars drawn in code as snow skins, and drives the white one by default', () => {
        const snow = PLAYER_CAR_SKIN_SECTIONS.find((s) => s.id === 'snow');
        expect(snow.title).toBe('Snow cars');
        expect(snow.skins.map((s) => s.label)).toEqual(['White', 'Red', 'Black', 'Teal', 'Purple']);
        for (const skin of snow.skins) {
            expect(DRAWN_CAR_ASSET_NAMES).toContain(skin.assetName);
            expect(skin.ground).toBe('snow');
        }
        expect(readPlayerCarSkinAssetName('snow')).toBe(snow.skins[0].assetName);

        const teal = snow.skins[3].assetName;
        expect(writePlayerCarSkinAssetName(teal)).toBe(teal);
        expect(readPlayerCarSkinAssetName('snow')).toBe(teal);
        expect(readPlayerCarSkinAssetName('dirt')).not.toBe(teal);
    });

    it('offers only the Rally cars drawn in code as dirt skins, and drives the red one by default', () => {
        const dirt = PLAYER_CAR_SKIN_SECTIONS.find((s) => s.id === 'dirt');
        expect(dirt.skins.map((s) => s.label)).toEqual(['Red', 'Blue', 'White', 'Green', 'Black']);
        for (const skin of dirt.skins) {
            expect(DRAWN_CAR_ASSET_NAMES).toContain(skin.assetName);
            expect(skin.ground).toBe('dirt');
        }
        expect(readPlayerCarSkinAssetName('dirt')).toBe(dirt.skins[0].assetName);

        const black = dirt.skins[4].assetName;
        expect(writePlayerCarSkinAssetName(black)).toBe(black);
        expect(readPlayerCarSkinAssetName('dirt')).toBe(black);
        expect(readPlayerCarSkinAssetName('tarmac')).toBe(STOCK_CAR_ASSET_NAME);
    });

    it('shows car labels without family prefixes', () => {
        const labels = PLAYER_CAR_SKINS.map((s) => s.label);
        expect(labels).toContain('Red');
        expect(labels).toContain('Blue');
        expect(labels).toContain('Cream');
        expect(labels).toContain('Arctic');
        expect(labels.some((label) => /^(Mini|Cyber|Steam|Extra)\s/.test(label))).toBe(false);
    });

    it('groups skins into Formula, Extra, MR, Cyberpunk, Steampunk, Dirt and Snow garage sections without gaps', () => {
        const expectedIds = ['formula', 'extra', 'mini', 'cyberpunk', 'steampunk', 'dirt', 'snow'].filter((id) =>
            PLAYER_CAR_SKINS.some((s) => s.series === id)
        );
        expect(PLAYER_CAR_SKIN_SECTIONS.map((s) => s.id)).toEqual(expectedIds);

        const seen = new Set();
        let n = 0;
        for (const sec of PLAYER_CAR_SKIN_SECTIONS) {
            for (const skin of sec.skins) {
                expect(skin.series).toBe(sec.id);
                expect(seen.has(skin.assetName)).toBe(false);
                seen.add(skin.assetName);
                n += 1;
            }
        }
        expect(n).toBe(PLAYER_CAR_SKINS.length);
    });
});
