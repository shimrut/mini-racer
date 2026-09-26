import { describe, expect, it, vi } from 'vitest';
import { drawOuterDebris, getTrackCanvasPadding } from '../game/track/canvas.js';
import { CONFIG } from '../game/config.js';
import { TRACKSIDE_ITEMS } from '../game/track/trackside-items.js';

const DESERT_DEBRIS_PRESENTATION = {
    key: 'event:daily-challenge:kettleRun:desert',
    showCurbs: false,
    showTireWalls: false,
    trackStyle: 'canyon',
    canyonWallShadowWidth: 0,
    canyonWallHighlightWidth: 7,
    canyonWallCoreWidth: 3,
    debrisStyle: 'outer-drift',
    debrisMinRadius: 6,
    debrisMaxRadius: 15,
    debrisStrokeWidth: 1.4,
    debrisStretchMin: 1,
    debrisStretchMax: 1.35
};

function createRecordingContext(points) {
    const record = (x, y) => points.push([x, y]);
    return {
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        moveTo: vi.fn(record),
        lineTo: vi.fn(record),
        lineWidth: 1,
        lineJoin: 'round',
        strokeStyle: '',
        fillStyle: ''
    };
}

function ring(count, radius) {
    return Array.from({ length: count }, (_, i) => {
        const angle = (Math.PI * 2 * i) / count;
        return { x: 20 + Math.cos(angle) * radius, y: 20 + Math.sin(angle) * radius };
    });
}

describe('track canvas padding', () => {
    it('contains every debris mark inside the canvas it sizes', () => {
        const gs = CONFIG.gridSize;
        const padding = getTrackCanvasPadding(DESERT_DEBRIS_PRESENTATION);

        for (const pointCount of [8, 17, 24, 33, 48]) {
            const outer = ring(pointCount, 14);
            const xs = outer.map((p) => p.x * gs);
            const ys = outer.map((p) => p.y * gs);
            const minX = Math.min(...xs);
            const minY = Math.min(...ys);
            const width = Math.ceil(Math.max(...xs) - minX + padding * 2);
            const height = Math.ceil(Math.max(...ys) - minY + padding * 2);

            const mapTrackPoint = (point) => ({
                x: point.x * gs - minX + padding,
                y: point.y * gs - minY + padding
            });

            const drawn = [];
            drawOuterDebris(
                createRecordingContext(drawn),
                outer,
                mapTrackPoint,
                DESERT_DEBRIS_PRESENTATION
            );

            expect(drawn.length).toBeGreaterThan(0);
            for (const [x, y] of drawn) {
                expect(x).toBeGreaterThanOrEqual(0);
                expect(y).toBeGreaterThanOrEqual(0);
                expect(x).toBeLessThanOrEqual(width);
                expect(y).toBeLessThanOrEqual(height);
            }
        }
    });

    it('reserves only what the enabled decorations need', () => {
        const bare = getTrackCanvasPadding({ showCurbs: false, showTireWalls: false });
        const withTireWalls = getTrackCanvasPadding({ showCurbs: false, showTireWalls: true });
        const withDebris = getTrackCanvasPadding(DESERT_DEBRIS_PRESENTATION);

        expect(bare).toBeLessThan(withTireWalls);
        expect(withTireWalls).toBeLessThan(withDebris);
        expect(withDebris).toBeLessThan(CONFIG.gridSize * 5);
    });

    it('grows when a presentation asks for larger debris', () => {
        const base = getTrackCanvasPadding(DESERT_DEBRIS_PRESENTATION);
        const bigger = getTrackCanvasPadding({
            ...DESERT_DEBRIS_PRESENTATION,
            debrisMaxRadius: 40,
            debrisStretchMax: 2.5
        });

        expect(bigger).toBeGreaterThan(base);
    });

    it('leaves room for the snow banks outside the road', () => {
        const bare = { showCurbs: false, showTireWalls: false };
        const banks = getTrackCanvasPadding({ ...bare, bankColor: '#e2ebf3', bankWidth: 20 });
        const noColor = getTrackCanvasPadding({ ...bare, bankWidth: 20 });

        expect(banks).toBeGreaterThan(20);
        expect(noColor).toBe(getTrackCanvasPadding(bare));
    });

    it('leaves room for the trees and igloos beside the road', () => {
        const bare = { showCurbs: false, showTireWalls: false };
        const trees = getTrackCanvasPadding({ ...bare, tracksideItems: [['tree', 1]] });
        const igloos = getTrackCanvasPadding({ ...bare, tracksideItems: [['bush', 1], ['igloo', 1]] });
        const withBank = getTrackCanvasPadding({ ...bare, tracksideItems: [['tree', 1]], bankColor: '#9c7b56', bankWidth: 20 });

        expect(trees).toBeGreaterThan(2 * TRACKSIDE_ITEMS.tree.maxSize);
        expect(igloos).toBeGreaterThan(2 * TRACKSIDE_ITEMS.igloo.maxSize * TRACKSIDE_ITEMS.igloo.reach);
        expect(igloos).toBeGreaterThan(trees);
        expect(withBank).toBeGreaterThan(trees);
        expect(getTrackCanvasPadding({ ...bare, tracksideItems: [] })).toBe(getTrackCanvasPadding(bare));
        expect(getTrackCanvasPadding({ ...bare, finishMarker: 'hayBale' })).toBeGreaterThan(getTrackCanvasPadding(bare));
    });

    it('ignores debris sizing when the presentation paints no debris', () => {
        const withoutDebris = getTrackCanvasPadding({
            showCurbs: true,
            showTireWalls: true,
            debrisMaxRadius: 40,
            debrisStretchMax: 2.5
        });

        expect(withoutDebris).toBe(getTrackCanvasPadding({ showCurbs: true, showTireWalls: true }));
    });
});
