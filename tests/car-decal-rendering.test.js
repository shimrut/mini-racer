import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { DRAWN_CAR_MODELS, DrawnCar } from '../game/car/drawn-car.js';
import { DRAWN_CAR_SKINS } from '../game/car/drawn-car-skins.js';
import {
    CarSpriteLoader,
    getCarPaintColors,
    getCarSpriteCacheKey,
    getDrawnCar,
    setCarAssetImageWithFallbacks,
} from '../game/car/sprite.js';

const RED = 'drawn/formula-red';
const GOLD = 'drawn/formula-gold';
const LIME = 'drawn/formula-lime';
const ARCTIC = 'drawn/formula-arctic';
const PAINT = { main: '#246bff', accent: '#f4f6ff', tertiary: '#a8ed35' };

beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
});

afterEach(() => vi.unstubAllGlobals());

function pixels(canvas) {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
}

function partSettings(car) {
    return car.placements.map(({ paint, ...placement }) => placement);
}

describe('matched car decal styles', () => {
    it('changes the body and wings with unchanged colors and refreshes both sprite caches', () => {
        const loader = new CarSpriteLoader();
        const firstOptions = { paint: PAINT, decalStyle: GOLD };
        const first = getDrawnCar(RED, firstOptions);
        const firstKey = getCarSpriteCacheKey(RED, firstOptions);
        const firstRecord = loader.prefetch(RED, firstOptions);

        const nextOptions = { paint: PAINT, decalStyle: ARCTIC };
        const next = getDrawnCar(RED, nextOptions);
        const nextRecord = loader.prefetch(RED, nextOptions);
        expect(next).not.toBe(first);
        expect(getDrawnCar(RED, nextOptions)).toBe(next);
        expect(getCarPaintColors(RED, nextOptions)).toEqual(PAINT);
        expect(next.decals).toMatchObject({ centerStripe: 'accent', noseTip: 'accent', rearWingEnds: 'tertiary' });
        expect(first.decals).toMatchObject({ centerStripe: null, noseTip: null, rearWingFlap: 'accent' });
        expect(pixels(next.sprite)).not.toEqual(pixels(first.sprite));
        first.update(0.1, { speedPx: 300, speedKph: 160, steer: 1 });
        next.update(0.1, { speedPx: 300, speedKph: 160, steer: 1 });
        expect(pixels(next.renderFrame())).not.toEqual(pixels(first.renderFrame()));
        expect(getCarSpriteCacheKey(RED, nextOptions)).not.toBe(firstKey);
        expect(nextRecord.image).toBe(next.sprite);
        expect(nextRecord.image).not.toBe(firstRecord.image);
        expect(loader.prefetch(RED, nextOptions)).toBe(nextRecord);

        const onLoaded = vi.fn();
        loader.load(RED, { ...nextOptions, onLoaded });
        expect(onLoaded).toHaveBeenCalledWith(next.sprite);
        expect(loader.currentAssetKey).toBe(RED);
        expect(loader.currentVisualKey).toBe(nextRecord.visualKey);
    });

    it('uses the full chosen map, including null areas, without retaining the original skin overrides', () => {
        const original = getDrawnCar(ARCTIC);
        const chosen = getDrawnCar(ARCTIC, { paint: PAINT, decalStyle: LIME });
        expect(original.decals).toMatchObject({ rearWingEnds: 'tertiary', frontWingTips: 'tertiary', noseTip: 'accent' });
        expect(chosen.decals).toMatchObject({
            centerStripe: 'accent', noseStripe: null, noseTip: null,
            rearWingEnds: null, frontWingTips: null, frontWingEdge: 'tertiary',
        });
        expect(chosen.paintForArea('noseStripe')).toBeNull();
        expect(chosen.paintForArea('rearWingEnds')).toBeNull();
    });

    it('renders transient style thumbnails through the same constructor without evicting the cached player car', () => {
        const asset = 'drawn/mr_dirt_rally-black';
        const options = { paint: PAINT, decalStyle: 'drawn/mr_dirt_rally-blue' };
        const playerCar = getDrawnCar(asset, options);
        for (const [decalStyle, skin] of Object.entries(DRAWN_CAR_SKINS)) {
            if (skin.car !== 'rally') continue;
            const thumbnail = new DrawnCar(playerCar.car, DRAWN_CAR_SKINS[asset], { paint: PAINT, decalStyle });
            expect(thumbnail.livery).toEqual(playerCar.livery);
            expect(partSettings(thumbnail)).toEqual(partSettings(playerCar));
            expect(thumbnail.decals).toEqual({ ...playerCar.car.decals, ...(skin.decals || {}) });
            expect(thumbnail.sprite).not.toBe(playerCar.sprite);
        }
        expect(getDrawnCar(asset, options)).toBe(playerCar);
    });

    it('keeps an explicitly selected Red layout plain and restores the existing editable default on reset', () => {
        const preset = getDrawnCar(RED);
        const oldEditableDefault = getDrawnCar(RED, { paint: PAINT });
        const chosen = getDrawnCar(RED, { paint: PAINT, decalStyle: RED });
        expect(chosen.decals.rearWingEnds).toBeNull();
        expect(chosen.paintForArea('rearWingEnds')).toBeNull();
        expect(oldEditableDefault.decals.rearWingEnds).toBe('tertiary');
        expect(getCarSpriteCacheKey(RED, { paint: PAINT, decalStyle: RED }))
            .not.toBe(getCarSpriteCacheKey(RED, { paint: PAINT }));
        expect(getDrawnCar(RED, { paint: PAINT, decalStyle: null }).decals.rearWingEnds).toBe('tertiary');
        expect(getDrawnCar(RED, { decalStyle: null })).toBe(preset);
        expect(preset.decals.rearWingEnds).toBeNull();
    });

    it('rejects unknown, legacy and other-model styles without changing the existing default behavior', () => {
        const preset = getDrawnCar(RED);
        for (const decalStyle of ['drawn/mr_dirt_rally', 'assets/cars/mr_mr_red.webp', 'unknown', '__proto__', {}]) {
            expect(getDrawnCar(RED, { decalStyle })).toBe(preset);
            expect(getDrawnCar(RED, { paint: PAINT, decalStyle }).decals.rearWingEnds).toBe('tertiary');
        }
        expect(getDrawnCar('assets/cars/mr_mr_red.webp', { decalStyle: RED })).toBeNull();
    });

    it.each(Object.entries(DRAWN_CAR_SKINS))(
        'preserves the original livery, materials and parts of %s for every compatible style',
        (assetName, skin) => {
            const original = getDrawnCar(assetName);
            const model = DRAWN_CAR_MODELS[skin.car];
            for (const [decalStyle, styleSkin] of Object.entries(DRAWN_CAR_SKINS)) {
                if (styleSkin.car !== skin.car) continue;
                const customized = getDrawnCar(assetName, { decalStyle });
                expect(customized.car).toBe(model);
                expect(customized.livery).toEqual(original.livery);
                expect(partSettings(customized)).toEqual(partSettings(original));
                expect(customized.decals).toEqual({ ...model.decals, ...(styleSkin.decals || {}) });
                expect(customized.sprite.width).toBe(original.sprite.width);
                expect(pixels(customized.sprite).some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
            }
        },
    );

    it('keeps generic artwork pristine after a customized load without reading player preferences', () => {
        const getItem = vi.fn(() => { throw new Error('Generic artwork must not read preferences'); });
        vi.stubGlobal('window', { localStorage: { getItem } });
        const preset = getDrawnCar(RED);
        const loader = new CarSpriteLoader();
        loader.load(RED, { paint: PAINT, decalStyle: ARCTIC });
        const customKey = loader.currentVisualKey;
        const genericLoaded = vi.fn();
        loader.load(RED, { onLoaded: genericLoaded });
        expect(genericLoaded).toHaveBeenCalledWith(preset.sprite);
        expect(loader.currentVisualKey).toBe(getCarSpriteCacheKey(RED));
        expect(loader.currentVisualKey).not.toBe(customKey);
        expect(getDrawnCar(RED)).toBe(preset);

        const preview = {};
        setCarAssetImageWithFallbacks(preview, RED);
        expect(preview.src).toBe(preset.sprite.toDataURL('image/png'));
        expect(getItem).not.toHaveBeenCalled();
    });

    it('settles an unfinished image selection when choosing a styled car and never lets its late result overwrite it', async () => {
        const images = [];
        vi.stubGlobal('Image', class {
            constructor() {
                this.listeners = {};
                images.push(this);
            }
            addEventListener(type, handler) { this.listeners[type] = handler; }
        });
        const loader = new CarSpriteLoader();
        const oldLoaded = vi.fn();
        const oldSuperseded = vi.fn();
        loader.load('assets/cars/pending.webp', { onLoaded: oldLoaded, onSuperseded: oldSuperseded });
        const onLoaded = vi.fn();
        const options = { paint: PAINT, decalStyle: GOLD };
        loader.load(RED, { ...options, onLoaded });
        expect(oldSuperseded).toHaveBeenCalledExactlyOnceWith('assets/cars/pending.webp');
        expect(onLoaded).toHaveBeenCalledWith(getDrawnCar(RED, options).sprite);
        const selectedKey = loader.currentVisualKey;

        images[0].listeners.load();
        await Promise.resolve();
        await Promise.resolve();
        expect(oldLoaded).not.toHaveBeenCalled();
        expect(loader.currentAssetKey).toBe(RED);
        expect(loader.currentVisualKey).toBe(selectedKey);
    });
});
