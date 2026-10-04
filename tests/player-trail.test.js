import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    PLAYER_TRAIL_COLORS,
    PLAYER_TRAIL_STORAGE_KEY,
    PLAYER_CAR_TRAILS_STORAGE_KEY,
    normalizeCarTrails,
    readPlayerCarTrails,
    applyPlayerCarTrails,
    readPlayerTrailId,
    readPlayerTrailStrokeStyle,
    trailStrokeStyleForId,
    writePlayerTrailId
} from '../game/car/player-trail.js';

describe('player trail color', () => {
    const store = new Map();

    beforeEach(() => {
        store.clear();
        globalThis.window = {
            localStorage: {
                getItem: (key) => (store.has(key) ? store.get(key) : null),
                setItem: (key, value) => {
                    store.set(key, String(value));
                },
                removeItem: (key) => {
                    store.delete(key);
                }
            }
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('defaults to sky when nothing is stored', () => {
        expect(readPlayerTrailId()).toBe('sky');
        expect(readPlayerTrailStrokeStyle()).toBe(trailStrokeStyleForId('sky'));
    });

    it('persists a valid trail id', () => {
        writePlayerTrailId('coral');
        expect(readPlayerTrailId()).toBe('coral');
        expect(readPlayerTrailStrokeStyle()).toBe(trailStrokeStyleForId('coral'));
    });

    it('falls back to sky for unknown stored values', () => {
        store.set(PLAYER_TRAIL_STORAGE_KEY, JSON.stringify('not-a-trail'));
        expect(readPlayerTrailId()).toBe('sky');
    });

    it('normalizes invalid writes to sky', () => {
        expect(writePlayerTrailId('nope')).toBe('sky');
    });

    it('lists every trail option with stroke and swatch', () => {
        expect(PLAYER_TRAIL_COLORS.length).toBeGreaterThan(3);
        for (const entry of PLAYER_TRAIL_COLORS) {
            expect(entry.id).toBeTruthy();
            expect(entry.label).toBeTruthy();
            expect(entry.strokeStyle).toMatch(/^rgba?\(/);
            expect(entry.swatch).toMatch(/^#/);
        }
    });

    it('keeps each skin independent, including No Trail, without changing the old fallback', () => {
        writePlayerTrailId('gold');
        writePlayerTrailId('coral', 'drawn/formula-red');
        writePlayerTrailId('none', 'drawn/formula-gold');
        writePlayerTrailId('white', 'assets/cars/mr_mr_red.webp');
        expect(readPlayerTrailId('drawn/formula-red')).toBe('coral');
        expect(readPlayerTrailStrokeStyle('drawn/formula-gold')).toBeNull();
        expect(readPlayerTrailId('assets/cars/mr_mr_red.webp')).toBe('white');
        expect(readPlayerTrailId('drawn/formula-arctic')).toBe('gold');
        expect(readPlayerTrailId()).toBe('gold');
        expect(readPlayerCarTrails()).toEqual({
            'drawn/formula-red': 'coral', 'drawn/formula-gold': 'none', 'assets/cars/mr_mr_red.webp': 'white',
        });
    });

    it('bounds saved trails to catalog skins and known colors, salvaging each entry independently', () => {
        expect(normalizeCarTrails({
            'drawn/formula-red': ' gold ', 'drawn/formula-gold': 'none',
            'drawn/formula-arctic': 'broken', 'drawn/missing': 'sky',
        })).toEqual({ 'drawn/formula-red': 'gold', 'drawn/formula-gold': 'none' });
        expect(normalizeCarTrails(['sky'])).toEqual({});
        writePlayerTrailId('white', 'unknown/car');
        expect(readPlayerCarTrails()).toEqual({});
    });

    it('replaces an owner map and clears it for an older profile instead of inheriting previous colors', () => {
        writePlayerTrailId('coral', 'drawn/formula-red');
        applyPlayerCarTrails({ 'drawn/formula-gold': 'none' });
        expect(readPlayerCarTrails()).toEqual({ 'drawn/formula-gold': 'none' });
        expect(readPlayerTrailId('drawn/formula-red')).toBe('sky');
        applyPlayerCarTrails(undefined);
        expect(readPlayerCarTrails()).toEqual({});
        expect(store.has(PLAYER_CAR_TRAILS_STORAGE_KEY)).toBe(false);
    });
});
