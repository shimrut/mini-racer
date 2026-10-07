import { describe, expect, it, vi } from 'vitest';
import {
    getModeratorAnalyticsSummary,
    getModeratorStorageSummary,
} from '../src/server/moderator/moderator-analytics-summary.ts';

describe('moderator analytics payloads', () => {
    it('loads player counts for the Players tab, without the Redis size walk', async () => {
        const summary = { from: '2026-07-02', to: '2026-08-15', today: { players: 4 }, days: [], months: [] };
        await expect(getModeratorAnalyticsSummary({ getSummary: async () => summary })).resolves.toEqual(summary);
    });

    it('loads Redis occupancy, the raced-list fill and the ghost move for the Storage tab', async () => {
        const storage = { totalBytes: 2048, groups: [] };
        const racedListFill = { state: 'working', boardsDone: 3, boards: 40 };
        const dailyGhostArchive = { choice: 'all', moved: 12 };

        await expect(getModeratorStorageSummary({
            getStorage: async () => storage,
            getRacedListFill: async () => racedListFill,
            getDailyGhostArchive: async () => dailyGhostArchive,
        })).resolves.toEqual({ storage, racedListFill, dailyGhostArchive });
    });

    it('keeps each Storage part when another one fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const racedListFill = { state: 'done' };

        await expect(getModeratorStorageSummary({
            getStorage: async () => {
                throw new Error('Redis walk failed');
            },
            getRacedListFill: async () => racedListFill,
            getDailyGhostArchive: async () => {
                throw new Error('Redis read failed');
            },
        })).resolves.toEqual({ storage: null, racedListFill, dailyGhostArchive: null });
    });
});
