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
        fill: 0,
        fillRect: 0,
        save: 0,
        restore: 0,
        translate: [],
        scale: [],
        fillStyles: []
    };
    const ctx = {
        set fillStyle(value) {
            calls.fillStyles.push(value);
        },
        get fillStyle() {
            return calls.fillStyles[calls.fillStyles.length - 1];
        },
        fill: () => { calls.fill += 1; },
        fillRect: () => { calls.fillRect += 1; },
        save: () => { calls.save += 1; },
        restore: () => { calls.restore += 1; },
        translate: (x, y) => { calls.translate.push([x, y]); },
        scale: (x, y) => { calls.scale.push([x, y]); }
    };
    return { ctx, calls };
}

function propSignature(backdrop) {
    return backdrop.props.map((prop) => [
        prop.tier,
        prop.styleIndex,
        Math.round(prop.minX),
        Math.round(prop.minY),
        Math.round(prop.maxX),
        Math.round(prop.maxY)
    ].join(':')).join('|');
}

describe('biome backdrop', () => {
    beforeAll(() => {
        vi.stubGlobal('Path2D', class {
            moveTo() {}
            lineTo() {}
            rect() {}
            quadraticCurveTo() {}
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

    it('lays out the same ground every time for one track', () => {
        const first = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:circuit:biome:basalt');
        const second = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:circuit:biome:basalt');

        expect(first.props.length).toBeGreaterThan(0);
        expect(propSignature(second)).toBe(propSignature(first));
    });

    it('lays out different ground for a different track in the same biome', () => {
        const circuit = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:circuit:biome:basalt');
        const ridge = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'track:obsidianRidge:biome:basalt');

        expect(propSignature(ridge)).not.toBe(propSignature(circuit));
    });

    it('ignores sub-pixel drift in the track bounds', () => {
        // Smoothed bounds can move a fraction of a pixel between rebuilds, and can
        // cross a field boundary while doing it. Every shape anywhere near the track
        // must still land in exactly the same place, or a track would visibly change
        // its ground mid-session.
        const nearTrack = (backdrop) => propSignature({
            props: backdrop.props.filter((prop) => (
                prop.minX > BOUNDS.minX - 800
                && prop.maxX < BOUNDS.maxX + 800
                && prop.minY > BOUNDS.minY - 800
                && prop.maxY < BOUNDS.maxY + 800
            ))
        });

        const exact = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const jittered = buildBiomeBackdrop(BIOME_PRESENTATION, {
            minX: BOUNDS.minX + 0.4,
            minY: BOUNDS.minY - 0.3,
            maxX: BOUNDS.maxX + 0.2,
            maxY: BOUNDS.maxY - 0.45
        }, 'circuit');

        expect(nearTrack(exact).length).toBeGreaterThan(0);
        expect(nearTrack(jittered)).toBe(nearTrack(exact));
    });

    it('measures every shape with a real bounding box, so culling can trust it', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');

        for (const prop of backdrop.props) {
            expect(Number.isFinite(prop.minX) && Number.isFinite(prop.maxX)).toBe(true);
            expect(Number.isFinite(prop.minY) && Number.isFinite(prop.maxY)).toBe(true);
            expect(prop.maxX).toBeGreaterThan(prop.minX);
            expect(prop.maxY).toBeGreaterThan(prop.minY);
        }
    });

    it('covers the field right out to its corners', () => {
        // Shapes are placed per cell and may overhang the field edge. That overhang
        // is what stops a bare strip appearing where the ground runs out.
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const { field } = backdrop;
        const corners = [
            [field.minX + 1, field.minY + 1],
            [field.maxX - 1, field.minY + 1],
            [field.minX + 1, field.maxY - 1],
            [field.maxX - 1, field.maxY - 1]
        ];

        for (const [x, y] of corners) {
            const covering = backdrop.props.filter((prop) => (
                prop.minX <= x && prop.maxX >= x && prop.minY <= y && prop.maxY >= y
            ));
            expect(covering.length).toBeGreaterThan(0);
        }
    });

    it('reaches well past the track so the camera cannot run off the ground', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');

        expect(BOUNDS.minX - backdrop.field.minX).toBeGreaterThanOrEqual(1600);
        expect(backdrop.field.maxY - BOUNDS.maxY).toBeGreaterThanOrEqual(1600);
    });

    it('draws only what the viewport can see', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const { ctx, calls } = createRecordingContext();

        const painted = drawBiomeBackdrop(ctx, 1920, 1080, {
            offsetX: 0,
            offsetY: 0,
            scale: 1,
            presentation: BIOME_PRESENTATION,
            backdrop
        });

        expect(painted).toBeGreaterThan(0);
        expect(painted).toBeLessThan(backdrop.props.length);
        expect(calls.fill).toBe(painted);
        expect(calls.fillRect).toBe(1);
        expect(calls.save).toBe(1);
        expect(calls.restore).toBe(1);
    });

    it('costs one fill style per style, not one per shape', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const { ctx, calls } = createRecordingContext();

        drawBiomeBackdrop(ctx, 1920, 1080, {
            offsetX: 0,
            offsetY: 0,
            scale: 1,
            presentation: BIOME_PRESENTATION,
            backdrop
        });

        // One for the ground, then at most one per style in the sorted draw order.
        expect(calls.fillStyles.length).toBeLessThanOrEqual(1 + backdrop.styles.length);
    });

    it('drops the smallest shapes first when the device is struggling', () => {
        const backdrop = buildBiomeBackdrop(BIOME_PRESENTATION, BOUNDS, 'circuit');
        const paint = (detailTier) => drawBiomeBackdrop(createRecordingContext().ctx, 1920, 1080, {
            offsetX: 0,
            offsetY: 0,
            scale: 1,
            presentation: BIOME_PRESENTATION,
            backdrop,
            detailTier
        });

        const full = paint(2);
        const reduced = paint(1);
        const landformOnly = paint(0);

        expect(reduced).toBeLessThan(full);
        expect(landformOnly).toBeLessThan(reduced);
        expect(landformOnly).toBeGreaterThan(0);
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
