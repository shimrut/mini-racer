import { CarSpriteLoader, STOCK_CAR_ASSET_NAME } from '../car/sprite.js';

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

export function loadPosterCar() {
    const loader = new CarSpriteLoader();
    return new Promise((resolve) => {
        loader.load(STOCK_CAR_ASSET_NAME, {
            onLoaded: resolve,
            onError: () => {
                console.warn(`Unable to load ${STOCK_CAR_ASSET_NAME} in the custom post preview.`);
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
