import { describe, expect, it, vi } from 'vitest';
import {
    drawInnerDebris,
    drawOuterDebris,
    drawPresentationBackground,
    drawTrackBoundaries,
    drawTrackFinishLine,
    drawViewportPresentationBackground,
    fillTrackPresentation
} from '../game/track/canvas.js';

function createContext() {
    return {
        fill: vi.fn(),
        fillRect: vi.fn(),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        setLineDash: vi.fn(),
        lineWidth: 1,
        lineJoin: 'round',
        strokeStyle: '',
        fillStyle: '',
        shadowColor: '',
        shadowBlur: 0,
        globalAlpha: 1,
        beginPath: vi.fn(),
        arc: vi.fn(),
        ellipse: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() }))
    };
}

describe('track canvas presentation', () => {
    it('uses a flat fill for standard backgrounds', () => {
        const staticCtx = createContext();
        const movingCtx = createContext();

        drawPresentationBackground(staticCtx, 320, 200, {
            backgroundStyle: 'flat',
            offTrackColor: '#050816'
        });
        drawViewportPresentationBackground(movingCtx, 320, 200, { x: 0, y: 0 }, 1, {
            backgroundStyle: 'flat',
            offTrackColor: '#050816',
            key: 'test-flat'
        });

        expect(staticCtx.fillRect).toHaveBeenCalledWith(0, 0, 320, 200);
        expect(movingCtx.fillRect).toHaveBeenCalledWith(0, 0, 320, 200);
        expect(staticCtx.createRadialGradient).not.toHaveBeenCalled();
        expect(movingCtx.createRadialGradient).not.toHaveBeenCalled();
    });

    it('renders desert as a simple static sand fill with no extra effects', () => {
        const staticCtx = createContext();
        const movingCtx = createContext();

        drawPresentationBackground(staticCtx, 320, 200, {
            backgroundStyle: 'desert',
            offTrackColor: '#8d6a3b',
            key: 'test-desert'
        });
        drawViewportPresentationBackground(movingCtx, 320, 200, { x: 120, y: 80 }, 1, {
            backgroundStyle: 'desert',
            offTrackColor: '#8d6a3b',
            key: 'test-desert'
        });

        expect(staticCtx.fillRect).toHaveBeenCalled();
        expect(staticCtx.createLinearGradient).not.toHaveBeenCalled();
        expect(staticCtx.ellipse).not.toHaveBeenCalled();
        expect(staticCtx.createRadialGradient).not.toHaveBeenCalled();
        expect(movingCtx.fillRect).toHaveBeenCalled();
        expect(movingCtx.createLinearGradient).not.toHaveBeenCalled();
        expect(movingCtx.ellipse).not.toHaveBeenCalled();
        expect(movingCtx.createRadialGradient).not.toHaveBeenCalled();
    });

    it('fills normal track surfaces and infields', () => {
        const ctx = createContext();
        const surfacePath = { id: 'surface' };
        const innerPath = { id: 'inner' };

        fillTrackPresentation(ctx, surfacePath, innerPath, { id: 'outer' }, 320, 200, {
            trackColor: '#334155',
            infieldColor: '#0f172a'
        });

        expect(ctx.fill).toHaveBeenCalledWith(surfacePath, 'evenodd');
        expect(ctx.fill).toHaveBeenCalledWith(innerPath);
    });

    it('draws layered canyon walls for canyon-style desert track edges', () => {
        const ctx = createContext();
        const outerPath = { id: 'outer' };
        const innerPath = { id: 'inner' };

        drawTrackBoundaries(ctx, outerPath, innerPath, {
            trackStyle: 'canyon',
            outerStrokeColor: '#d7b07a',
            innerStrokeColor: '#6f4a2b',
            canyonWallShadowColor: 'rgba(58, 34, 18, 0.28)',
            canyonWallShadowWidth: 16,
            canyonWallHighlightColor: 'rgba(245, 221, 182, 0.4)',
            canyonWallHighlightWidth: 7,
            canyonWallCoreColor: '#6f4a2b',
            canyonWallCoreWidth: 3
        });

        expect(ctx.save).toHaveBeenCalled();
        expect(ctx.restore).toHaveBeenCalled();
        expect(ctx.stroke.mock.calls.length).toBeGreaterThan(4);
        expect(ctx.stroke).toHaveBeenCalledWith(outerPath);
        expect(ctx.stroke).toHaveBeenCalledWith(innerPath);
    });

    it('renders debris on both outer and inner boundaries when the presentation requests it', () => {
        const ctx = createContext();
        const points = [
            { x: 0, y: 0 },
            { x: 12, y: 0 },
            { x: 12, y: 8 },
            { x: 0, y: 8 }
        ];
        const presentation = {
            key: 'test-kettle-run',
            debrisStyle: 'outer-drift'
        };
        const mapTrackPoint = (point) => point;

        drawOuterDebris(ctx, points, mapTrackPoint, presentation);
        drawInnerDebris(ctx, points, mapTrackPoint, presentation);

        expect(ctx.stroke).toHaveBeenCalled();
        expect(ctx.beginPath).toHaveBeenCalled();
    });

    it('renders desert debris as chunkier rock-like fragments when configured', () => {
        const ctx = createContext();
        const points = [
            { x: 0, y: 0 },
            { x: 12, y: 0 },
            { x: 12, y: 8 },
            { x: 0, y: 8 }
        ];
        const presentation = {
            key: 'test-kettle-run-rocks',
            debrisStyle: 'outer-drift',
            debrisStrokeWidth: 1.4,
            debrisSidesMin: 6,
            debrisSidesMax: 6,
            debrisStretchMin: 1,
            debrisStretchMax: 1.35
        };
        const mapTrackPoint = (point) => point;

        drawOuterDebris(ctx, points, mapTrackPoint, presentation);

        expect(ctx.lineWidth).toBe(1.4);
        expect(ctx.lineTo).toHaveBeenCalledTimes(210);
    });

    it('renders finish lines as checkered lines using presentation colors', () => {
        const ctx = createContext();

        drawTrackFinishLine(ctx, { x: 24, y: 18 }, { x: 24, y: 74 }, 10, {
            finishLineColor: '#f6e7c5',
            finishLineAltColor: '#5b4127'
        });

        expect(ctx.setLineDash).not.toHaveBeenCalled();
        expect(ctx.stroke).not.toHaveBeenCalled();
        expect(ctx.fill).toHaveBeenCalled();
    });

    it('paints an uneven finish line with one fill for each colour', () => {
        const fills = [];
        const points = [];
        const ctx = {
            ...createContext(),
            moveTo: (x, y) => points.push([x, y]),
            lineTo: (x, y) => points.push([x, y]),
            fill() { fills.push(this.fillStyle); },
        };
        const look = {
            key: 'test-painted',
            finishLineStyle: 'painted',
            finishLineColor: '#2d5b8c',
            finishLineAltColor: '#eef4f9'
        };

        drawTrackFinishLine(ctx, { x: 24, y: 18 }, { x: 24, y: 74 }, 14, look);
        expect(fills).toEqual(['#eef4f9', '#2d5b8c']);
        // The squares stay close to the line: 7 px to each side, and a little more.
        for (const [x] of points) expect(Math.abs(x - 24)).toBeLessThan(9);
        // The corners move, so the squares are not all straight.
        expect(new Set(points.map(([x]) => x.toFixed(2))).size).toBeGreaterThan(3);

        fills.length = 0;
        drawTrackFinishLine(ctx, { x: 24, y: 18 }, { x: 24, y: 74 }, 14, { ...look, finishLineAltColor: null });
        expect(fills).toEqual(['#2d5b8c']);
    });
});
