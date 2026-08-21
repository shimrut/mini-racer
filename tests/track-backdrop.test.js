import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    buildBiomeBackdrop,
    drawBiomeBackdrop,
    drawBiomeBackdropBase,
    drawBiomeBackdropProps,
    resolveBackdropDetailTier,
} from '../game/track/backdrop.js';
import { getBiomeConfig, getBiomePresentation } from '../game/track/biomes.js';

const BIOME_PRESENTATION = {
    backgroundStyle: 'biome',
    ...getBiomePresentation('forest'),
};
const FLAT_PRESENTATION = { backgroundStyle: 'flat', offTrackColor: '#0f172a' };

const GEOMETRY = {
    outer: [
        { x: 0, y: 0 }, { x: 1120, y: 0 }, { x: 1120, y: 720 }, { x: 0, y: 720 },
    ],
    inner: [
        { x: 280, y: 220 }, { x: 840, y: 220 }, { x: 840, y: 500 }, { x: 280, y: 500 },
    ],
};
const BOUNDS = { minX: 0, minY: 0, maxX: 1120, maxY: 720 };

function createRecordingContext() {
    const calls = {
        fill: 0, fillRect: 0, save: 0, restore: 0,
        translate: [], scale: [], fillStyles: [], stroke: 0,
    };
    const ctx = {
        set fillStyle(value) { calls.fillStyles.push(value); },
        get fillStyle() { return calls.fillStyles[calls.fillStyles.length - 1]; },
        fill: () => { calls.fill += 1; },
        fillRect: () => { calls.fillRect += 1; },
        stroke: () => { calls.stroke += 1; },
        save: () => { calls.save += 1; },
        restore: () => { calls.restore += 1; },
        translate: (x, y) => { calls.translate.push([x, y]); },
        scale: (x, y) => { calls.scale.push([x, y]); },
    };
    return { ctx, calls };
}

function build(seed = 'track:forest', geometry = GEOMETRY) {
    return buildBiomeBackdrop(
        BIOME_PRESENTATION,
        BOUNDS,
        seed,
        { geometry, worldScale: 1 },
    );
}

function boxSignature(items) {
    return items.map((item) => [
        Math.round(item.minX), Math.round(item.minY),
        Math.round(item.maxX), Math.round(item.maxY),
        item.style || item.type || '',
    ].join(':')).join('|');
}

function propSignature(items) {
    return items.map((item) => `${item.type}:${item.x.toFixed(3)}:${item.y.toFixed(3)}`).join('|');
}

describe('track-derived biome environment', () => {
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

    it('does not build an environment for flat or incomplete presentations', () => {
        expect(buildBiomeBackdrop(FLAT_PRESENTATION, BOUNDS, 'flat')).toBeNull();
        expect(buildBiomeBackdrop(null, BOUNDS, 'null')).toBeNull();
        expect(buildBiomeBackdrop(BIOME_PRESENTATION, null, 'missing')).toBeNull();
    });

    it('is deterministic for identical geometry, seed, and biome', () => {
        const first = build();
        const second = build();

        expect(boxSignature(second.terrain)).toBe(boxSignature(first.terrain));
        expect(boxSignature(second.transition)).toBe(boxSignature(first.transition));
        expect(boxSignature(second.runoff)).toBe(boxSignature(first.runoff));
        expect(propSignature(second.props)).toBe(propSignature(first.props));
    });

    it('changes terrain and props when the seed changes', () => {
        const first = build('track:forest:a');
        const second = build('track:forest:b');

        expect(boxSignature(second.terrain)).not.toBe(boxSignature(first.terrain));
        expect(propSignature(second.props)).not.toBe(propSignature(first.props));
    });

    it('reacts to changed track geometry with a stable seed', () => {
        const shiftedInner = {
            ...GEOMETRY,
            inner: GEOMETRY.inner.map((point) => ({ x: point.x + 150, y: point.y + 80 })),
        };
        const first = build('track:forest:geometry', GEOMETRY);
        const second = build('track:forest:geometry', shiftedInner);

        expect(second.distanceIndex.query(500, 300, 4000).distance)
            .not.toBe(first.distanceIndex.query(500, 300, 4000).distance);
        expect(second.distanceIndex).not.toBeNull();
    });

    it('uses three to five configured contour shades plus the biome base', () => {
        const backdrop = build();
        const config = getBiomeConfig('forest');
        const terrainStyles = new Set(backdrop.terrain.map((tile) => tile.style));

        expect(terrainStyles.size).toBe(config.contourCount - 1);
        expect(terrainStyles.size).toBeGreaterThanOrEqual(3);
        expect(terrainStyles.size).toBeLessThanOrEqual(5);
        expect(backdrop.groundColor).toBe(config.groundColors[0]);
    });

    it('builds transition terrain and runoff, with seeded width variation', () => {
        const backdrop = build();
        expect(backdrop.transition.length).toBeGreaterThan(0);
        expect(backdrop.runoff.length).toBeGreaterThan(0);

        const widths = [0.08, 0.31, 0.57, 0.83]
            .map((along) => backdrop.resolveRunoffWidth({ along }));
        expect(new Set(widths.map((width) => width.toFixed(4))).size).toBeGreaterThan(1);
    });

    it('keeps props Poisson-spaced and outside track, runoff, and transition clearance', () => {
        const backdrop = build();
        const config = getBiomeConfig('forest');
        expect(backdrop.props.length).toBeGreaterThan(0);

        for (let i = 0; i < backdrop.props.length; i += 1) {
            const prop = backdrop.props[i];
            expect(backdrop.distanceIndex.containsTrack(prop.x, prop.y)).toBe(false);
            const nearest = backdrop.distanceIndex.query(prop.x, prop.y, 4000);
            expect(nearest).not.toBeNull();
            expect(nearest.distance).toBeGreaterThan(
                backdrop.resolveRunoffWidth(nearest)
                + config.transitionWidth
                + config.maxPropRadius
                + config.propClearance,
            );
            for (let j = i + 1; j < backdrop.props.length; j += 1) {
                const other = backdrop.props[j];
                expect(Math.hypot(prop.x - other.x, prop.y - other.y))
                    .toBeGreaterThanOrEqual(config.propSpacing - 0.0001);
            }
        }
    });

    it('keeps finite bounds for terrain, features, runoff, and props', () => {
        const backdrop = build();
        for (const item of [
            ...backdrop.terrain,
            ...backdrop.transition,
            ...backdrop.runoff,
            ...backdrop.features,
            ...backdrop.props,
        ]) {
            expect(Number.isFinite(item.minX)).toBe(true);
            expect(Number.isFinite(item.minY)).toBe(true);
            expect(Number.isFinite(item.maxX)).toBe(true);
            expect(Number.isFinite(item.maxY)).toBe(true);
            expect(item.maxX).toBeGreaterThan(item.minX);
            expect(item.maxY).toBeGreaterThan(item.minY);
        }
    });

    it('draws base and props separately, and drops props by detail tier', () => {
        const backdrop = build();
        const full = createRecordingContext();
        const reduced = createRecordingContext();
        const terrainOnly = createRecordingContext();
        const options = {
            offsetX: -backdrop.field.minX,
            offsetY: -backdrop.field.minY,
            scale: 1,
            presentation: BIOME_PRESENTATION,
            backdrop,
        };
        const width = backdrop.field.maxX - backdrop.field.minX;
        const height = backdrop.field.maxY - backdrop.field.minY;

        const basePainted = drawBiomeBackdropBase(full.ctx, width, height, options);
        const fullProps = drawBiomeBackdropProps(full.ctx, width, height, { ...options, detailTier: 2 });
        const reducedProps = drawBiomeBackdropProps(reduced.ctx, width, height, { ...options, detailTier: 1 });
        const terrainProps = drawBiomeBackdropProps(terrainOnly.ctx, width, height, { ...options, detailTier: 0 });

        expect(basePainted).toBeGreaterThan(0);
        expect(fullProps).toBeGreaterThan(0);
        expect(reducedProps).toBeGreaterThan(0);
        expect(reducedProps).toBeLessThanOrEqual(fullProps);
        expect(terrainProps).toBeGreaterThan(0);
        expect(terrainProps).toBeLessThanOrEqual(reducedProps);
        expect(full.calls.fillRect).toBe(1);
        expect(full.calls.save).toBe(2);
        expect(full.calls.restore).toBe(2);
    });

    it('keeps the combined painter compatible and covers an empty backdrop', () => {
        const backdrop = build();
        const { ctx, calls } = createRecordingContext();
        const painted = drawBiomeBackdrop(ctx, 1920, 1080, {
            presentation: BIOME_PRESENTATION,
            backdrop,
        });
        expect(painted).toBeGreaterThan(0);

        const empty = createRecordingContext();
        expect(drawBiomeBackdrop(empty.ctx, 800, 600, {
            presentation: BIOME_PRESENTATION,
            backdrop: null,
        })).toBe(0);
        expect(empty.calls.fillRect).toBe(1);
        expect(calls.fillRect).toBe(1);
    });

    it('uses the existing quality and frame-skip tiers', () => {
        expect(resolveBackdropDetailTier(0, 0)).toBe(2);
        expect(resolveBackdropDetailTier(1, 0)).toBe(1);
        expect(resolveBackdropDetailTier(0, 1)).toBe(0);
        expect(resolveBackdropDetailTier(1, 1)).toBe(0);
    });
});
