/**
 * FNV-1a hashing and a mulberry32 stream, seeded from a string.
 *
 * This lived privately in canvas.js, where the boundary debris pass used it to
 * scatter rocks the same way every time a track is drawn. Biomes need the same
 * property from three places that cannot share canvas.js: the race renderer, the
 * map maker preview, and the pure-node backfill tool. So it moved here unchanged.
 *
 * The stream is a committed format, not an implementation detail. Every track's
 * debris and every biome's layout is derived from it, so changing the arithmetic
 * silently redraws tracks that players have already learned.
 */

/** Folds a string into an unsigned 32-bit FNV-1a hash. */
export function hashSeed(seedInput = 'default') {
    let hash = 2166136261;
    const text = String(seedInput);
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

/** Returns a mulberry32 generator that yields the same sequence for the same seed. */
export function createSeededRandom(seedInput = 'default') {
    // `| 0` restores the signed hash the stream was originally seeded with.
    let hash = hashSeed(seedInput) | 0;

    return () => {
        hash += 0x6D2B79F5;
        let t = hash;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
