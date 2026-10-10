import { describe, expect, it } from 'vitest';
import { CONFIG } from '../game/config.js';
import { START_PICTURE_CAR_X, START_PICTURE_ZOOM, startPictureTransform } from '../game/ui/track-start-picture.js';

function apply({ a, b, c, d, e, f }, x, y) {
    return { x: a * x + c * y + e, y: b * x + d * y + f };
}

describe('Track start picture', () => {
    const track = { startPos: { x: 12.5, y: 25.25 }, startAngle: 1.766 };
    const gs = CONFIG.gridSize;

    it('puts the car on the middle line, at its share of the width', () => {
        const point = apply(startPictureTransform(track, 660, 220, 2), track.startPos.x * gs, track.startPos.y * gs);
        expect(point.x).toBeCloseTo(660 * START_PICTURE_CAR_X, 6);
        expect(point.y).toBeCloseTo(110, 6);
    });

    it('turns the track so that the car points to the right', () => {
        const transform = startPictureTransform(track, 660, 220, 2);
        const start = apply(transform, 0, 0);
        const ahead = apply(transform, Math.cos(track.startAngle), Math.sin(track.startAngle));
        expect(ahead.x - start.x).toBeCloseTo(START_PICTURE_ZOOM * 2, 6);
        expect(ahead.y - start.y).toBeCloseTo(0, 6);
    });
});
