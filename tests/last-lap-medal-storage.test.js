import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    readTrackLastLapMedal,
    writeTrackLastLapMedal,
} from '../game/medals/last-lap-medal-storage.js';

const STORAGE_KEY = 'VectorGpTrackLastLapMedal';

describe('track best medal storage', () => {
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
                },
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('never downgrades when a later lap earns a worse medal', () => {
        writeTrackLastLapMedal('circuit', 'gold');
        expect(readTrackLastLapMedal('circuit')).toBe('gold');
        writeTrackLastLapMedal('circuit', 'bronze');
        expect(readTrackLastLapMedal('circuit')).toBe('gold');
    });

    it('keeps the best tier after a lap with no medal', () => {
        writeTrackLastLapMedal('circuit', 'gold');
        writeTrackLastLapMedal('circuit', null);
        expect(readTrackLastLapMedal('circuit')).toBe('gold');
    });

    it('removes legacy none entries when nothing is earned', () => {
        store.set(STORAGE_KEY, JSON.stringify({ circuit: 'none' }));
        writeTrackLastLapMedal('circuit', null);
        const map = JSON.parse(store.get(STORAGE_KEY));
        expect(map.circuit).toBeUndefined();
        expect(readTrackLastLapMedal('circuit')).toBe(null);
    });
});
