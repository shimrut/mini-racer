import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    buildAuthoredMountainScenery,
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
import {
    buildAuthoredMountainScenery,
    MOUNTAIN_COMPOSITION_RECIPES,
    MOUNTAIN_MARKER_TEMPLATES,
    MOUNTAIN_PATCH_TEMPLATES,
    MOUNTAIN_ROCK_TEMPLATES,
} from '../game/track/mountains-scenery.js';
import {
    buildAuthoredArcticScenery,
    ARCTIC_COMPOSITION_RECIPES,
    ARCTIC_FROZEN_POND_TEMPLATES,
    ARCTIC_ICE_PATCH_TEMPLATES,
    ARCTIC_SNOW_FIELD_TEMPLATES,
    ARCTIC_SNOWDRIFT_TEMPLATES,
    ARCTIC_SNOWY_ROCK_TEMPLATES,
} from '../game/track/arctic-scenery.js';
import {
    buildAuthoredBeachScenery,
    BEACH_COMPOSITION_RECIPES,
    BEACH_DUNE_TEMPLATES,
    BEACH_PEBBLE_TEMPLATES,
    BEACH_SHORELINE_TEMPLATES,
} from '../game/track/beach-scenery.js';

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
            quadraticCurveTo() {}
            arc() {}
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

    it('has the exact authored libraries and recipes for Mountains, Arctic, and Beach', () => {
        expect([
            MOUNTAIN_PATCH_TEMPLATES.length,
            MOUNTAIN_ROCK_TEMPLATES.length,
            MOUNTAIN_MARKER_TEMPLATES.length,
        ]).toEqual([3, 3, 3]);
        MOUNTAIN_MARKER_TEMPLATES.forEach((marker) => {
            expect(marker.dots).toHaveLength(4);
            expect(new Set(marker.dots.map(([x]) => x))).toHaveLength(2);
            expect(new Set(marker.dots.map(([, y]) => y))).toHaveLength(2);
        });
        expect(MOUNTAIN_COMPOSITION_RECIPES.map(({ id }) => id)).toEqual(['MOUNTAINS_A', 'MOUNTAINS_B', 'MOUNTAINS_C']);
        expect([
            ARCTIC_SNOW_FIELD_TEMPLATES.length,
            ARCTIC_FROZEN_POND_TEMPLATES.length,
            ARCTIC_SNOWDRIFT_TEMPLATES.length,
            ARCTIC_ICE_PATCH_TEMPLATES.length,
            ARCTIC_SNOWY_ROCK_TEMPLATES.length,
        ]).toEqual([3, 3, 3, 2, 2]);
        expect(ARCTIC_COMPOSITION_RECIPES.map(({ id }) => id)).toEqual(['ARCTIC_A', 'ARCTIC_B', 'ARCTIC_C']);
        expect([
            BEACH_DUNE_TEMPLATES.length,
            BEACH_SHORELINE_TEMPLATES.length,
            BEACH_PEBBLE_TEMPLATES.length,
        ]).toEqual([3, 3, 2]);
        expect(BEACH_COMPOSITION_RECIPES.map(({ id }) => id)).toEqual(['BEACH_A', 'BEACH_B', 'BEACH_C']);
    });

    it('preserves the approved Forest transform golden after shared-helper extraction', () => {
        const backdrop = build();
        const signature = [
            backdrop.compositionRecipe,
            ...[...backdrop.largeFeatures, ...backdrop.mediumFeatures, ...backdrop.smallFeatures]
                .map((feature) => `${feature.templateId}:${feature.x.toFixed(3)}:${feature.y.toFixed(3)}:${feature.scale.toFixed(4)}:${feature.rotation.toFixed(4)}:${feature.mirror}:${feature.paletteIndex}`),
        ].join('|');
        expect(signature).toBe('FOREST_B|forest-ground-mass-01:-280.846:-427.844:1.0192:-2.9866:1:0|forest-ground-mass-02:-457.461:-61.151:0.8335:0.4261:-1:1|forest-ground-mass-03:-546.578:633.897:1.0516:0.8043:1:2|forest-ground-mass-01:-432.059:1144.943:0.9546:2.0418:-1:2|forest-ground-mass-02:1328.030:-441.855:1.0858:0.5508:1:2|forest-ground-mass-03:1633.513:322.345:0.9411:2.1146:-1:1|forest-ground-mass-01:1418.825:1186.640:1.0936:1.7908:1:0|forest-cluster-01:-171.139:-415.083:1.0985:0.7547:1:1|forest-cluster-02:-387.351:-39.328:0.9160:2.1671:1:1|forest-cluster-03:-434.717:607.575:0.9214:-0.3313:1:0|forest-cluster-01:-314.338:1143.024:0.9994:1.0076:-1:0|forest-cluster-02:1247.744:-348.790:1.0258:2.8900:-1:0|forest-cluster-03:1552.080:376.164:1.0308:-2.1645:1:2|forest-cluster-01:1298.741:1174.132:1.1148:0.6775:-1:0|forest-rock-formation-01:-59.742:-408.705:0.8635:-2.1681:1:2|forest-rock-formation-02:-213.176:1145.981:1.1074:-0.6762:1:1|forest-rock-formation-01:1271.548:1063.318:1.1210:1.3384:1:1|forest-vegetation-01:-57.099:-388.710:1.1236:2.6387:1:0|forest-vegetation-02:-346.176:543.537:1.0042:2.3326:-1:0|forest-vegetation-03:1162.363:-287.720:1.0341:1.9349:-1:2|forest-vegetation-01:1232.951:1097.171:1.0829:-0.3175:-1:0');
        expect([0.08, 0.31, 0.57, 0.83]
            .map((along) => backdrop.shoulder.resolveWidth({ along }).toFixed(6)))
            .toEqual(['52.512993', '47.790451', '35.285924', '38.800027']);
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

    it.each([
        ['mountains', /^MOUNTAINS_/, { 'mountain-background-patch': [5, 5], 'mountain-faceted-rock-group': [5, 6], 'mountain-four-dot-marker': [3, 4] }],
        ['arctic', /^ARCTIC_/, { 'arctic-snow-field': [6, 8], 'arctic-frozen-pond': [2, 4], 'arctic-snowdrift': [5, 7], 'arctic-ice-patch': [3, 5], 'arctic-snowy-rock-cluster': [3, 5] }],
        ['beach', /^BEACH_/, { 'beach-dune-mass': [5, 8], 'beach-shoreline-system': [1, 3], 'beach-pebble-group': [3, 5] }],
    ])('builds authored %s scenery with contracted counts and no legacy scatter', (biome, recipePattern, ranges) => {
            const backdrop = buildBiomeBackdrop(
                getBiomePresentation(biome),
                BOUNDS,
                `world:${biome}`,
                { geometry: GEOMETRY, worldScale: 1 },
            );
            const all = [...backdrop.largeFeatures, ...backdrop.mediumFeatures, ...backdrop.smallFeatures];
            const repeated = buildBiomeBackdrop(getBiomePresentation(biome), BOUNDS, `world:${biome}`, { geometry: GEOMETRY });
            const varied = buildBiomeBackdrop(getBiomePresentation(biome), BOUNDS, `world:${biome}:varied`, { geometry: GEOMETRY });
            expect(backdrop.compositionRecipe).toMatch(recipePattern);
            expect(featureSignature(all)).toBe(featureSignature([
                ...repeated.largeFeatures, ...repeated.mediumFeatures, ...repeated.smallFeatures,
            ]));
            expect(featureSignature(all)).not.toBe(featureSignature([
                ...varied.largeFeatures, ...varied.mediumFeatures, ...varied.smallFeatures,
            ]));
            Object.entries(ranges).forEach(([kind, [min, max]]) => {
                const count = all.filter((feature) => feature.kind === kind).length;
                expect(count).toBeGreaterThanOrEqual(min);
                expect(count).toBeLessThanOrEqual(max);
            });
            all.forEach((feature) => {
                const nearest = backdrop.distanceIndex.query(feature.x, feature.y, 4000);
                if (feature.kind === 'mountain-background-patch') {
                    expect(feature.layers).toHaveLength(1);
                } else {
                    expect(nearest.distance).toBeGreaterThan(feature.footprintRadius + 57);
                }
                expect(Number.isFinite(feature.minX + feature.minY + feature.maxX + feature.maxY)).toBe(true);
            });
            expect(new Set(all.map((feature) => feature.paletteIndex)).size).toBeGreaterThan(1);
            all.flatMap((feature) => feature.layers)
                .filter((layer) => layer.strokeStyle)
                .forEach((layer) => expect(layer.style).toBeUndefined());
            expect(backdrop.transition).toEqual([]);
            expect(backdrop.regions).toEqual([]);
            expect(backdrop.propCandidates).toEqual([]);
            expect(backdrop.props).toEqual([]);
            expect(backdrop.shoulder).toEqual(expect.objectContaining({ source: 'distance-only', minWidth: 30, maxWidth: 60 }));
            expect(backdrop.trackLocalExtent).toEqual({ min: 30, max: 60 });
    });

    it.each([
        ['mountains', buildAuthoredMountainScenery],
        ['arctic', buildAuthoredArcticScenery],
        ['beach', buildAuthoredBeachScenery],
    ])('handles null/tiny geometry safely for %s', (biome, builder) => {
        const result = builder({
            seedKey: `tiny:${biome}`,
            area: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
            distanceIndex: null,
        });
        expect(result.trackAnalysis).toEqual({ bounds: null, majorCorners: [] });
        expect(result.largeFeatures).toEqual([]);
        expect(result.mediumFeatures).toEqual([]);
        if (biome === 'mountains') {
            expect(result.smallFeatures.every((feature) => (
                feature.kind === 'mountain-four-dot-marker'
                && Number.isFinite(feature.minX + feature.minY + feature.maxX + feature.maxY)
            ))).toBe(true);
        } else {
            expect(result.smallFeatures).toEqual([]);
        }
    });

    it.each(['mountains', 'arctic', 'beach'])('keeps %s independent of wall point order', (biome) => {
        const rotate = (points, amount) => [...points.slice(amount), ...points.slice(0, amount)];
        const reordered = { outer: rotate(GEOMETRY.outer, 2), inner: rotate(GEOMETRY.inner, 1) };
        const first = buildBiomeBackdrop(getBiomePresentation(biome), BOUNDS, `sequence:${biome}`, { geometry: GEOMETRY });
        const second = buildBiomeBackdrop(getBiomePresentation(biome), BOUNDS, `sequence:${biome}`, { geometry: reordered });
        expect(featureSignature([...second.largeFeatures, ...second.mediumFeatures, ...second.smallFeatures]))
            .toBe(featureSignature([...first.largeFeatures, ...first.mediumFeatures, ...first.smallFeatures]));
    });

    it('lets only Mountains background patches continue beneath the track', () => {
        const backdrop = buildBiomeBackdrop(
            getBiomePresentation('mountains'),
            BOUNDS,
            'world:mountains:overlap',
            { geometry: GEOMETRY, worldScale: 1 },
        );
        expect(backdrop.largeFeatures).toHaveLength(5);
        expect(backdrop.largeFeatures.every((feature) => (
            feature.kind === 'mountain-background-patch'
        ))).toBe(true);
        expect(backdrop.largeFeatures.some((feature) => {
            const nearest = backdrop.distanceIndex.query(feature.x, feature.y, 4000);
            return nearest.distance <= feature.footprintRadius;
        })).toBe(true);

        for (const feature of [...backdrop.mediumFeatures, ...backdrop.smallFeatures]) {
            const nearest = backdrop.distanceIndex.query(feature.x, feature.y, 4000);
            expect(nearest.distance).toBeGreaterThan(feature.footprintRadius + 57);
        }
    });

    it.each([
        ['canyon', 'mountains', /^MOUNTAINS_/],
        ['basalt', 'mountains', /^MOUNTAINS_/],
        ['city', 'mountains', /^MOUNTAINS_/],
        ['marsh', 'forest', /^FOREST_/],
    ])('routes %s through the canonical %s authored builder', (alias, canonical, recipePattern) => {
        const backdrop = buildBiomeBackdrop(getBiomePresentation(alias), BOUNDS, `alias:${alias}`, { geometry: GEOMETRY });
        expect(backdrop.configId).toBe(canonical);
        expect(backdrop.compositionRecipe).toMatch(recipePattern);
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
