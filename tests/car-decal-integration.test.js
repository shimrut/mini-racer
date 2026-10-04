import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { CarSpriteLoader, getCarSpriteCacheKey, getDrawnCar } from '../game/car/sprite.js';
import { writePlayerCarPaint } from '../game/car/player-car-paint.js';
import { readPlayerCarDecalStyle, writePlayerCarDecalStyle } from '../game/car/player-car-decals.js';
import { writePlayerCarSkinAssetName } from '../game/car/player-car-skin.js';
import { RealTimeRacer } from '../game/engine.js';
import { raceEngineMethods } from '../game/race/engine-methods.js';
import { GarageUi } from '../game/settings/garage-ui.js';

beforeEach(() => {
    const storage = new Map();
    vi.stubGlobal('window', { localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key),
    } });
    vi.stubGlobal('document', {
        createElement: () => createCanvas(1, 1),
        getElementById: () => null,
        querySelectorAll: () => [],
    });
});
afterEach(() => vi.unstubAllGlobals());

const ASSET = 'drawn/formula-gold';
const STYLE = 'drawn/formula-arctic';

describe('saved decal rendering integration', () => {
    it('updates the animated car, ghost sprite and cached lobby marker without changing skin or paint', async () => {
        writePlayerCarSkinAssetName(ASSET);
        writePlayerCarPaint(ASSET, 'main', '#246bff');
        const engine = {
            currentTrack: { ground: 'tarmac' }, currentTrackKey: 'local-fixture',
            getSelectedCarAssetName: raceEngineMethods.getSelectedCarAssetName,
            carSpriteLoader: new CarSpriteLoader(),
            requestRender: vi.fn(),
        };
        await raceEngineMethods.loadCarSpriteAsset.call(engine, ASSET);
        const before = engine.carSprite;
        writePlayerCarDecalStyle(ASSET, STYLE);
        const preview = RealTimeRacer.prototype.getPreviewCar.call(engine, 'local-fixture');
        expect(preview.image).not.toBe(before);
        const options = { paint: { main: '#246bff' }, decalStyle: STYLE };
        expect(preview.image).toBe(getDrawnCar(ASSET, options).sprite);
        await raceEngineMethods.loadCarSpriteAsset.call(engine, ASSET);
        expect(engine.drawnCar).toBe(getDrawnCar(ASSET, options));
        expect(engine.carSprite).toBe(preview.image);
        expect(engine.drawnCar.livery.main).toBe('#246bff');
        expect(engine.carSpriteLoader.currentAssetKey).toBe(ASSET);
        expect(RealTimeRacer.prototype.getPreviewCar.call(engine, 'local-fixture').key)
            .toBe(getCarSpriteCacheKey(ASSET, options));
    });

    it('selects the current track ground style rather than another ground saved choice', async () => {
        writePlayerCarSkinAssetName(ASSET);
        writePlayerCarSkinAssetName('drawn/mr_snow_ice', 'snow');
        writePlayerCarDecalStyle(ASSET, STYLE);
        writePlayerCarDecalStyle('drawn/mr_snow_ice', 'drawn/mr_snow_ice-purple');
        const engine = { currentTrack: { ground: 'snow' }, currentTrackKey: 'snow-fixture',
            getSelectedCarAssetName: raceEngineMethods.getSelectedCarAssetName,
            loadCarSpriteAsset: raceEngineMethods.loadCarSpriteAsset,
            carSpriteLoader: new CarSpriteLoader(), requestRender: vi.fn() };
        await raceEngineMethods.syncCarSpriteAsset.call(engine);
        expect(engine.carSpriteLoader.currentAssetKey).toBe('drawn/mr_snow_ice');
        expect(engine.drawnCar.decals.centerStripe).toBe('tertiary');
        expect(readPlayerCarDecalStyle(ASSET)).toBe(STYLE);
    });

    it('handles unused color channels in the real Garage thumbnails without inventing wing decals', () => {
        writePlayerCarSkinAssetName(ASSET);
        writePlayerCarDecalStyle(ASSET, 'drawn/formula-red');
        const garage = new GarageUi();
        garage.bind();
        garage.carPreview = { src: '' };
        garage.carName = {};
        garage.carStatus = {};
        garage.carSelect = { classList: { toggle() {} }, setAttribute() {} };
        garage.partPreviews = new Map(['main', 'accent', 'tertiary'].map(channel => [channel, createCanvas(192, 160)]));
        const palette = Array.from({ length: 7 }, () => ({
            dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, setAttribute() {},
        }));
        palette.forEach((button, index) => garage.colorOptionButtons.set(`tertiary:${index}`, button));
        expect(() => garage.syncCustomPreview()).not.toThrow();
        expect(palette.every(button => button.disabled)).toBe(true);
        expect(garage.previewCar.decals.rearWingEnds).toBeNull();
        const pixels = garage.partPreviews.get('tertiary').getContext('2d').getImageData(0, 0, 192, 160).data;
        expect(pixels.every(value => value === 0)).toBe(true);
        writePlayerCarDecalStyle(ASSET, STYLE);
        garage.syncCustomPreview();
        expect(palette.every(button => !button.disabled)).toBe(true);
        const updated = garage.partPreviews.get('tertiary').getContext('2d').getImageData(0, 0, 192, 160).data;
        expect(updated.some(value => value !== 0)).toBe(true);
        const prepare = vi.spyOn(garage, 'setShowcaseImage');
        garage.syncCustomPreview();
        expect(prepare).not.toHaveBeenCalled();
    });
});
