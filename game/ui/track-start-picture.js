import { CONFIG } from '../config.js';
import { DRAWN_CAR_DRAW_PIXELS } from '../car/drawn-car/formula.js';
import { readPlayerCarDecalStyle } from '../car/player-car-decals.js';
import { readPlayerCarPaint } from '../car/player-car-paint.js';
import { readPlayerCarSkinAssetName } from '../car/player-car-skin.js';
import { CarSpriteLoader } from '../car/sprite.js';
import { getTrackPreviewGeometry } from '../track/assets.js';
import { buildTrackCanvas, drawViewportPresentationBackground } from '../track/canvas.js';
import { getLoadedClientTrack, loadClientTrack } from '../track/client-registry.js';
import { getTrackDefinitionIdentity } from '../track/definition-identity.js';
import { getTrackGround } from '../track/grounds.js';
import { plainRaceChallenge, resolveRacePresentation } from '../track/race-preparation.js';

// The start of a track as a Campaign race shows it: the player's car on the grid, nose to the right.

// Picture pixels per track pixel, at one picture pixel per CSS pixel.
export const START_PICTURE_ZOOM = 0.44;
// The car sits at this share of the picture width, on the middle line.
export const START_PICTURE_CAR_X = 0.62;
const PICTURE_CACHE_LIMIT = 16;

const pictures = new Map();
const carLoader = new CarSpriteLoader();
let buildQueue = Promise.resolve();

// The canvas transform from track pixels to picture pixels.
export function startPictureTransform(track, width, height, pixelScale = 1) {
    const gs = CONFIG.gridSize;
    const zoom = START_PICTURE_ZOOM * pixelScale;
    const turn = -(Number(track?.startAngle) || 0);
    const cos = Math.cos(turn) * zoom;
    const sin = Math.sin(turn) * zoom;
    const startX = (Number(track?.startPos?.x) || 0) * gs;
    const startY = (Number(track?.startPos?.y) || 0) * gs;
    return {
        a: cos,
        b: sin,
        c: -sin,
        d: cos,
        e: width * START_PICTURE_CAR_X - (cos * startX - sin * startY),
        f: height / 2 - (sin * startX + cos * startY),
    };
}

function playerCar(track) {
    const assetName = readPlayerCarSkinAssetName(getTrackGround(track).key);
    const paint = readPlayerCarPaint(assetName);
    const decalStyle = readPlayerCarDecalStyle(assetName);
    return { assetName, paint, decalStyle, key: JSON.stringify([assetName, paint, decalStyle]) };
}

function drawStartPicture(canvas, { track, trackCanvas, presentation, carImage, pixelScale }) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const { width, height } = canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawViewportPresentationBackground(ctx, width, height, { x: 0, y: 0 }, 1, presentation);
    const { a, b, c, d, e, f } = startPictureTransform(track, width, height, pixelScale);
    ctx.setTransform(a, b, c, d, e, f);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(trackCanvas.canvas, trackCanvas.origin.x, trackCanvas.origin.y);
    if (carImage) {
        const gs = CONFIG.gridSize;
        const size = DRAWN_CAR_DRAW_PIXELS * (CONFIG.carSpriteRenderScale ?? 1);
        ctx.translate(track.startPos.x * gs, track.startPos.y * gs);
        ctx.rotate(Number(track.startAngle) || 0);
        ctx.shadowColor = presentation?.carShadowColor ?? CONFIG.carSpriteShadowColor;
        ctx.shadowBlur = presentation?.carShadowBlur ?? CONFIG.carSpriteShadowBlur;
        ctx.shadowOffsetX = presentation?.carShadowOffsetX ?? CONFIG.carSpriteShadowOffsetX;
        ctx.shadowOffsetY = presentation?.carShadowOffsetY ?? CONFIG.carSpriteShadowOffsetY;
        ctx.drawImage(carImage, -size / 2, -size / 2, size, size);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return true;
}

// Pictures are made one at a time, with a pause before each, so a long list does not hold up a frame.
async function buildStartPicture({ trackKey, track, presentation, car, width, height, pixelScale }) {
    const carRecord = carLoader.prefetch(car.assetName, { paint: car.paint, decalStyle: car.decalStyle });
    const carImage = carRecord?.promise ? await carRecord.promise.catch(() => null) : null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const trackCanvas = buildTrackCanvas(track, getTrackPreviewGeometry(trackKey, track), presentation);
    if (!trackCanvas.canvas) return null;
    const picture = document.createElement('canvas');
    picture.width = width;
    picture.height = height;
    return drawStartPicture(picture, { track, trackCanvas, presentation, carImage, pixelScale }) ? picture : null;
}

function queueStartPicture(options) {
    const picture = buildQueue.then(() => buildStartPicture(options));
    buildQueue = picture.catch((error) => {
        console.error('Could not draw the track start picture:', error);
        return null;
    });
    return buildQueue;
}

// Draws the start of the track into the canvas; the same track, look, car and size use one saved picture.
export function renderTrackStartPicture(canvas, trackKey, { pixelScale = 1 } = {}) {
    if (!canvas || !trackKey) return;
    const track = getLoadedClientTrack(trackKey);
    if (!track) {
        void loadClientTrack(trackKey).then(() => {
            if (getLoadedClientTrack(trackKey)) renderTrackStartPicture(canvas, trackKey, { pixelScale });
        }).catch(() => {});
        return;
    }
    const presentation = resolveRacePresentation(trackKey, track, plainRaceChallenge(trackKey));
    const car = playerCar(track);
    const { width, height } = canvas;
    const key = [
        trackKey,
        getTrackDefinitionIdentity(track),
        presentation?.key || 'default',
        car.key,
        `${width}x${height}`,
    ].join(':');
    if (canvas.dataset.pictureKey === key) return;
    canvas.dataset.pictureKey = key;

    let picture = pictures.get(key);
    if (picture) {
        pictures.delete(key);
    } else {
        picture = queueStartPicture({ trackKey, track, presentation, car, width, height, pixelScale });
    }
    pictures.set(key, picture);
    while (pictures.size > PICTURE_CACHE_LIMIT) pictures.delete(pictures.keys().next().value);

    void picture.then((image) => {
        if (!image || canvas.dataset.pictureKey !== key) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0);
    });
}
