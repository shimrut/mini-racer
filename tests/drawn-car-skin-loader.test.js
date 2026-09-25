import { describe, expect, it } from 'vitest';
import { CarSpriteLoader, getDrawnCar } from '../game/car/sprite.js';
import { DRAWN_CAR_ASSET_NAMES, DRAWN_CAR_SKINS } from '../game/car/drawn-car-skins.js';
import { DRAWN_CAR_MODELS } from '../game/car/drawn-car.js';
import { isHexColor } from '../game/car/drawn-car/paint.js';
import { buildCarUnlockSnapshot, isCarAssetUnlocked } from '../game/car/car-unlock-policy.js';

const [DRAWN] = DRAWN_CAR_ASSET_NAMES;

describe('drawn car skin', () => {
    it('keeps one live car for each drawn skin, and none for an image skin', () => {
        expect(getDrawnCar(DRAWN)).toBe(getDrawnCar(DRAWN));
        expect(getDrawnCar('assets/cars/mr_mr_red.webp')).toBeNull();
    });

    it('is unlocked for every player, so the server accepts it as a pick', () => {
        expect(isCarAssetUnlocked(DRAWN, buildCarUnlockSnapshot())).toBe(true);
    });

    it('reports an error, not a wait, when there is no canvas to draw on', async () => {
        const loader = new CarSpriteLoader();
        const failed = await new Promise((resolve) => {
            loader.load(DRAWN, { onLoaded: () => resolve(false), onError: () => resolve(true) });
        });
        expect(failed).toBe(true);
    });

    it.each(DRAWN_CAR_ASSET_NAMES)('%s names only real decal areas and real colors', (assetName) => {
        const skin = DRAWN_CAR_SKINS[assetName];
        const car = DRAWN_CAR_MODELS[skin.car];
        expect(car).toBeTruthy();
        const livery = { ...car.livery, ...(skin.livery || {}) };
        for (const [slot, color] of Object.entries(skin.livery || {})) {
            expect(Object.keys(car.livery)).toContain(slot);
            expect(isHexColor(color)).toBe(true);
        }
        for (const [area, paint] of Object.entries(skin.decals || {})) {
            expect(Object.keys(car.decals)).toContain(area);
            expect(paint === null || Object.hasOwn(livery, paint) || isHexColor(paint)).toBe(true);
        }
        for (const [material, color] of Object.entries(skin.colors || {})) {
            expect(Object.keys(car.colors)).toContain(material);
            expect(isHexColor(color)).toBe(true);
        }
        const partIds = car.parts.map((part) => part.id);
        for (const id of Object.keys(skin.parts || {})) expect(partIds).toContain(id);
    });
});
