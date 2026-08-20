import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTrackCanvasAsset } from '../game/track/assets.js';

// game/track/assets.js keeps at most CANVAS_CACHE_LIMIT (7) painted tracks.
const CANVAS_CACHE_LIMIT = 7;

function createStubContext() {
    return new Proxy({}, {
        get(target, property) {
            if (property === 'createLinearGradient' || property === 'createRadialGradient') {
                return () => ({ addColorStop: () => {} });
            }
            return () => {};
        },
        set() {
            return true;
        }
    });
}

function ring(radius) {
    return Array.from({ length: 16 }, (unused, index) => {
        const angle = (Math.PI * 2 * index) / 16;
        return { x: 30 + Math.cos(angle) * radius, y: 30 + Math.sin(angle) * radius };
    });
}

const track = {
    cornerRadius: 1.5,
    outer: ring(20),
    inner: ring(12),
    startLine: { p1: { x: 42, y: 30 }, p2: { x: 50, y: 30 } }
};

describe('track canvas cache', () => {
    beforeAll(() => {
        vi.stubGlobal('document', {
            createElement: () => ({ width: 0, height: 0, getContext: () => createStubContext() })
        });
        vi.stubGlobal('Path2D', class {
            moveTo() {}
            lineTo() {}
            closePath() {}
            arc() {}
            ellipse() {}
        });
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('leaves an evicted canvas usable for the race that still draws it', () => {
        // The engine reads the cache once, when the track loads, and then holds the
        // canvas itself for the whole race. The entry therefore ages to the oldest slot
        // while the race runs, and the next painted track evicts it. Blanking the canvas
        // on eviction blanked the track of the active race.
        const raced = getTrackCanvasAsset('raced-track', track, { presentation: { key: 'raced' } });
        const engineCanvas = raced.canvas;
        const racedWidth = engineCanvas.width;
        const racedHeight = engineCanvas.height;
        expect(racedWidth).toBeGreaterThan(0);

        for (let index = 0; index < CANVAS_CACHE_LIMIT; index += 1) {
            getTrackCanvasAsset(`filler-${index}`, track, { presentation: { key: `filler-${index}` } });
        }

        expect(engineCanvas.width).toBe(racedWidth);
        expect(engineCanvas.height).toBe(racedHeight);
    });

    it('still evicts the oldest track, so the cache stays bounded', () => {
        const first = getTrackCanvasAsset('bounded-track', track, { presentation: { key: 'bounded' } });

        for (let index = 0; index < CANVAS_CACHE_LIMIT; index += 1) {
            getTrackCanvasAsset(`bound-filler-${index}`, track, { presentation: { key: `bound-filler-${index}` } });
        }

        const reloaded = getTrackCanvasAsset('bounded-track', track, { presentation: { key: 'bounded' } });
        expect(reloaded.canvas).not.toBe(first.canvas);
    });
});
