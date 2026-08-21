/**
 * Biomes are stored per track in catalog.js and never change once written.
 * This file stays pure Node-compatible for the map maker and backfill tools.
 */

import { hashSeed } from './seeded-random.js';

function freezeDefinition(definition) {
    return Object.freeze({ ...definition });
}

function freezeConfig(config) {
    return Object.freeze({
        ...config,
        groundColors: Object.freeze([...config.groundColors]),
        features: Object.freeze(config.features.map(freezeDefinition)),
        props: Object.freeze(config.props.map(freezeDefinition))
    });
}

/** Canonical drawing instructions; placement remains deterministic from the track seed. */
export const BIOME_CONFIGS = Object.freeze({
    forest: freezeConfig({
        id: 'forest',
        groundColors: ['#0a191b', '#102326', '#152d2d', '#1b3532', '#223c36'],
        runoffColor: '#263735',
        transitionColor: '#172b2b',
        runoffWidth: 28,
        runoffVariation: 6,
        transitionWidth: 44,
        contourCount: 5,
        contourScale: 1.05,
        propDensity: 0.72,
        clustering: 0.78,
        propSpacing: 150,
        propClearance: 42,
        maxPropRadius: 55,
        clusterRadius: 340,
        terrainStyle: 'rolling',
        contourStyle: 'smooth',
        features: [
            { type: 'rolling-contours', density: 0.8, scale: 1, style: 'soft' },
            { type: 'tree-groves', density: 0.65, minDistanceFromTrack: 34, style: 'clustered' }
        ],
        props: [
            { type: 'pine', shape: 'layered-triangle', color: '#071412', accentColor: '#255245', weight: 0.58, minScale: 0.84, maxScale: 1.12, maxRotation: 0.1, cluster: true },
            { type: 'rock', shape: 'faceted', color: '#253433', accentColor: '#314440', size: 'small', weight: 0.18, minScale: 0.72, maxScale: 1.15, maxRotation: 0.32, cluster: false },
            { type: 'shrub', shape: 'soft-clump', color: '#1c3631', accentColor: '#28443b', weight: 0.24, minScale: 0.78, maxScale: 1.08, maxRotation: 0.24, cluster: true }
        ]
    }),
    mountains: freezeConfig({
        id: 'mountains',
        groundColors: ['#080e1b', '#10192b', '#151f32', '#1b273d', '#222f46'],
        runoffColor: '#222b38',
        transitionColor: '#141d2c',
        runoffWidth: 34,
        runoffVariation: 8,
        transitionWidth: 50,
        contourCount: 4,
        contourScale: 1.32,
        propDensity: 0.36,
        clustering: 0.48,
        propSpacing: 230,
        propClearance: 48,
        maxPropRadius: 80,
        clusterRadius: 460,
        terrainStyle: 'angular-elevation',
        contourStyle: 'angular',
        features: [
            { type: 'rock-formations', density: 0.52, scale: 1.4, style: 'angular' },
            { type: 'elevation-faces', density: 0.34, scale: 1.7, style: 'faceted' }
        ],
        props: [
            { type: 'rock-formation', shape: 'angular-cluster', color: '#0c1424', accentColor: '#33435f', weight: 0.4, minScale: 1.05, maxScale: 1.45, maxRotation: 0.24, cluster: true },
            { type: 'boulder', shape: 'faceted', color: '#1b263b', accentColor: '#2d3a52', weight: 0.42, minScale: 0.82, maxScale: 1.3, maxRotation: 0.4, cluster: false },
            { type: 'pine', shape: 'layered-triangle', color: '#101d2a', accentColor: '#1b2b39', distribution: 'sparse', weight: 0.18, minScale: 0.72, maxScale: 0.95, maxRotation: 0.08, cluster: false }
        ]
    }),
    arctic: freezeConfig({
        id: 'arctic',
        groundColors: ['#dcebf0', '#d2e4ea', '#c7dce5', '#bcd2dc', '#aec7d3'],
        runoffColor: '#c3d5dc',
        transitionColor: '#cfdee4',
        runoffWidth: 30,
        runoffVariation: 7,
        transitionWidth: 46,
        contourCount: 5,
        contourScale: 1.18,
        propDensity: 0.3,
        clustering: 0.42,
        propSpacing: 240,
        propClearance: 44,
        maxPropRadius: 65,
        clusterRadius: 440,
        terrainStyle: 'snow-drift',
        contourStyle: 'smooth',
        features: [
            { type: 'snow-drifts', density: 0.72, scale: 1.2, layers: 3, style: 'soft' },
            { type: 'frozen-ponds', density: 0.16, minDistanceFromTrack: 52, color: '#a9cfdb' },
            { type: 'ice-cracks', density: 0.22, feature: 'frozen-ponds', color: '#87b4c3', subtle: true }
        ],
        props: [
            { type: 'snowy-rock', shape: 'snow-capped-facet', color: '#9eb8c2', accentColor: '#e7f1f3', weight: 0.76, minScale: 0.78, maxScale: 1.22, maxRotation: 0.38, cluster: false },
            { type: 'ice-chip', shape: 'small-facet', color: '#acd0da', accentColor: '#dbecef', weight: 0.24, minScale: 0.7, maxScale: 0.95, maxRotation: 0.45, cluster: true }
        ]
    }),
    beach: freezeConfig({
        id: 'beach',
        groundColors: ['#c9a96e', '#d1b47b', '#d7bd86', '#bea066', '#b4935d'],
        runoffColor: '#b99b68',
        transitionColor: '#c2a66f',
        runoffWidth: 29,
        runoffVariation: 7,
        transitionWidth: 45,
        contourCount: 4,
        contourScale: 1.24,
        propDensity: 0.38,
        clustering: 0.58,
        propSpacing: 180,
        propClearance: 40,
        maxPropRadius: 50,
        clusterRadius: 380,
        terrainStyle: 'dunes',
        contourStyle: 'smooth',
        features: [
            { type: 'dunes', density: 0.72, scale: 1.25, style: 'soft' },
            { type: 'shoreline', density: 0.2, minClearance: 120, whereSpaceAllows: true },
            { type: 'water', density: 0.16, requires: 'shoreline', color: '#416f7b', accentColor: '#5b8790' }
        ],
        props: [
            { type: 'rock', shape: 'rounded-facet', color: '#806f59', accentColor: '#9c876c', weight: 0.34, minScale: 0.76, maxScale: 1.18, maxRotation: 0.36, cluster: false },
            { type: 'pebble', shape: 'oval', color: '#a68b63', accentColor: '#b99c70', weight: 0.66, minScale: 0.68, maxScale: 0.96, maxRotation: 0.5, cluster: true }
        ]
    })
});

/** Existing stored biome names resolve without rewriting catalog data. */
export const BIOME_CONFIG_ALIASES = Object.freeze({
    canyon: 'mountains',
    basalt: 'mountains',
    marsh: 'forest',
    city: 'mountains'
});

/** Append only: the catalog backfill persists positions in this array. */
export const BIOME_NAMES = Object.freeze([
    'beach',
    'forest',
    'canyon',
    'basalt',
    'marsh',
    'city',
    'mountains',
    'arctic'
]);

export const BIOME_LABELS = Object.freeze({
    beach: 'Beach',
    forest: 'Forest',
    canyon: 'Canyon',
    basalt: 'Basalt',
    marsh: 'Marsh',
    city: 'City',
    mountains: 'Mountains',
    arctic: 'Arctic'
});

export const DEFAULT_BIOME = 'basalt';

export function isBiomeName(value) {
    return typeof value === 'string' && BIOME_NAMES.includes(value);
}

/** Returns the canonical immutable environment configuration for a biome name. */
export function getBiomeConfig(biomeName) {
    const configName = BIOME_CONFIG_ALIASES[biomeName] || biomeName;
    return BIOME_CONFIGS[configName] || null;
}

export function isBiomePainted(biomeName) {
    return Boolean(getBiomeConfig(biomeName));
}

export function getBiomeLabel(biomeName) {
    return BIOME_LABELS[biomeName] || 'Unknown';
}

function createBiomePresentation(config) {
    return Object.freeze({
        backgroundStyle: 'biome',
        infieldColor: 'transparent',
        biomeConfig: config,
        // Compatibility fields for the current backdrop while it adopts biomeConfig.
        biomeGround: config.groundColors[0],
        biomeTerrainColors: Object.freeze(config.groundColors.slice(1)),
        biomeRockColor: config.groundColors[1],
        biomeRockLitColor: config.groundColors[2],
        biomeDecalColor: config.groundColors[3],
        trackShadowColor: 'rgba(0, 0, 0, 0.2)',
        trackShadowBlur: 8,
        trackShadowOffsetX: 0,
        trackShadowOffsetY: 2
    });
}

const BIOME_PRESENTATIONS = Object.freeze(Object.fromEntries(
    BIOME_NAMES.map((biomeName) => [
        biomeName,
        createBiomePresentation(getBiomeConfig(biomeName))
    ])
));

export function getBiomePresentation(biomeName) {
    return BIOME_PRESENTATIONS[biomeName] || null;
}

export function pickBiomeForTrackKey(trackKey) {
    return BIOME_NAMES[hashSeed(String(trackKey)) % BIOME_NAMES.length];
}

export function pickRandomBiome(exclude = null, random = Math.random) {
    const choices = BIOME_NAMES.filter((name) => name !== exclude);
    const pool = choices.length > 0 ? choices : BIOME_NAMES;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
