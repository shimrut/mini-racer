import { describe, expect, it, vi } from 'vitest';
import { CarSpriteLoader } from '../game/car/sprite.js';
import { raceEngineMethods } from '../game/race/engine-methods.js';

function createEngine() {
    let callbacks = null;
    const engine = {
        carSprite: { id: 'fallback' },
        carSpriteDrawWidth: 64,
        carSpriteDrawHeight: 32,
        carSpriteLoader: {
            load: vi.fn((_assetName, nextCallbacks) => {
                callbacks = nextCallbacks;
            }),
        },
        dailyCarousel: { refreshPreviews: vi.fn() },
        campaignCarousel: { refreshPreviews: vi.fn() },
        requestRender: vi.fn(),
    };
    return {
        engine,
        getCallbacks: () => callbacks,
    };
}

describe('selected Garage car in lobby previews', () => {
    it('refreshes Daily and Campaign after the selected sprite finishes loading', async () => {
        const { engine, getCallbacks } = createEngine();
        const selectedCar = { id: 'selected-car' };
        const loadPromise = raceEngineMethods.loadCarSpriteAsset.call(
            engine,
            'assets/cars/selected.webp',
        );

        expect(engine.dailyCarousel.refreshPreviews).not.toHaveBeenCalled();
        expect(engine.campaignCarousel.refreshPreviews).not.toHaveBeenCalled();

        getCallbacks().onLoaded(selectedCar);
        await expect(loadPromise).resolves.toBe(selectedCar);

        expect(engine.carSprite).toBe(selectedCar);
        expect(engine.dailyCarousel.refreshPreviews).toHaveBeenCalledOnce();
        expect(engine.campaignCarousel.refreshPreviews).toHaveBeenCalledOnce();
        expect(engine.requestRender).toHaveBeenCalledOnce();
    });

    it('refreshes both previews back to their safe fallback when loading fails', async () => {
        const { engine, getCallbacks } = createEngine();
        const fallbackCar = engine.carSprite;
        const loadPromise = raceEngineMethods.loadCarSpriteAsset.call(
            engine,
            'assets/cars/unavailable.webp',
        );

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            getCallbacks().onError('assets/cars/unavailable.webp');
            await expect(loadPromise).resolves.toBe(fallbackCar);
        } finally {
            warn.mockRestore();
        }

        expect(engine.carSprite).toBe(fallbackCar);
        expect(engine.dailyCarousel.refreshPreviews).toHaveBeenCalledOnce();
        expect(engine.campaignCarousel.refreshPreviews).toHaveBeenCalledOnce();
        expect(engine.requestRender).not.toHaveBeenCalled();
    });

    it('does not repaint a stale skin after a newer Garage choice finishes first', async () => {
        const OriginalImage = globalThis.Image;
        const imageInstances = [];
        globalThis.Image = class ImageMock {
            constructor() {
                this.listeners = {};
                imageInstances.push(this);
            }

            addEventListener(type, handler) {
                this.listeners[type] = handler;
            }

            set src(value) {
                this._src = value;
            }

            get src() {
                return this._src;
            }
        };
        const { engine } = createEngine();
        engine.carSpriteLoader = new CarSpriteLoader();

        try {
            void raceEngineMethods.loadCarSpriteAsset.call(
                engine,
                'assets/cars/first.webp',
            );
            const latestPromise = raceEngineMethods.loadCarSpriteAsset.call(
                engine,
                'assets/cars/latest.webp',
            );

            imageInstances[1].listeners.load();
            await expect(latestPromise).resolves.toBe(imageInstances[1]);
            expect(engine.carSprite).toBe(imageInstances[1]);
            expect(engine.dailyCarousel.refreshPreviews).toHaveBeenCalledOnce();
            expect(engine.campaignCarousel.refreshPreviews).toHaveBeenCalledOnce();

            imageInstances[0].listeners.load();
            await Promise.resolve();
            await Promise.resolve();

            expect(engine.carSprite).toBe(imageInstances[1]);
            expect(engine.dailyCarousel.refreshPreviews).toHaveBeenCalledOnce();
            expect(engine.campaignCarousel.refreshPreviews).toHaveBeenCalledOnce();
        } finally {
            globalThis.Image = OriginalImage;
        }
    });
});
