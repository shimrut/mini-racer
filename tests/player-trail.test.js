import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    PLAYER_TRAIL_COLORS,
    PLAYER_TRAIL_STORAGE_KEY,
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
});
