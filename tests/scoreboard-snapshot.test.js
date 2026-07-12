import { describe, expect, it } from 'vitest';
import {
    cloneScoreboardSnapshot,
    createEmptyScoreboardSnapshot,
    normalizeScoreboardSnapshot,
} from '../game/scoreboard/snapshot.js';

describe('scoreboard snapshot contract', () => {
    it('creates a complete empty snapshot', () => {
        expect(createEmptyScoreboardSnapshot()).toEqual({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            leaderboardEntryCount: 0,
            objectiveType: null,
            playerRank: null,
            playerRankLabel: null,
            pageOffset: 0,
            pageLimit: 0,
            hasMore: false,
            nextOffset: null,
        });
    });

    it('normalizes malformed collections and invalid counts', () => {
        expect(normalizeScoreboardSnapshot({
            topRows: 'invalid',
            nearbyRows: null,
            currentPlayerRow: 'invalid',
            totalCount: -3,
            leaderboardEntryCount: 'invalid',
        })).toEqual(createEmptyScoreboardSnapshot());
    });

    it('normalizes row times in seconds-first order and completed laps', () => {
        const snapshot = normalizeScoreboardSnapshot({
            topRows: [
                { id: 'best', bestTime: '12.5', bestTimeSec: 13, bestTimeMs: 14000 },
                { id: 'seconds', bestTime: 'invalid', bestTimeSec: '13.25', bestTimeMs: 14000 },
                { id: 'milliseconds', bestTimeMs: '14500' },
            ],
            nearbyRows: [],
            currentPlayerRow: { bestTimeMs: 15000, completedLaps: '2.9' },
            totalCount: '4.8',
            leaderboardEntryCount: '3.9',
            objectiveType: 'single_lap_fastest',
            playerRank: '2',
            playerRankLabel: 2,
        });

        expect(snapshot.topRows.map((row) => row.bestTime)).toEqual([12.5, 13.25, 14.5]);
        expect(snapshot.currentPlayerRow).toMatchObject({ bestTime: 15, completedLaps: 2 });
        expect(snapshot).toMatchObject({
            totalCount: 4,
            leaderboardEntryCount: 3,
            objectiveType: 'single_lap_fastest',
            playerRank: 2,
            playerRankLabel: '2',
        });
    });

    it('clones rows and checkpoint arrays without shared mutable references', () => {
        const source = normalizeScoreboardSnapshot({
            topRows: [{ id: 'leader', checkpointTimesSec: [1, 2] }],
            nearbyRows: [{ id: 'nearby', checkpointTimesSec: [3, 4] }],
            currentPlayerRow: { id: 'me', checkpointTimesSec: [5, 6] },
        });
        const cloned = cloneScoreboardSnapshot(source);

        cloned.topRows[0].id = 'changed';
        cloned.topRows[0].checkpointTimesSec[0] = 99;
        cloned.nearbyRows[0].checkpointTimesSec[0] = 99;
        cloned.currentPlayerRow.checkpointTimesSec[0] = 99;

        expect(cloned.playerRank).toBe(null);
        expect(source.topRows[0]).toEqual({ id: 'leader', checkpointTimesSec: [1, 2] });
        expect(source.nearbyRows[0].checkpointTimesSec).toEqual([3, 4]);
        expect(source.currentPlayerRow.checkpointTimesSec).toEqual([5, 6]);
    });
});
