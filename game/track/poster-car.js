import { CarSpriteLoader, STOCK_CAR_ASSET_NAME } from '../car/sprite.js';
import { getDefaultCarAssetForGround } from '../car/car-skin-grounds.js';
import { getTrackGround } from './grounds.js';

const POSTER_CAR_ENTRANCE_MS = 480;

export function posterCarTravelAt(elapsedMs, { reduceMotion = false } = {}) {
    if (reduceMotion) return 1;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
    const progress = Math.min(1, elapsedMs / POSTER_CAR_ENTRANCE_MS);
    return 1 - (1 - progress) ** 3;
}

export function prefersReducedPosterMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

// A post shows the default car of the track's ground, or the stock car.
export function getPosterCarAssetName(track) {
    return getDefaultCarAssetForGround(getTrackGround(track).key) ?? STOCK_CAR_ASSET_NAME;
}

export function loadPosterCar(track = null) {
    const assetName = getPosterCarAssetName(track);
    const loader = new CarSpriteLoader();
    return new Promise((resolve) => {
        loader.load(assetName, {
            onLoaded: resolve,
            onError: () => {
                console.warn(`Unable to load ${assetName} in the custom post preview.`);
                resolve(null);
            },
        });
    });
}

export function createPosterCarDrive(paint, {
    reduceMotion = prefersReducedPosterMotion(),
    now = () => performance.now(),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (frame) => cancelAnimationFrame(frame),
} = {}) {
    let image = null;
    let travel = 1;
    let frame = 0;

    const paintCurrent = () => paint(image, travel);

    const drive = (carImage) => {
        image = carImage || null;
        cancelFrame(frame);
        travel = posterCarTravelAt(0, { reduceMotion });
        paintCurrent();
        if (!image || travel >= 1) return;
        const startedAt = now();
        const step = (time) => {
            travel = posterCarTravelAt(time - startedAt, { reduceMotion });
            paintCurrent();
            if (travel < 1) frame = requestFrame(step);
        };
        frame = requestFrame(step);
    };

    return { drive, paintCurrent };
}
