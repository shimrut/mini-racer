import { readdirSync } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    PLAYER_CAR_SKIN_SECTIONS,
    PLAYER_CAR_SKIN_STORAGE_KEY,
    PLAYER_CAR_SKINS,
    readPlayerCarSkinAssetName,
    writePlayerCarSkinAssetName
} from '../game/car/player-car-skin.js';
import { PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from '../game/car/sprite.js';

describe('player car skin', () => {
    const store = new Map();

    beforeEach(() => {
        store.clear();
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

    it('includes every shipped player car WebP as a selectable skin', () => {
        const names = PLAYER_CAR_SKINS.map((s) => s.assetName);
        for (const path of PLAYER_SELECTABLE_CAR_ASSETS) {
            expect(names).toContain(path);
        }
        expect(names).toHaveLength(PLAYER_SELECTABLE_CAR_ASSETS.length);
    });

    it('includes every mr_ variant from the car assets folder', () => {
        const carAssetDir = new URL('../public/assets/cars/', import.meta.url);
        const mrAssets = readdirSync(carAssetDir)
            .filter((fileName) => /^mr_.+\.webp$/.test(fileName))
            .map((fileName) => `assets/cars/${fileName}`)
            .sort();

        expect([...PLAYER_SELECTABLE_CAR_ASSETS].sort()).toEqual(mrAssets);
    });

    it('shows car labels without family prefixes', () => {
        const labels = PLAYER_CAR_SKINS.map((s) => s.label);
        expect(labels).toContain('Red');
        expect(labels).toContain('Blue');
        expect(labels).toContain('Cream');
        expect(labels).toContain('Arctic');
        expect(labels.some((label) => /^(Mini|Cyber|Steam|Extra)\s/.test(label))).toBe(false);
    });

    it('groups skins into Extra, MR, Cyberpunk, and Steampunk garage sections without gaps', () => {
        const expectedIds = ['extra', 'mini', 'cyberpunk', 'steampunk'].filter((id) =>
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
