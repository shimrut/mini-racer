import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DrawnCar } from '../game/car/drawn-car.js';
import { GarageUi, getSpriteBounds } from '../game/settings/garage-ui.js';
import { DRAWN_CAR_ASSET_NAMES } from '../game/car/drawn-car-skins.js';
import { writePlayerCarDecalStyle } from '../game/car/player-car-decals.js';
import { writePlayerCarSkinAssetName } from '../game/car/player-car-skin.js';
import { getDrawnCar } from '../game/car/sprite.js';

beforeEach(() => vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) }));
afterEach(() => vi.unstubAllGlobals());

function paintedBounds(canvas) {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
    for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
            if (data[(y * canvas.width + x) * 4 + 3] < 10) continue;
            left = Math.min(left, x); right = Math.max(right, x);
            top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
    }
    return { width: right - left + 1, height: bottom - top + 1, left, top, right, bottom };
}

describe('Garage part details', () => {
    it('renders a sharper Garage still without changing the cached race sprite or frame', async () => {
        const car = getDrawnCar('drawn/formula-red', { paint: {} });
        const raceSprite = car.sprite;
        const racePixels = raceSprite.toBuffer('image/png');
        const raceFrame = car.renderFrame();
        const garage = new GarageUi();
        garage.carPreview = { src: '' };
        const prepare = vi.spyOn(garage, 'setShowcaseImage');

        garage.syncCustomPreview();
        const preview = await loadImage(garage.carPreview.src);
        const originalBounds = getSpriteBounds(raceSprite);
        expect(preview.width).toBeGreaterThanOrEqual(originalBounds.width * 2.9);
        expect(preview.height).toBeGreaterThanOrEqual(originalBounds.height * 2.9);
        expect(car.pixelsPerUnit).toBe(3);
        expect(car.sprite).toBe(raceSprite);
        expect(car.sprite.toBuffer('image/png').equals(racePixels)).toBe(true);
        expect(car.renderFrame()).toBe(raceFrame);
        expect([...car.layerSets.keys()]).toEqual([3]);
        expect(getDrawnCar('drawn/formula-red', { paint: {} })).toBe(car);

        const image = garage.carPreview.src;
        garage.syncCustomPreview();
        expect(garage.carPreview.src).toBe(image);
        expect(prepare).toHaveBeenCalledTimes(1);
    });

    it('reuses prepared artwork for status refreshes and when returning to a previewed type', () => {
        const garage = new GarageUi();
        garage.carPreview = { src: '' };
        garage.partPreviews = new Map(['main', 'accent', 'tertiary'].map((channel) => [channel, createCanvas(192, 160)]));
        const prepare = vi.spyOn(garage, 'setShowcaseImage');
        const regions = vi.spyOn(garage, 'findPaintDetails');
        const fit = vi.spyOn(garage, 'fitPartPreview');
        garage.syncCustomPreview();
        const originalImage = garage.carPreview.src;
        garage.syncCustomPreview();
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(fit).toHaveBeenCalledTimes(3);
        garage.activeGarageTab = 'dirt';
        garage.syncCustomPreview();
        garage.activeGarageTab = 'street';
        garage.syncCustomPreview();
        expect(garage.carPreview.src).toBe(originalImage);
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(regions).toHaveBeenCalledTimes(2);
        expect(fit).toHaveBeenCalledTimes(6);
    });

    it('leaves every street decal unselected while a legacy car is equipped', () => {
        const storage = new Map();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key),
        } });
        writePlayerCarSkinAssetName('assets/cars/mr_mr_red.webp');
        writePlayerCarDecalStyle('drawn/formula-red', 'drawn/formula-gold');
        const garage = new GarageUi();
        garage.carPreview = { src: '' };
        garage.activeGarageTab = 'street';
        const pressed = new Map();
        const button = (id) => ({
            classList: { toggle() {} },
            setAttribute(name, value) {
                if (name === 'aria-pressed') pressed.set(id, value);
            },
            querySelector: () => ({ src: '' }),
        });
        garage.decalOptionButtons.set('drawn/formula-red', button('drawn/formula-red'));
        garage.decalOptionButtons.set('drawn/formula-gold', button('drawn/formula-gold'));

        garage.syncCustomPreview();
        expect(pressed.get('drawn/formula-red')).toBe('false');
        expect(pressed.get('drawn/formula-gold')).toBe('false');

        writePlayerCarSkinAssetName('drawn/formula-red');
        garage.syncCustomPreview();
        expect(pressed.get('drawn/formula-gold')).toBe('true');
        expect(pressed.get('drawn/formula-red')).toBe('false');
    });

    it('shares bounds handling for transparent margins and an empty sprite', () => {
        const canvas = createCanvas(80, 60);
        expect(getSpriteBounds(canvas)).toBeNull();
        canvas.getContext('2d').fillRect(8, 12, 20, 10);
        expect(getSpriteBounds(canvas)).toEqual({ left: 8, top: 12, width: 20, height: 10, count: 200 });
    });

    it.each(DRAWN_CAR_ASSET_NAMES)('each channel detail changes with its own paint on %s', (asset) => {
        const car = getDrawnCar(asset, { paint: {} });
        const bounds = GarageUi.prototype.findPaintDetails(car);
        expect([...bounds.keys()].sort()).toEqual(['accent', 'main', 'tertiary']);
        for (const channel of ['main', 'accent', 'tertiary']) {
            const detail = bounds.get(channel);
            const before = createCanvas(192, 160);
            const after = createCanvas(192, 160);
            const first = getDrawnCar(asset, { paint: { [channel]: '#252936' } });
            const second = getDrawnCar(asset, { paint: { [channel]: '#246bff' } });
            GarageUi.prototype.fitPartPreview(before, GarageUi.prototype.makePartDetail(first, detail), detail);
            GarageUi.prototype.fitPartPreview(after, GarageUi.prototype.makePartDetail(second, detail), detail);
            expect(paintedBounds(before).width).toBeGreaterThan(0);
            expect(before.toBuffer('image/png').equals(after.toBuffer('image/png'))).toBe(false);
        }
    });

    it('keeps neighboring tires out of the actual body detail and retains the cockpit overlay', () => {
        const car = getDrawnCar('drawn/formula-red', { paint: {} });
        const bounds = GarageUi.prototype.findPaintDetails(car).get('main');
        const detail = GarageUi.prototype.makePartDetail(car, bounds);
        for (const [x, y] of [[76, 110], [76, 220], [85, 109]]) {
            expect(car.sprite.getContext('2d').getImageData(x, y, 1, 1).data[3]).toBe(255);
            expect(detail.getContext('2d').getImageData(x, y, 1, 1).data[3]).toBe(0);
        }
        const x = detail.width / 2, y = detail.height / 2;
        expect([...detail.getContext('2d').getImageData(x, y, 1, 1).data])
            .toEqual([...car.sprite.getContext('2d').getImageData(x, y, 1, 1).data]);
    });
    it('shows only the requested body and cockpit, with no tires in the detail', () => {
        const car = new DrawnCar();
        const detail = car.partSprite(['body', 'cockpit']);
        const tireX = Math.round(detail.width / 2 - 29.8 * car.pixelsPerUnit);
        const tireY = Math.round(detail.height / 2 - 23.6 * car.pixelsPerUnit);
        expect(detail.getContext('2d').getImageData(tireX, tireY, 1, 1).data[3]).toBe(0);
        expect(car.sprite.getContext('2d').getImageData(tireX, tireY, 1, 1).data[3]).toBeGreaterThan(0);
        expect(paintedBounds(detail).width).toBeGreaterThan(200);
    });

    it.each([[80, 20], [20, 80], [55, 40]])('fits a %sx%s detail at one uniform scale and centers it', (width, height) => {
        const source = createCanvas(120, 120);
        source.getContext('2d').fillRect(10, 15, width, height);
        const target = createCanvas(192, 160);
        GarageUi.prototype.fitPartPreview(target, source);
        const bounds = paintedBounds(target);
        expect(bounds.width / bounds.height).toBeCloseTo(width / height, 1);
        expect(Math.abs((bounds.left + bounds.right + 1) / 2 - target.width / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs((bounds.top + bounds.bottom + 1) / 2 - target.height / 2)).toBeLessThanOrEqual(1);
        expect(Math.max(bounds.width / (target.width - 12), bounds.height / (target.height - 12))).toBeGreaterThanOrEqual(.99);
    });
});
