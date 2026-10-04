import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
    CarSpriteLoader,
    getCarPaintColors,
    getCarSpriteCacheKey,
    getDrawnCar,
    setCarAssetImageWithFallbacks,
} from '../game/car/sprite.js';
import { readPlayerCarPaint, writePlayerCarPaint } from '../game/car/player-car-paint.js';
import { writePlayerCarSkinAssetName } from '../game/car/player-car-skin.js';
import { DRAWN_CAR_SKINS } from '../game/car/drawn-car-skins.js';
import { FORMULA_CAR } from '../game/car/drawn-car/formula.js';
import { raceEngineMethods } from '../game/race/engine-methods.js';
import { RealTimeRacer } from '../game/engine.js';
import { loadPosterCar } from '../game/track/poster-car.js';

const ASSET = 'drawn/formula-red';
const BLUE = '#246bff';
const WHITE = '#f4f6ff';
const LIME = '#a8ed35';

beforeEach(() => {
    const storage = new Map();
    vi.stubGlobal('window', {
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: (key) => storage.delete(key),
        },
    });
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
});

afterEach(() => vi.unstubAllGlobals());

function paintAll() {
    writePlayerCarPaint(ASSET, 'main', BLUE);
    writePlayerCarPaint(ASSET, 'accent', WHITE);
    writePlayerCarPaint(ASSET, 'tertiary', LIME);
    return readPlayerCarPaint(ASSET);
}

function pixelHex(canvas, x, y) {
    const center = canvas.width / 2;
    const pixel = canvas.getContext('2d').getImageData(
        Math.round(center + x * 3), Math.round(center + y * 3), 1, 1,
    ).data;
    return `#${[...pixel].slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

describe('custom car paint rendering', () => {
    it('keeps original preset art and exposes the effective base colors', () => {
        const original = getDrawnCar(ASSET);
        expect(getCarPaintColors(ASSET)).toEqual({
            main: '#f90815', accent: '#feed4c', tertiary: '#ffffff',
        });
        expect(original.placements[0].paint('rearWingEnds')).toBeNull();
        expect(getCarPaintColors('assets/cars/mr_mr_red.webp')).toBeNull();

        const paint = paintAll();
        const painted = getDrawnCar(ASSET, { paint });
        expect(painted).not.toBe(original);
        expect(getDrawnCar(ASSET, { paint })).toBe(painted);
        expect(getDrawnCar(ASSET)).toBe(original);
        expect(getCarPaintColors(ASSET, { paint })).toEqual({ main: BLUE, accent: WHITE, tertiary: LIME });
        expect(DRAWN_CAR_SKINS[ASSET].livery).toBeUndefined();
        expect(FORMULA_CAR.decals.rearWingEnds).toBeNull();
        expect(original.placements[0].paint('rearWingEnds')).toBeNull();
    });

    it('shows all three chosen channels in both the rest sprite and animated race frame', () => {
        const paint = paintAll();
        const car = getDrawnCar(ASSET, { paint });
        const checkPaint = (sprite) => {
            expect(pixelHex(sprite, -43, 0)).toBe(BLUE);
            expect(pixelHex(sprite, 36.5, 0)).toBe(WHITE);
            expect(pixelHex(sprite, -45, -15.5)).toBe(LIME);
        };
        checkPaint(car.sprite);
        car.update(0.1, { speedPx: 300, speedKph: 160, steer: 1, holding: true });
        checkPaint(car.renderFrame());
        expect(car.steerAngle).toBeGreaterThan(0);
        expect(car.brake).toBe(1);
    });

    it('replaces a prefetched same-asset sprite after paint changes and keeps its saved asset name', () => {
        const loader = new CarSpriteLoader();
        const originalRecord = loader.prefetch(ASSET);
        const firstLoaded = vi.fn();
        loader.load(ASSET, { onLoaded: firstLoaded });
        expect(firstLoaded).toHaveBeenCalledWith(originalRecord.image);
        const originalKey = loader.currentVisualKey;

        const paint = paintAll();
        const nextLoaded = vi.fn();
        loader.load(ASSET, { paint, onLoaded: nextLoaded });
        const painted = getDrawnCar(ASSET, { paint }).sprite;
        expect(nextLoaded).toHaveBeenCalledWith(painted);
        expect(painted).not.toBe(originalRecord.image);
        expect(loader.currentAssetKey).toBe(ASSET);
        expect(loader.currentVisualKey).toBe(getCarSpriteCacheKey(ASSET, { paint }));
        expect(loader.currentVisualKey).not.toBe(originalKey);
        expect(loader.prefetch(ASSET, { paint }).image).toBe(painted);

        const preview = { onerror: vi.fn() };
        setCarAssetImageWithFallbacks(preview, ASSET);
        expect(preview.onerror).toBeNull();
        expect(preview.src).toBe(originalRecord.image.toDataURL('image/png'));
    });

    it('refreshes a cached other-ground preview and the race/ghost sprite with the new paint', async () => {
        writePlayerCarSkinAssetName(ASSET, 'tarmac');
        const engine = {
            currentTrackKey: 'preview',
            currentTrack: { ground: 'tarmac' },
            carSpriteLoader: new CarSpriteLoader(),
            carSprite: null,
            dailyCarousel: { refreshPreviews: vi.fn() },
            campaignCarousel: { refreshPreviews: vi.fn() },
            requestRender: vi.fn(),
        };
        // The live race uses Circuit while a Street card uses its own cache.
        await raceEngineMethods.loadCarSpriteAsset.call(engine, 'drawn/mr_grip_circuit');
        const originalPreview = RealTimeRacer.prototype.getPreviewCar.call(engine, 'preview');
        const paint = paintAll();
        const newPreview = RealTimeRacer.prototype.getPreviewCar.call(engine, 'preview');
        expect(newPreview.image).not.toBe(originalPreview.image);
        expect(newPreview.key).not.toBe(originalPreview.key);
        expect(newPreview.image).toBe(getDrawnCar(ASSET, { paint }).sprite);
        expect(engine.previewCarSprites.size).toBe(1);

        await raceEngineMethods.loadCarSpriteAsset.call(engine, ASSET);
        expect(engine.drawnCar).toBe(getDrawnCar(ASSET, { paint }));
        expect(engine.carSprite).toBe(engine.drawnCar.sprite);
        expect(RealTimeRacer.prototype.getPreviewCar.call(engine, 'preview')).toEqual(newPreview);
        expect(engine.dailyCarousel.refreshPreviews).toHaveBeenCalled();
        expect(engine.campaignCarousel.refreshPreviews).toHaveBeenCalled();
    });

    it('keeps generic sprites and default post cars independent of local player paint', async () => {
        const circuit = 'drawn/mr_grip_circuit';
        writePlayerCarPaint(circuit, 'main', BLUE);
        const paint = paintAll();
        const storageRead = vi.spyOn(window.localStorage, 'getItem');
        const preset = getDrawnCar(ASSET);
        const customized = getDrawnCar(ASSET, { paint });
        const opponentLoader = new CarSpriteLoader();
        const onLoaded = vi.fn();
        opponentLoader.load(ASSET, { onLoaded });
        expect(onLoaded).toHaveBeenCalledWith(preset.sprite);
        expect(preset.sprite).not.toBe(customized.sprite);
        expect(getCarPaintColors(ASSET)).toMatchObject({ main: '#f90815' });
        expect(getCarSpriteCacheKey(ASSET)).not.toBe(getCarSpriteCacheKey(ASSET, { paint }));
        const poster = await loadPosterCar({ ground: 'grip' });
        expect(poster).toBe(getDrawnCar(circuit).sprite);
        expect(poster).not.toBe(getDrawnCar(circuit, { paint: { main: BLUE } }).sprite);
        expect(storageRead).not.toHaveBeenCalled();
    });

    it('gives an explicitly customizable empty livery a visible tertiary area without changing the preset', () => {
        const preset = getDrawnCar(ASSET);
        const editable = getDrawnCar(ASSET, { paint: {} });
        expect(preset.decals.rearWingEnds).toBeNull();
        expect(editable.decals.rearWingEnds).toBe('tertiary');
        expect(editable.paintForArea('rearWingEnds').base).toBe('#ffffff');
        expect(getCarSpriteCacheKey(ASSET, { paint: {} })).not.toBe(getCarSpriteCacheKey(ASSET));
        const existingTertiary = 'drawn/mr_grip_circuit-blue';
        expect(getCarSpriteCacheKey(existingTertiary, { paint: {} })).toBe(getCarSpriteCacheKey(existingTertiary));
        const repainted = getDrawnCar(ASSET, { paint: { tertiary: BLUE } });
        expect(repainted.paintForArea('rearWingEnds').base).toBe(BLUE);
        expect(pixelHex(editable.sprite, -45, -15.5)).toBe('#ffffff');
        expect(pixelHex(repainted.sprite, -45, -15.5)).toBe(BLUE);
    });

    it('exposes the same resolved decal channels and fallback rules used to draw the parts', () => {
        const car = getDrawnCar('drawn/mr_grip_circuit-blue', { paint: { tertiary: LIME } });
        expect(car.paintForArea.channelFor('rearWingEnds')).toBe('accent');
        expect(car.paintForArea.channelFor('noseStripe')).toBe('tertiary');
        expect(car.paintForArea('noseStripe').base).toBe(car.livery.tertiary);
        expect(car.paintForArea.channelFor('intakes', 'main')).toBe('main');
        expect(car.paintForArea.channelFor('intakes')).toBeNull();
        const jetski = getDrawnCar('drawn/mr_water_jetski');
        expect(jetski.paintForArea.channelFor('vest', 'main')).toBeNull();
        expect(jetski.paintForArea('vest', 'main').base).toBe('#ff8a1f');
    });
});
