import { describe, expect, it } from 'vitest';
import {
    cloneScoreboardSnapshot,
    createEmptyScoreboardSnapshot,
    normalizeScoreboardSnapshot,
} from '../game/scoreboard/snapshot.js';

describe('scoreboard snapshot wave 2', () => {
    it('preserves pagination metadata and hasMore flags', () => {
        const snapshot = normalizeScoreboardSnapshot({
            topRows: [],
            nearbyRows: [],
            totalCount: 40,
            pageOffset: 10,
            pageLimit: 5,
            hasMore: true,
            nextOffset: 15,
        });

        expect(snapshot).toMatchObject({
            pageOffset: 10,
            pageLimit: 5,
            hasMore: true,
            nextOffset: 15,
        });
        expect(snapshot.hasMore).toBe(true);
    });

    it('treats non-true hasMore values as false', () => {
        expect(normalizeScoreboardSnapshot({ hasMore: 'yes' }).hasMore).toBe(false);
        expect(normalizeScoreboardSnapshot({ hasMore: 1 }).hasMore).toBe(false);
    });

    it('defaults leaderboardEntryCount to totalCount only when entry count is nullish', () => {
        const withTotal = normalizeScoreboardSnapshot({ totalCount: 12 });
        const withExplicit = normalizeScoreboardSnapshot({
            totalCount: 12,
            leaderboardEntryCount: 4,
        });

        expect(withTotal.leaderboardEntryCount).toBe(12);
        expect(withExplicit.leaderboardEntryCount).toBe(4);
    });

    it('drops rows that cannot be normalized to objects', () => {
        const snapshot = normalizeScoreboardSnapshot({
            topRows: [null, 'bad', { bestTimeMs: 1000 }],
            nearbyRows: [undefined, { bestTimeSec: 12 }],
        });

        expect(snapshot.topRows).toHaveLength(1);
        expect(snapshot.nearbyRows).toHaveLength(1);
        expect(snapshot.topRows[0].bestTime).toBe(1);
        expect(snapshot.nearbyRows[0].bestTime).toBe(12);
    });

    it('clones pagination fields without mutating the source snapshot', () => {
        const source = normalizeScoreboardSnapshot({
            topRows: [{ bestTimeMs: 1000 }],
            totalCount: 1,
            pageOffset: 2,
            pageLimit: 3,
            hasMore: true,
            nextOffset: 5,
        });
        const cloned = cloneScoreboardSnapshot(source);

        cloned.pageOffset = 99;
        cloned.hasMore = false;

        expect(source.pageOffset).toBe(2);
        expect(source.hasMore).toBe(true);
        expect(cloned.topRows[0].bestTime).toBe(1);
    });

    it('returns a fully empty snapshot for nullish payloads', () => {
        expect(normalizeScoreboardSnapshot(null)).toEqual(createEmptyScoreboardSnapshot());
        expect(normalizeScoreboardSnapshot(undefined)).toEqual(createEmptyScoreboardSnapshot());
    });
});
