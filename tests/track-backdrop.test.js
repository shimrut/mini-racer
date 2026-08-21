import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    buildBiomeBackdrop,
    drawBiomeBackdrop,
    drawBiomeBackdropBase,
    drawBiomeBackdropProps,
    resolveBackdropDetailTier,
} from '../game/track/backdrop.js';
import { getBiomeConfig, getBiomePresentation } from '../game/track/biomes.js';
import {
    buildAuthoredForestScenery,
    FOREST_CLUSTER_TEMPLATES,
    FOREST_COMPOSITION_RECIPES,
    FOREST_GROUND_MASS_TEMPLATES,
    FOREST_ROCK_FORMATION_TEMPLATES,
} from '../game/track/forest-scenery.js';

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
    return items.map((item) => `${item.type || item.regionType || ''}:${item.x.toFixed(3)}:${item.y.toFixed(3)}`).join('|');
}

function featureSignature(items) {
    return items.map((item) => [
        item.semanticType || item.type,
        item.minX.toFixed(3), item.minY.toFixed(3),
        item.maxX.toFixed(3), item.maxY.toFixed(3),
    ].join(':')).join('|');
}

describe('world-first biome environment', () => {
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

    it('has the exact first-iteration authored Forest library and recipe counts', () => {
        expect(FOREST_GROUND_MASS_TEMPLATES).toHaveLength(3);
        expect(FOREST_CLUSTER_TEMPLATES).toHaveLength(3);
        expect(FOREST_ROCK_FORMATION_TEMPLATES).toHaveLength(2);
        expect(FOREST_COMPOSITION_RECIPES.map((recipe) => recipe.id)).toEqual([
            'FOREST_A', 'FOREST_B', 'FOREST_C',
        ]);
    });

    it('is deterministic for identical geometry, seed, and biome', () => {
        const first = build();
        const second = build();

        expect(second.compositionRecipe).toBe(first.compositionRecipe);
        expect(featureSignature(second.largeFeatures)).toBe(featureSignature(first.largeFeatures));
        expect(featureSignature(second.mediumFeatures)).toBe(featureSignature(first.mediumFeatures));
        expect(featureSignature(second.smallFeatures)).toBe(featureSignature(first.smallFeatures));
        expect(boxSignature(second.shoulder.tiles)).toBe(boxSignature(first.shoulder.tiles));
    });

    it('changes authored transforms when the seed changes', () => {
        const first = build('track:forest:a');
        const second = build('track:forest:b');

        expect(featureSignature(second.largeFeatures)).not.toBe(featureSignature(first.largeFeatures));
        expect(featureSignature(second.mediumFeatures)).not.toBe(featureSignature(first.mediumFeatures));
    });

    it('keeps recipe-zone placement independent of outer-wall point sequence', () => {
        const rotate = (points, amount) => [...points.slice(amount), ...points.slice(0, amount)];
        const reorderedGeometry = {
            outer: rotate(GEOMETRY.outer, 2),
            inner: rotate(GEOMETRY.inner, 1),
        };
        const first = build('track:forest:sequence', GEOMETRY);
        const second = build('track:forest:sequence', reorderedGeometry);

        expect(featureSignature(second.largeFeatures)).toBe(featureSignature(first.largeFeatures));
        expect(featureSignature(second.mediumFeatures)).toBe(featureSignature(first.mediumFeatures));
        expect(featureSignature(second.smallFeatures)).toBe(featureSignature(first.smallFeatures));
    });

    it('handles null geometry and an area too small for any anchor', () => {
        const withoutGeometry = build('track:forest:no-geometry', null);
        expect(withoutGeometry.trackAnalysis).toEqual({ bounds: null, majorCorners: [] });
        expect(withoutGeometry.largeFeatures.length).toBeGreaterThan(0);

        expect(() => buildAuthoredForestScenery({
            seedKey: 'track:forest:no-anchors',
            area: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
            distanceIndex: null,
        })).not.toThrow();
        const empty = buildAuthoredForestScenery({
            seedKey: 'track:forest:no-anchors',
            area: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
            distanceIndex: null,
        });
        expect(empty.largeFeatures).toEqual([]);
        expect(empty.mediumFeatures).toEqual([]);
        expect(empty.smallFeatures).toEqual([]);
    });

    it('exposes the authored composition contract with recipe feature ranges', () => {
        const backdrop = build();

        expect(['FOREST_A', 'FOREST_B', 'FOREST_C']).toContain(backdrop.compositionRecipe);
        expect(backdrop.largeFeatures.length).toBeGreaterThanOrEqual(6);
        expect(backdrop.largeFeatures.length).toBeLessThanOrEqual(10);
        expect(backdrop.mediumFeatures.length).toBeGreaterThanOrEqual(5);
        expect(backdrop.mediumFeatures.length).toBeLessThanOrEqual(8);
        const rocks = backdrop.smallFeatures.filter((feature) => feature.kind === 'forest-rock-formation');
        const vegetation = backdrop.smallFeatures.filter((feature) => feature.kind === 'forest-vegetation-cluster');
        expect(rocks.length).toBeGreaterThanOrEqual(3);
        expect(rocks.length).toBeLessThanOrEqual(5);
        expect(vegetation.length).toBeGreaterThanOrEqual(3);
        expect(vegetation.length).toBeLessThanOrEqual(5);
        expect(backdrop.props).toEqual([]);
        expect(backdrop.propCandidates).toEqual([]);
    });

    it('analyzes the world-pixel track bounds and separated major corners', () => {
        const { trackAnalysis } = build();

        expect(trackAnalysis.bounds).toEqual(BOUNDS);
        expect(trackAnalysis.majorCorners.length).toBeGreaterThanOrEqual(3);
        for (let index = 0; index < trackAnalysis.majorCorners.length; index += 1) {
            expect(trackAnalysis.majorCorners[index].curvature).toBeGreaterThan(0);
            for (let other = index + 1; other < trackAnalysis.majorCorners.length; other += 1) {
                expect(Math.hypot(
                    trackAnalysis.majorCorners[index].x - trackAnalysis.majorCorners[other].x,
                    trackAnalysis.majorCorners[index].y - trackAnalysis.majorCorners[other].y,
                )).toBeGreaterThan(175);
            }
        }
    });

    it('associates clusters and details with authored ground groups using subtle palette variation', () => {
        const backdrop = build();
        const overlapsAny = (feature, anchors) => anchors.some((anchor) => (
            Math.hypot(feature.x - anchor.x, feature.y - anchor.y)
                < feature.footprintRadius + anchor.footprintRadius
        ));

        backdrop.mediumFeatures.forEach((feature) => expect(overlapsAny(feature, backdrop.largeFeatures)).toBe(true));
        backdrop.smallFeatures.forEach((feature) => expect(overlapsAny(feature, backdrop.mediumFeatures)).toBe(true));
        backdrop.largeFeatures.forEach((feature) => {
            expect(feature.layers).toHaveLength(1);
            expect(typeof feature.layers[0].style).toBe('string');
        });
        const paletteIndexes = new Set([
            ...backdrop.largeFeatures,
            ...backdrop.mediumFeatures,
            ...backdrop.smallFeatures,
        ].map((feature) => feature.paletteIndex));
        expect(paletteIndexes.size).toBeGreaterThan(1);
    });

    it('builds exactly one gradually irregular 30-60px shoulder', () => {
        const backdrop = build();
        expect(backdrop.shoulder).toEqual(expect.objectContaining({
            source: 'distance-only', minWidth: 30, maxWidth: 60,
        }));
        expect(backdrop.shoulder.tiles.length).toBeGreaterThan(0);
        expect(backdrop.transition).toEqual([]);

        const widths = [0.08, 0.31, 0.57, 0.83]
            .map((along) => backdrop.shoulder.resolveWidth({ along }));
        expect(new Set(widths.map((width) => width.toFixed(4))).size).toBeGreaterThan(1);
        widths.forEach((width) => {
            expect(width).toBeGreaterThanOrEqual(30);
            expect(width).toBeLessThanOrEqual(60);
        });
        expect(backdrop.trackLocalExtent).toEqual({ min: 30, max: 60 });
    });

    it('preserves the legacy authored coverage for non-Forest biomes', () => {
        const expectedRegions = {
            mountains: ['mountain-ridge', 'boulder-field', 'mountain-tree-line'],
            arctic: ['snowdrift', 'frozen-lake', 'arctic-rock-cluster'],
            beach: ['water-body', 'dune-field', 'beach-rock-cluster'],
        };
        const expectedFeatures = {
            mountains: ['mountain-ridge-lines', 'mountain-rock-field'],
            arctic: ['snowdrift-lines', 'ice-cracks'],
            beach: ['wet-sand', 'dune-crests'],
        };

        Object.entries(expectedRegions).forEach(([biome, expected]) => {
            const backdrop = buildBiomeBackdrop(
                getBiomePresentation(biome),
                BOUNDS,
                `world:${biome}`,
                { geometry: GEOMETRY, worldScale: 1 },
            );
            const types = new Set(backdrop.regions.map((region) => region.type));
            expected.forEach((type) => expect(types.has(type)).toBe(true));
            const featureTypes = new Set(backdrop.features.map((feature) => feature.semanticType));
            expectedFeatures[biome].forEach((type) => expect(featureTypes.has(type)).toBe(true));
            const clustered = backdrop.propCandidates.filter((point) => point.regionType);
            expect(clustered.length).toBeGreaterThan(backdrop.propCandidates.length * 0.7);
            expect(backdrop.terrain.length).toBeGreaterThan(0);
            expect(backdrop.transition.length).toBeGreaterThan(0);
            expect(backdrop.props.length).toBeGreaterThan(0);
        });
    });

    it('keeps every authored footprint outside the track and shoulder', () => {
        const backdrop = build();
        const featureGroups = [
            [backdrop.largeFeatures, 100],
            [backdrop.mediumFeatures, 64],
            [backdrop.smallFeatures.filter((feature) => feature.kind === 'forest-rock-formation'), 62],
            [backdrop.smallFeatures.filter((feature) => feature.kind === 'forest-vegetation-cluster'), 58],
        ];
        for (const [features, clearance] of featureGroups) {
          for (const feature of features) {
            expect(backdrop.distanceIndex.containsTrack(feature.x, feature.y)).toBe(false);
            const nearest = backdrop.distanceIndex.query(feature.x, feature.y, 4000);
            expect(nearest).not.toBeNull();
            expect(nearest.distance).toBeGreaterThan(feature.footprintRadius + clearance);
          }
        }
    });

    it('keeps finite bounds for terrain, features, runoff, and props', () => {
        const backdrop = build();
        for (const item of [
            ...backdrop.terrain,
            ...backdrop.transition,
            ...backdrop.runoff,
            ...backdrop.largeFeatures,
            ...backdrop.mediumFeatures,
            ...backdrop.smallFeatures,
        ]) {
            expect(Number.isFinite(item.minX)).toBe(true);
            expect(Number.isFinite(item.minY)).toBe(true);
            expect(Number.isFinite(item.maxX)).toBe(true);
            expect(Number.isFinite(item.maxY)).toBe(true);
            expect(item.maxX).toBeGreaterThan(item.minX);
            expect(item.maxY).toBeGreaterThan(item.minY);
        }
    });

    it('draws all Forest features in the base pass and no individual props after track', () => {
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
        expect(fullProps).toBe(0);
        expect(reducedProps).toBe(0);
        expect(terrainProps).toBe(0);
        expect(full.calls.fillRect).toBe(1);
        expect(full.calls.save).toBe(1);
        expect(full.calls.restore).toBe(1);
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
