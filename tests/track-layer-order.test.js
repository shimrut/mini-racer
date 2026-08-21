import { describe, expect, it, vi } from 'vitest';
import { TrackLayerRenderer } from '../game/track/layer.js';

function createContext() {
    const operations = [];
    const ctx = {
        operations,
        set fillStyle(value) { this._fillStyle = value; },
        get fillStyle() { return this._fillStyle; },
        fillRect: vi.fn(() => operations.push('base')),
        fill: vi.fn(() => operations.push(`fill:${ctx.fillStyle}`)),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        drawImage: vi.fn(() => operations.push('track')),
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        lineJoin: 'round',
        lineCap: 'round',
    };
    return ctx;
}

describe('track layer environment order', () => {
  it('renders authored Forest features, then shoulder, then track with nothing after it', () => {
        const ctx = createContext();
        const renderer = new TrackLayerRenderer(ctx);
        const propPath = { id: 'prop' };

        renderer.draw({
            camera: { x: 0, y: 0 },
            zoom: 1,
            viewportWidth: 320,
            viewportHeight: 200,
            devicePixelRatio: 1,
            trackCanvas: { width: 400, height: 300 },
            trackCanvasOrigin: { x: 0, y: 0 },
            presentation: {
                backgroundStyle: 'biome',
                biomeGround: '#base',
            },
            backdrop: {
                configId: 'forest',
                compositionRecipe: 'FOREST_A',
                groundColor: '#base',
                largeFeatures: [{
                    minX: 40,
                    minY: 40,
                    maxX: 80,
                    maxY: 80,
                    layers: [{ path: propPath, style: '#large' }],
                }],
                mediumFeatures: [{ minX: 40, minY: 40, maxX: 80, maxY: 80, layers: [{ path: propPath, style: '#medium' }] }],
                smallFeatures: [{ minX: 40, minY: 40, maxX: 80, maxY: 80, layers: [{ path: propPath, style: '#small' }] }],
                shoulder: { tiles: [{ minX: 40, minY: 40, maxX: 80, maxY: 80, path: propPath, style: '#shoulder' }] },
                props: [],
            },
            detailTier: 2,
            container: { clientWidth: 320, clientHeight: 200 },
        });

        expect(ctx.operations).toEqual([
          'base', 'fill:#large', 'fill:#medium', 'fill:#small', 'fill:#shoulder', 'track',
        ]);
        expect(ctx.drawImage).toHaveBeenCalledOnce();
    });

    it('still paints props when the camera is outside the raster track bounds', () => {
        const ctx = createContext();
        const renderer = new TrackLayerRenderer(ctx);
        renderer.draw({
            camera: { x: 1000, y: 1000 },
            zoom: 1,
            viewportWidth: 320,
            viewportHeight: 200,
            devicePixelRatio: 1,
            trackCanvas: { width: 20, height: 20 },
            trackCanvasOrigin: { x: 0, y: 0 },
            presentation: { backgroundStyle: 'biome', biomeGround: '#base' },
            backdrop: {
                groundColor: '#base',
                terrain: [],
                transition: [],
                runoff: [],
                features: [],
                props: [{
                    minX: 1000,
                    minY: 1000,
                    maxX: 1100,
                    maxY: 1100,
                    priority: 1,
                    layers: [{ path: { id: 'far-prop' }, style: '#prop' }],
                }],
            },
            detailTier: 2,
            container: { clientWidth: 320, clientHeight: 200 },
        });

        expect(ctx.operations).toContain('base');
        expect(ctx.operations).toContain('fill:#prop');
    });
});
