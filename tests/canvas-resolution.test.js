import { describe, expect, it, vi } from 'vitest';
import {
    configureCanvasViewport,
    resolveCanvasViewport
} from '../game/track/canvas-resolution.js';

describe('canvas resolution helpers', () => {
    it('scales the backing store for high-density mobile screens', () => {
        expect(resolveCanvasViewport(390, 844, 3)).toEqual({
            cssWidth: 390,
            cssHeight: 844,
            devicePixelRatio: 2,
            pixelWidth: 780,
            pixelHeight: 1688
        });
    });

    it('falls back to a 1x backing store when the browser DPR is invalid', () => {
        expect(resolveCanvasViewport(320, 640, Number.NaN)).toEqual({
            cssWidth: 320,
            cssHeight: 640,
            devicePixelRatio: 1,
            pixelWidth: 320,
            pixelHeight: 640
        });
    });

    it('resizes the canvas and restores a CSS-pixel coordinate system', () => {
        const canvas = { width: 0, height: 0 };
        const ctx = { setTransform: vi.fn() };

        const viewport = configureCanvasViewport(canvas, ctx, 430, 932, 3);

        expect(viewport).toEqual({
            cssWidth: 430,
            cssHeight: 932,
            devicePixelRatio: 2,
            pixelWidth: 860,
            pixelHeight: 1864
        });
        expect(canvas.width).toBe(860);
        expect(canvas.height).toBe(1864);
        expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    });
});
