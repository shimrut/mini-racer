import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    LEADERBOARD_DECIMAL_PLACES_STORAGE_KEY,
    getLeaderboardDecimalPlaces,
    normalizeLeaderboardDecimalPlaces,
    setLeaderboardDecimalPlaces,
} from '../game/settings/leaderboard-decimal-places-preference.js';

describe('leaderboard decimal places preference', () => {
    const store = new Map();

    beforeEach(() => {
        store.clear();
        globalThis.window = {
            localStorage: {
                getItem: (key) => store.get(key) ?? null,
                setItem: (key, value) => store.set(key, String(value)),
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('defaults invalid and missing values to two decimal places', () => {
        expect(getLeaderboardDecimalPlaces()).toBe(2);
        expect(normalizeLeaderboardDecimalPlaces(1)).toBe(2);
        expect(normalizeLeaderboardDecimalPlaces(3.7)).toBe(2);
        expect(normalizeLeaderboardDecimalPlaces('5')).toBe(2);
        expect(normalizeLeaderboardDecimalPlaces(4)).toBe(3);
    });

    it.each([2, 3])('persists %i decimal places', (decimalPlaces) => {
        expect(setLeaderboardDecimalPlaces(decimalPlaces)).toBe(decimalPlaces);
        expect(store.get(LEADERBOARD_DECIMAL_PLACES_STORAGE_KEY)).toBe(String(decimalPlaces));
        expect(getLeaderboardDecimalPlaces()).toBe(decimalPlaces);
    });
});
