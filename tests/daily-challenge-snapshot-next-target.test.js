import { describe, expect, it } from 'vitest';
import { getBestTimeOneRankAbove } from '../game/daily-challenge/snapshot-next-target.js';

describe('getBestTimeOneRankAbove', () => {
    it('returns null when rank is missing or already first', () => {
        expect(getBestTimeOneRankAbove({ playerRank: null, topRows: [], nearbyRows: [] })).toBe(null);
        expect(getBestTimeOneRankAbove({ playerRank: 1, topRows: [{ rank: 1, bestTime: 9 }], nearbyRows: [] })).toBe(null);
    });

    it('finds the row with rank one better than the player in topRows', () => {
        const snapshot = {
            playerRank: 3,
            topRows: [
                { rank: 1, bestTime: 10.0 },
                { rank: 2, bestTime: 10.5 },
                { rank: 3, bestTime: 11.0 },
            ],
            nearbyRows: [],
        };
        expect(getBestTimeOneRankAbove(snapshot)).toBe(10.5);
    });

    it('finds the row in nearbyRows when not duplicated in top', () => {
        const snapshot = {
            playerRank: 12,
            topRows: [
                { rank: 1, bestTime: 9.0 },
                { rank: 2, bestTime: 9.1 },
            ],
            nearbyRows: [
                { rank: 10, bestTime: 10.0 },
                { rank: 11, bestTime: 10.2 },
                { rank: 12, bestTime: 10.4 },
            ],
        };
        expect(getBestTimeOneRankAbove(snapshot)).toBe(10.2);
    });
});
