import { describe, expect, it } from 'vitest';
import {
    getCarAssetGround,
    getDefaultCarAssetForGround,
    getDefaultDrawnCarAssetForGround,
} from '../game/car/car-skin-grounds.js';
import { STOCK_CAR_ASSET_NAME } from '../game/car/car-unlock-policy.js';
import { DRAWN_CAR_SKINS } from '../game/car/drawn-car-skins.js';

describe('surface defaults for authoring cars', () => {
    it.each([
        ['tarmac', 'drawn/formula-red', 'formula'],
        ['grip', 'drawn/mr_grip_circuit', 'circuit'],
        ['dirt', 'drawn/mr_dirt_rally', 'rally'],
        ['snow', 'drawn/mr_snow_ice', 'snow'],
        ['water', 'drawn/mr_water_jetski', 'jetski'],
        ['space', 'drawn/mr_space_ship', 'spaceship'],
    ])('%s uses its full default vehicle', (ground, assetName, model) => {
        const actual = getDefaultDrawnCarAssetForGround(ground);
        expect(actual).toBe(assetName);
        expect(getCarAssetGround(actual)).toBe(ground);
        expect(DRAWN_CAR_SKINS[actual].car).toBe(model);
    });

    it('treats unknown or missing surfaces as tarmac', () => {
        expect(getDefaultDrawnCarAssetForGround('unknown')).toBe('drawn/formula-red');
        expect(getDefaultDrawnCarAssetForGround()).toBe('drawn/formula-red');
    });

    it('preserves the existing player and poster default on tarmac', () => {
        expect(getDefaultCarAssetForGround('tarmac')).toBe(STOCK_CAR_ASSET_NAME);
    });
});
