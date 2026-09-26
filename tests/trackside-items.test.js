import { describe, expect, it } from 'vitest';
import { TRACKSIDE_ITEMS, getTracksideItemsExtent } from '../game/track/trackside-items.js';
import { resolveTrackPresentation } from '../game/track/presentation.js';

function createRecordingContext() {
    const calls = { fill: 0, stroke: 0, points: [] };
    const record = (x, y) => calls.points.push([x, y]);
    // translate and rotate move the points the way the canvas does.
    let origin = { x: 0, y: 0, angle: 0 };
    const stack = [];
    const place = (x, y) => {
        const cos = Math.cos(origin.angle);
        const sin = Math.sin(origin.angle);
        record(origin.x + x * cos - y * sin, origin.y + x * sin + y * cos);
    };
    const ctx = {
        calls,
        save() { stack.push({ ...origin }); },
        restore() { origin = stack.pop(); },
        translate(x, y) { origin = { ...origin, x: origin.x + x, y: origin.y + y }; },
        rotate(angle) { origin = { ...origin, angle: origin.angle + angle }; },
        beginPath() {}, closePath() {},
        moveTo: place, lineTo: place,
        arcTo(x1, y1, x2, y2) { place(x1, y1); place(x2, y2); },
        arc(x, y, radius) { place(x - radius, y - radius); place(x + radius, y + radius); },
        fill() { calls.fill += 1; },
        stroke() { calls.stroke += 1; },
    };
    return ctx;
}

describe('trackside items', () => {
    it('has every item that a ground asks for', () => {
        for (const ground of ['dirt', 'snow']) {
            const look = resolveTrackPresentation('circuit', { ground });
            for (const [name, weight] of look.tracksideItems) {
                expect(TRACKSIDE_ITEMS[name]).toBeTruthy();
                expect(weight).toBeGreaterThan(0);
            }
            expect(TRACKSIDE_ITEMS[look.finishMarker].flag).toBe(true);
        }
    });

    it('draws each item inside its reach, with its shadow', () => {
        let seed = 7;
        const random = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };
        for (const [name, item] of Object.entries(TRACKSIDE_ITEMS)) {
            const ctx = createRecordingContext();
            item.draw(ctx, 100, 100, item.maxSize, { random, facing: Math.PI / 2 });

            expect(ctx.calls.fill, name).toBeGreaterThan(2);
            // What the track image leaves room for, from the road edge.
            const limit = getTracksideItemsExtent([name]);
            for (const [x, y] of ctx.calls.points) {
                expect(Math.abs(x - 100), name).toBeLessThanOrEqual(limit);
                expect(Math.abs(y - 100), name).toBeLessThanOrEqual(limit);
            }
        }
    });
});
