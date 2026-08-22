/**
 * Biomes are stored per track in catalog.js and never change once written.
 * This file stays pure Node-compatible for the map maker and backfill tools.
 */

import { hashSeed } from './seeded-random.js';

function freezeConfig({ id, groundColors, runoffColor }) {
    return Object.freeze({
        id,
        groundColors: Object.freeze([...groundColors]),
        runoffColor
    });
}

/** Canonical drawing instructions; placement remains deterministic from the track seed. */
export const BIOME_CONFIGS = Object.freeze({
    forest: freezeConfig({
        id: 'forest',
        groundColors: ['#0a191b', '#102326', '#152d2d', '#1b3532', '#223c36'],
        runoffColor: '#263735'
    }),
    mountains: freezeConfig({
        id: 'mountains',
        groundColors: ['#080e1b', '#10192b', '#151f32', '#1b273d', '#222f46'],
        runoffColor: '#222b38'
    }),
    arctic: freezeConfig({
        id: 'arctic',
        groundColors: ['#dcebf0', '#d2e4ea', '#c7dce5', '#bcd2dc', '#aec7d3'],
        runoffColor: '#c3d5dc'
    }),
    beach: freezeConfig({
        id: 'beach',
        groundColors: ['#c9a96e', '#d1b47b', '#d7bd86', '#bea066', '#b4935d'],
        runoffColor: '#b99b68'
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
        biomeGround: config.groundColors[0],
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
