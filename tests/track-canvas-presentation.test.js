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
    it('keeps space backgrounds flat so rails sit over stars without a center glow', () => {
        const staticCtx = createContext();
        const movingCtx = createContext();

        drawPresentationBackground(staticCtx, 320, 200, {
            backgroundStyle: 'space',
            offTrackColor: '#050816'
        }, 'test-seed');
        drawViewportPresentationBackground(movingCtx, 320, 200, { x: 0, y: 0 }, 1, {
            backgroundStyle: 'space',
            offTrackColor: '#050816',
            key: 'test-space'
        });

        expect(staticCtx.createRadialGradient).not.toHaveBeenCalled();
        expect(movingCtx.createRadialGradient).not.toHaveBeenCalled();
    });

    it('moves space backgrounds on a slower plane when the presentation sets parallax', () => {
        const fullSpeedCtx = createContext();
        const parallaxCtx = createContext();
        const camera = { x: 256, y: 144 };

        drawViewportPresentationBackground(fullSpeedCtx, 320, 200, camera, 1, {
            backgroundStyle: 'space',
            offTrackColor: '#050816',
            key: 'test-space'
        });
        drawViewportPresentationBackground(parallaxCtx, 320, 200, camera, 1, {
            backgroundStyle: 'space',
            offTrackColor: '#050816',
            key: 'test-space',
            backgroundParallaxFactor: 0.4
        });

        expect(fullSpeedCtx.arc).toHaveBeenCalled();
        expect(parallaxCtx.arc).toHaveBeenCalled();
        expect(parallaxCtx.arc.mock.calls[0]?.[0]).not.toBe(fullSpeedCtx.arc.mock.calls[0]?.[0]);
        expect(parallaxCtx.arc.mock.calls[0]?.[1]).not.toBe(fullSpeedCtx.arc.mock.calls[0]?.[1]);
    });

    it('renders desert as a simple static sand fill with no extra effects', () => {
        const staticCtx = createContext();
        const movingCtx = createContext();

        drawPresentationBackground(staticCtx, 320, 200, {
            backgroundStyle: 'desert',
            offTrackColor: '#8d6a3b',
            key: 'test-desert'
        }, 'desert-seed');
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

    it('keeps rail tracks transparent so only the rails are rendered', () => {
        const ctx = createContext();

        fillTrackPresentation(ctx, { id: 'surface' }, { id: 'inner' }, { id: 'outer' }, 320, 200, {
            trackStyle: 'rails',
            trackColor: 'transparent',
            infieldColor: 'transparent'
        });

        expect(ctx.fill).not.toHaveBeenCalled();
    });

    it('draws both boundary rails for rail-only track skins', () => {
        const ctx = createContext();
        const outerPath = { id: 'outer' };
        const innerPath = { id: 'inner' };

        drawTrackBoundaries(ctx, outerPath, innerPath, {
            trackStyle: 'rails',
            outerStrokeColor: '#f8feff',
            innerStrokeColor: '#f8feff'
        });

        expect(ctx.save).toHaveBeenCalled();
        expect(ctx.restore).toHaveBeenCalled();
        expect(ctx.stroke.mock.calls.length).toBeGreaterThan(2);
        expect(ctx.stroke).toHaveBeenCalledWith(outerPath);
        expect(ctx.stroke).toHaveBeenCalledWith(innerPath);
    });

    it('adds layered vapor passes for rail skins when configured', () => {
        const ctx = createContext();
        const outerPath = { id: 'outer' };
        const innerPath = { id: 'inner' };

        drawTrackBoundaries(ctx, outerPath, innerPath, {
            trackStyle: 'rails',
            railVaporLayers: [
                { color: 'rgba(56, 189, 248, 0.08)', width: 64, blur: 34 },
                { color: 'rgba(96, 165, 250, 0.1)', width: 40, blur: 22 },
                { color: 'rgba(147, 197, 253, 0.12)', width: 24, blur: 14 }
            ],
            railBandWidth: 10,
            railMidWidth: 6,
            railCoreWidth: 2.5
        });

        expect(ctx.stroke.mock.calls.length).toBeGreaterThan(10);
        expect(ctx.save).toHaveBeenCalled();
        expect(ctx.restore).toHaveBeenCalled();
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

    it('renders Kettle Run debris as thinner shard-like fragments when configured', () => {
        const ctx = createContext();
        const points = [
            { x: 0, y: 0 },
            { x: 12, y: 0 },
            { x: 12, y: 8 },
            { x: 0, y: 8 }
        ];
        const presentation = {
            key: 'test-kettle-run-shards',
            debrisStyle: 'outer-drift',
            debrisStrokeWidth: 0.9,
            debrisSidesMin: 3,
            debrisSidesMax: 3
        };
        const mapTrackPoint = (point) => point;

        drawOuterDebris(ctx, points, mapTrackPoint, presentation);

        expect(ctx.lineWidth).toBe(0.9);
        expect(ctx.lineTo).toHaveBeenCalledTimes(84);
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

    it('renders rail finish lines as neon gates when configured', () => {
        const ctx = createContext();

        drawTrackFinishLine(ctx, { x: 24, y: 18 }, { x: 24, y: 74 }, 10, {
            finishLineStyle: 'neon-gate',
            finishLineColor: '#e0f2fe',
            finishLineAltColor: 'rgba(125, 211, 252, 0.92)',
            finishLineGlowColor: 'rgba(56, 189, 248, 0.32)',
            finishLineBeaconColor: 'rgba(224, 242, 254, 0.9)'
        });

        expect(ctx.createLinearGradient).toHaveBeenCalled();
        expect(ctx.createRadialGradient).toHaveBeenCalledTimes(2);
        expect(ctx.setLineDash).toHaveBeenCalled();
        expect(ctx.stroke.mock.calls.length).toBeGreaterThanOrEqual(5);
        expect(ctx.arc).toHaveBeenCalled();
    });
});
