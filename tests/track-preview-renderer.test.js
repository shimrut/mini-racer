import { describe, expect, it, vi } from 'vitest';
import { renderTrackPreviewCanvas } from '../game/track/preview-renderer.js';

function createPreviewContext() {
    const createGradient = () => ({
        addColorStop: vi.fn()
    });
    const fillStyles = [];
    return {
        __fillStyles: fillStyles,
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(function fill() {
            fillStyles.push(this.fillStyle);
        }),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        arc: vi.fn(),
        clip: vi.fn(),
        strokeRect: vi.fn(),
        createLinearGradient: vi.fn(createGradient),
        createRadialGradient: vi.fn(createGradient),
        drawImage: vi.fn(),
        scale: vi.fn(),
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        shadowColor: 'transparent',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        lineCap: 'round',
        lineJoin: 'round',
        lineWidth: 1,
        lineDashOffset: 0,
        setLineDash: vi.fn(),
        fillStyle: '',
        strokeStyle: ''
    };
}

describe('track preview rendering', () => {
    it('keeps the preview canvas background transparent for track cards', () => {
        const OriginalPath2D = global.Path2D;
        global.Path2D = class Path2DMock {
            addPath() {}
            moveTo() {}
            lineTo() {}
            quadraticCurveTo() {}
            closePath() {}
        };
        const ctx = createPreviewContext();
        const canvas = {
            width: 320,
            height: 200,
            getContext: vi.fn(() => ctx)
        };

        renderTrackPreviewCanvas(canvas, {
            trackGeometry: {
                outer: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 8 },
                    { x: 0, y: 8 }
                ],
                inner: [
                    { x: 3, y: 3 },
                    { x: 7, y: 3 },
                    { x: 7, y: 5 },
                    { x: 3, y: 5 }
                ]
            },
            presentation: {
                offTrackColor: '#654321',
                trackColor: '#777777',
                infieldColor: '#222222'
            },
            startLine: {
                p1: { x: 1, y: 1 },
                p2: { x: 1, y: 3 }
            },
            startPos: { x: 2, y: 2 },
            startAngle: 0,
            transparentBackground: true,
            runHistory: []
        });

        expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 320, 200);
        expect(ctx.fillRect).not.toHaveBeenCalled();
        expect(ctx.__fillStyles).toContain('#777777');
        expect(ctx.__fillStyles).toContain('#222222');
        global.Path2D = OriginalPath2D;
    });

    it('shows the custom-post car asset and trail past the starting line', () => {
        const OriginalPath2D = global.Path2D;
        global.Path2D = class Path2DMock {
            addPath() {}
            moveTo() {}
            lineTo() {}
            quadraticCurveTo() {}
            closePath() {}
        };
        const ctx = createPreviewContext();
        const carImage = { width: 500, height: 500 };
        const canvas = {
            width: 320,
            height: 200,
            getContext: vi.fn(() => ctx)
        };

        renderTrackPreviewCanvas(canvas, {
            trackGeometry: {
                outer: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 8 },
                    { x: 0, y: 8 }
                ],
                inner: [
                    { x: 3, y: 3 },
                    { x: 7, y: 3 },
                    { x: 7, y: 5 },
                    { x: 3, y: 5 }
                ]
            },
            presentation: {},
            startLine: {
                p1: { x: 1, y: 1 },
                p2: { x: 1, y: 3 }
            },
            startPos: { x: 0.5, y: 2 },
            startAngle: 0,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            showSchematicCarTrail: true,
            moveSchematicCarPastStartLine: true,
            schematicCarImage: carImage,
            hideSchematicStartArrow: true
        });

        const markerTranslations = ctx.translate.mock.calls.filter(([, y]) => y > 40 && y < 80);
        expect(markerTranslations).toHaveLength(2);
        expect(markerTranslations[0][0]).toBeGreaterThan(85);
        expect(markerTranslations[1]).toEqual(markerTranslations[0]);
        expect(ctx.drawImage).toHaveBeenCalledOnce();
        expect(ctx.drawImage.mock.calls[0][0]).toBe(carImage);
        expect(ctx.strokeStyle).toBe('rgba(239, 68, 68, 0.78)');
        expect(ctx.lineWidth).toBeGreaterThanOrEqual(1.5);
        global.Path2D = OriginalPath2D;
    });

    it('draws podium schematic car paths under the cars', () => {
        const OriginalPath2D = global.Path2D;
        global.Path2D = class Path2DMock {
            addPath() {}
            moveTo() {}
            lineTo() {}
            quadraticCurveTo() {}
            closePath() {}
        };
        const ctx = createPreviewContext();
        const carImage = { width: 500, height: 500 };
        const canvas = {
            width: 320,
            height: 200,
            getContext: vi.fn(() => ctx)
        };

        renderTrackPreviewCanvas(canvas, {
            trackGeometry: {
                outer: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 8 },
                    { x: 0, y: 8 }
                ],
                inner: [
                    { x: 3, y: 3 },
                    { x: 7, y: 3 },
                    { x: 7, y: 5 },
                    { x: 3, y: 5 }
                ]
            },
            presentation: {},
            startLine: { p1: { x: 1, y: 1 }, p2: { x: 1, y: 3 } },
            startPos: { x: 0.5, y: 2 },
            startAngle: 0,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            hideSchematicStartArrow: true,
            schematicCars: [{
                image: carImage,
                x: 4,
                y: 4,
                angle: 0,
                trail: [{ x: 1, y: 2 }, { x: 4, y: 4 }],
                trailStyle: 'rgba(240, 200, 90, 0.82)',
            }],
        });

        expect(ctx.strokeStyle).toBe('rgba(240, 200, 90, 0.82)');
        expect(ctx.drawImage).toHaveBeenCalledOnce();
        global.Path2D = OriginalPath2D;
    });

    it('replaces the lobby arrow with the selected car at the exact start pose', () => {
        const OriginalPath2D = global.Path2D;
        global.Path2D = class Path2DMock {
            addPath() {}
            moveTo() {}
            lineTo() {}
            quadraticCurveTo() {}
            closePath() {}
        };
        const ctx = createPreviewContext();
        const carImage = { width: 500, height: 500 };
        const canvas = {
            width: 320,
            height: 200,
            getContext: vi.fn(() => ctx)
        };

        renderTrackPreviewCanvas(canvas, {
            trackGeometry: {
                outer: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 8 },
                    { x: 0, y: 8 }
                ],
                inner: [
                    { x: 3, y: 3 },
                    { x: 7, y: 3 },
                    { x: 7, y: 5 },
                    { x: 3, y: 5 }
                ]
            },
            presentation: {},
            startLine: {
                p1: { x: 1, y: 1 },
                p2: { x: 1, y: 3 }
            },
            startPos: { x: 0.5, y: 2 },
            startAngle: 0.75,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            schematicCarImage: carImage,
            schematicCarWorldSize: { width: 1.3, height: 1.3 },
            hideSchematicStartArrow: true
        });

        expect(ctx.translate).toHaveBeenCalledOnce();
        expect(ctx.rotate).toHaveBeenCalledOnce();
        expect(ctx.rotate).toHaveBeenCalledWith(0.75);
        expect(ctx.drawImage).toHaveBeenCalledOnce();
        expect(ctx.drawImage.mock.calls[0][0]).toBe(carImage);
        expect(ctx.drawImage.mock.calls[0][3]).toBeCloseTo(27.3);
        expect(ctx.drawImage.mock.calls[0][4]).toBeCloseTo(27.3);
        expect(ctx.__fillStyles).not.toContain('#dc5a5a');
        global.Path2D = OriginalPath2D;
    });

    it('draws multiple schematic replay cars from world positions', () => {
        const OriginalPath2D = global.Path2D;
        global.Path2D = class Path2DMock {
            addPath() {}
            moveTo() {}
            lineTo() {}
            closePath() {}
        };
        const ctx = createPreviewContext();
        const canvas = {
            width: 320,
            height: 200,
            getContext: vi.fn(() => ctx)
        };
        const gold = { id: 'gold' };
        const arctic = { id: 'arctic' };

        renderTrackPreviewCanvas(canvas, {
            trackGeometry: {
                outer: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 8 },
                    { x: 0, y: 8 }
                ],
                inner: [
                    { x: 3, y: 3 },
                    { x: 7, y: 3 },
                    { x: 7, y: 5 },
                    { x: 3, y: 5 }
                ]
            },
            presentation: {},
            startPos: { x: 0.5, y: 2 },
            startAngle: 0,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            hideSchematicStartArrow: true,
            schematicCars: [
                { image: arctic, x: 4, y: 4, angle: 0.2 },
                { image: gold, x: 5, y: 4, angle: 0.4 },
            ]
        });

        expect(ctx.drawImage).toHaveBeenCalledTimes(2);
        expect(ctx.drawImage.mock.calls[0][0]).toBe(arctic);
        expect(ctx.drawImage.mock.calls[1][0]).toBe(gold);
        global.Path2D = OriginalPath2D;
    });
});
