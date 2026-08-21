import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    buildBiomeBackdrop,
    drawBiomeBackdrop,
    resolveBackdropDetailTier
} from '../game/track/backdrop.js';
import { getBiomePresentation } from '../game/track/biomes.js';

const BIOME_PRESENTATION = {
    backgroundStyle: 'biome',
    ...getBiomePresentation('basalt')
};

const FLAT_PRESENTATION = { backgroundStyle: 'flat', offTrackColor: '#0f172a' };

const BOUNDS = { minX: 0, minY: 0, maxX: 1120, maxY: 721 };

function createRecordingContext() {
    const calls = {
        fill: 0, fillRect: 0, save: 0, restore: 0,
        translate: [], scale: [], fillStyles: []
    };
    const ctx = {
        set fillStyle(value) { calls.fillStyles.push(value); },
        get fillStyle() { return calls.fillStyles[calls.fillStyles.length - 1]; },
        fill: () => { calls.fill += 1; },
        fillRect: () => { calls.fillRect += 1; },
        save: () => { calls.save += 1; },
        restore: () => { calls.restore += 1; },
        translate: (x, y) => { calls.translate.push([x, y]); },
        scale: (x, y) => { calls.scale.push([x, y]); }
    };
    return { ctx, calls };
}

function boxSignature(items) {
    return items.map((item) => [
        Math.round(item.minX), Math.round(item.minY),
        Math.round(item.maxX), Math.round(item.maxY),
        item.styleIndex ?? ''
    ].join(':')).join('|');
}

function nearTrack(items) {
    return items.filter((item) => (
        item.minX > BOUNDS.minX - 900 && item.maxX < BOUNDS.maxX + 900
        && item.minY > BOUNDS.minY - 900 && item.maxY < BOUNDS.maxY + 900
    ));
}

describe('biome backdrop', () => {
    beforeAll(() => {
        vi.stubGlobal('Path2D', class {
            moveTo() {}
            lineTo() {}
            rect() {}
            closePath() {}
        });
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('builds nothing for a presentation that paints no biome', () => {
        expect(buildBiomeBackdrop(FLAT_PRESENTATION, BOUNDS, 'circuit')).toBeNull();
        expect(buildBiomeBackdrop(null, BOUNDS, 'circuit')).toBeNull();
        expect(buildBiomeBackdrop(BIOME_PRESENTATION, null, 'circuit')).toBeNull();
    });

    it('builds broad directional terrain in four nested low-contrast tones', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const tonesUsed = [...new Set(backdrop.terrain.map((tile) => tile.styleIndex))].sort();

        expect(tonesUsed).toEqual([0, 1, 2, 3]);

        // Higher thresholds remain nested, while the field turns them into ribbons.
        const areaOf = (styleIndex) => backdrop.terrain
            .filter((tile) => tile.styleIndex === styleIndex).length;
        expect(areaOf(1)).toBeLessThanOrEqual(areaOf(0));
        expect(areaOf(2)).toBeLessThanOrEqual(areaOf(1));
        expect(areaOf(3)).toBeLessThanOrEqual(areaOf(2));
        expect(areaOf(3)).toBeGreaterThan(0);
    });

    it('lays out the same ground every time for one track', () => {
        const first = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:circuit:biome:basalt');
        const second = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:circuit:biome:basalt');

        expect(first.terrain.length).toBeGreaterThan(0);
        expect(boxSignature(second.terrain)).toBe(boxSignature(first.terrain));
        expect(boxSignature(second.rocks)).toBe(boxSignature(first.rocks));
    });

    it('lays out different ground for a different track in the same biome', () => {
        const circuit = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:circuit:biome:basalt');
        const ridge = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:obsidianRidge:biome:basalt');

        expect(boxSignature(ridge.terrain)).not.toBe(boxSignature(circuit.terrain));
        expect(boxSignature(ridge.rocks)).not.toBe(boxSignature(circuit.rocks));
    });

    it('ignores sub-pixel drift in the track bounds', () => {
        // Smoothed bounds can move a fraction of a pixel between rebuilds and can
        // cross a field boundary doing it. The ground near the track must not move.
        const exact = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const jittered = buildBiomeBackdrop(BIOME_PRESENTATION, {
            minX: BOUNDS.minX + 0.4,
            minY: BOUNDS.minY - 0.3,
            maxX: BOUNDS.maxX + 0.2,
            maxY: BOUNDS.maxY - 0.45
        }, 'circuit');

        expect(nearTrack(exact.rocks).length).toBeGreaterThan(0);
        expect(boxSignature(nearTrack(jittered.rocks))).toBe(boxSignature(nearTrack(exact.rocks)));
    });

    it('measures every piece with a real bounding box, so culling can trust it', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');

        for (const item of [...backdrop.terrain, ...backdrop.rocks, ...backdrop.decals]) {
            expect(Number.isFinite(item.minX) && Number.isFinite(item.maxX)).toBe(true);
            expect(Number.isFinite(item.minY) && Number.isFinite(item.maxY)).toBe(true);
            expect(item.maxX).toBeGreaterThan(item.minX);
            expect(item.maxY).toBeGreaterThan(item.minY);
        }
    });

    it('reaches well past the track so the camera cannot run off the ground', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');

        expect(BOUNDS.minX - backdrop.field.minX).toBeGreaterThanOrEqual(1600);
        expect(backdrop.field.maxY - BOUNDS.maxY).toBeGreaterThanOrEqual(1600);
    });

    it('draws only what the viewport can see', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const total = backdrop.terrain.length + backdrop.rocks.length + backdrop.decals.length;
        const { ctx, calls } = createRecordingContext();

        const painted = drawBiomeBackdrop(ctx, 1920, 1080, {
            presentation: BIOME_PRESENTATION,
            backdrop
        });

        expect(painted).toBeGreaterThan(0);
        expect(painted).toBeLessThan(total);
        expect(calls.fillRect).toBe(1);
        expect(calls.save).toBe(1);
        expect(calls.restore).toBe(1);
    });

    it('uses no gradient and no ellipse, so it stays a flat fill', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const { ctx } = createRecordingContext();

        // A gradient or an ellipse would show up as a missing method on the stub.
        expect(() => drawBiomeBackdrop(ctx, 1920, 1080, {
            presentation: BIOME_PRESENTATION,
            backdrop
        })).not.toThrow();
    });

    it('drops the smallest things first when the device is struggling', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const { field } = backdrop;
        // Paint the whole field, so the comparison is about the tier and not about
        // which corner of the ground a viewport happens to sit on.
        const paint = (detailTier) => drawBiomeBackdrop(
            createRecordingContext().ctx,
            field.maxX - field.minX,
            field.maxY - field.minY,
            {
                offsetX: -field.minX,
                offsetY: -field.minY,
                scale: 1,
                presentation: BIOME_PRESENTATION,
                backdrop,
                detailTier
            },
        );

        const full = paint(2);
        const noDecals = paint(1);
        const terrainOnly = paint(0);

        expect(noDecals).toBeLessThan(full);
        expect(terrainOnly).toBeLessThan(noDecals);
        expect(terrainOnly).toBeGreaterThan(0);
    });

    it('still covers the viewport when there is no ground to draw', () => {
        const { ctx, calls } = createRecordingContext();

        const painted = drawBiomeBackdrop(ctx, 800, 600, {
            presentation: BIOME_PRESENTATION,
            backdrop: null
        });

        expect(painted).toBe(0);
        expect(calls.fillRect).toBe(1);
        expect(calls.fillStyles[0]).toBe(BIOME_PRESENTATION.biomeGround);
    });

    it('reduces detail from the signals the engine already tracks', () => {
        expect(resolveBackdropDetailTier(0, 0)).toBe(2);
        expect(resolveBackdropDetailTier(1, 0)).toBe(1);
        expect(resolveBackdropDetailTier(0, 1)).toBe(0);
        expect(resolveBackdropDetailTier(1, 1)).toBe(0);
    });
});
