/**
 * The biome each track is set in, and the presentation each biome paints.
 *
 * A biome is stored per track in catalog.js and never changes once written, so a
 * track always looks like the same place. Two tracks in one biome still differ,
 * because the backdrop layout is seeded from the track key, not from the biome.
 *
 * This module imports only seeded-random.js so the map maker's pure-node save
 * plumbing and the backfill tool can read the same list the game renders from.
 * It must not import presentation.js: presentation.js reads this one.
 */

import { hashSeed } from './seeded-random.js';

/**
 * The dark rock biome the reference art is drawn from: near-black ground crossed
 * by four close, translucent terrain tones, with small faceted rocks and faint
 * marker grids on top. The contour is read as atmospheric shape, not contrast,
 * and the curbs stay the only saturated thing on screen.
 *
 * It deliberately sets no trackColor, curb or boundary stroke. A biome changes
 * the ground the track sits on, not the track.
 */
const BASALT_PRESENTATION = Object.freeze({
    backgroundStyle: 'biome',
    // The ground runs under the track, so the infield must not paint over it.
    infieldColor: 'transparent',
    biomeGround: '#080e1b',
    biomeTerrainColors: Object.freeze([
        'rgba(16, 25, 43, 0.45)',
        'rgba(21, 31, 50, 0.33)',
        'rgba(27, 39, 61, 0.24)',
        'rgba(34, 47, 70, 0.15)'
    ]),
    biomeRockColor: '#121a2b',
    biomeRockLitColor: '#1a2438',
    biomeDecalColor: 'rgba(46, 60, 86, 0.20)',
    trackShadowColor: 'rgba(0, 0, 0, 0.68)',
    trackShadowBlur: 24,
    trackShadowOffsetX: 0,
    trackShadowOffsetY: 6
});

/**
 * Every biome a track can be set to. Order is part of the stored data: the
 * backfill indexes into this array by track-key hash, so reordering or removing
 * a name reassigns tracks that were already settled. Append only.
 */
export const BIOME_NAMES = Object.freeze([
    'beach',
    'forest',
    'canyon',
    'basalt',
    'marsh',
    'city'
]);

export const BIOME_LABELS = Object.freeze({
    beach: 'Beach',
    forest: 'Forest',
    canyon: 'Canyon',
    basalt: 'Basalt',
    marsh: 'Marsh',
    city: 'City'
});

/**
 * Presentation per biome. Only basalt is painted so far; the rest resolve to the
 * default flat background, so a track set to them looks exactly as it does today.
 */
const BIOME_PRESENTATIONS = Object.freeze({
    basalt: BASALT_PRESENTATION
});

export const DEFAULT_BIOME = 'basalt';

export function isBiomeName(value) {
    return typeof value === 'string' && BIOME_NAMES.includes(value);
}

/** True when the biome draws its own background, false when it falls back to flat. */
export function isBiomePainted(biomeName) {
    return Boolean(BIOME_PRESENTATIONS[biomeName]);
}

export function getBiomeLabel(biomeName) {
    return BIOME_LABELS[biomeName] || 'Unknown';
}

/** The presentation fields a biome contributes, or null when it paints nothing. */
export function getBiomePresentation(biomeName) {
    return BIOME_PRESENTATIONS[biomeName] || null;
}

/**
 * The biome a track key settles on when nobody picked one. Stable for a given
 * key, which is what lets the backfill run again without reshuffling tracks.
 */
export function pickBiomeForTrackKey(trackKey) {
    return BIOME_NAMES[hashSeed(String(trackKey)) % BIOME_NAMES.length];
}

/**
 * A fresh biome for the map maker's Random option. Never returns `exclude`, so
 * pressing Reroll always visibly changes something.
 */
export function pickRandomBiome(exclude = null, random = Math.random) {
    const choices = BIOME_NAMES.filter((name) => name !== exclude);
    const pool = choices.length > 0 ? choices : BIOME_NAMES;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
