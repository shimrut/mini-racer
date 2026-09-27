import { describe, expect, it, vi } from 'vitest';
import { getModeratorAnalyticsSummary } from '../src/server/moderator/moderator-analytics-summary.ts';

describe('moderator analytics summary payload', () => {
    it('loads player counts and Redis occupancy together', async () => {
        const summary = { from: '2026-07-02', to: '2026-08-15', today: { players: 4 }, days: [], months: [] };
        const storage = { totalBytes: 2048, groups: [], notCounted: [] };

        const racedListFill = { state: 'working', boardsDone: 3, boards: 40 };

        await expect(getModeratorAnalyticsSummary({
            getSummary: async () => summary,
            getStorage: async () => storage,
            getRacedListFill: async () => racedListFill,
        })).resolves.toEqual({ ...summary, storage, racedListFill });
    });

    it('keeps player counts when Redis occupancy fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const summary = { from: '2026-07-02', to: '2026-08-15', today: { players: 4 }, days: [], months: [] };

        await expect(getModeratorAnalyticsSummary({
            getSummary: async () => summary,
            getStorage: async () => {
                throw new Error('Redis walk failed');
            },
            getRacedListFill: async () => {
                throw new Error('Redis read failed');
            },
        })).resolves.toEqual({ ...summary, storage: null, racedListFill: null });
    });
});
