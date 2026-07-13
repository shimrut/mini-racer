import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getScoreboardSnapshot
} from '../game/scoreboard/service.js';

describe('scoreboard service', () => {
    beforeEach(() => {
        globalThis.window = {
            localStorage: {
                getItem: vi.fn().mockReturnValue('550e8400-e29b-41d4-a716-446655440000'),
                setItem: vi.fn()
            }
        };
        globalThis.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('getScoreboardSnapshot returns an empty snapshot for invalid track without fetching', async () => {
        await expect(getScoreboardSnapshot({ trackKey: 'missing-track' })).resolves.toMatchObject({
            totalCount: 0,
            topRows: []
        });

        expect(fetch).not.toHaveBeenCalled();
    });

    it('getScoreboardSnapshot sends the proxy request with a clamped limit', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                topRows: [],
                nearbyRows: [],
                currentPlayerRow: null,
                totalCount: 0,
                playerRank: null,
                playerRankLabel: null
            })
        });

        await getScoreboardSnapshot({ trackKey: 'circuit', limit: 500, offset: 125 });

        expect(fetch).toHaveBeenCalledWith(
            'http://localhost/api/scoreboard/snapshot?trackKey=circuit&playerId=550e8400-e29b-41d4-a716-446655440000&guestToken=550e8400-e29b-41d4-a716-446655440000&limit=100&offset=125',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('getScoreboardSnapshot normalizes malformed proxy snapshot fields', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                topRows: 'not rows',
                nearbyRows: 'not nearby rows',
                currentPlayerRow: 'not a row',
                totalCount: '3',
                playerRank: 'not-a-rank',
                playerRankLabel: null
            })
        });

        await expect(getScoreboardSnapshot({ trackKey: 'circuit' })).resolves.toEqual({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 3,
            leaderboardEntryCount: 3,
            objectiveType: null,
            playerRank: null,
            playerRankLabel: null,
            pageOffset: 0,
            pageLimit: 0,
            hasMore: false,
            nextOffset: null,
        });
    });

    it('getScoreboardSnapshot preserves valid proxy row arrays and object current-player row', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                topRows: [{ playerId: 'leader', bestTimeMs: 19000 }],
                nearbyRows: [{ playerId: 'nearby', bestTimeMs: 24000 }],
                currentPlayerRow: { playerId: 'me', bestTimeMs: 25000 },
                totalCount: 10,
                playerRank: 0,
                playerRankLabel: '0'
            })
        });

        await expect(getScoreboardSnapshot({ trackKey: 'circuit' })).resolves.toEqual({
            topRows: [{ playerId: 'leader', bestTimeMs: 19000, bestTime: 19 }],
            nearbyRows: [{ playerId: 'nearby', bestTimeMs: 24000, bestTime: 24 }],
            currentPlayerRow: { playerId: 'me', bestTimeMs: 25000, bestTime: 25 },
            totalCount: 10,
            leaderboardEntryCount: 10,
            objectiveType: null,
            playerRank: 0,
            playerRankLabel: '0',
            pageOffset: 0,
            pageLimit: 0,
            hasMore: false,
            nextOffset: null,
        });
    });

    it('rejects network failures instead of returning an empty successful snapshot', async () => {
        fetch.mockRejectedValue(new Error('Network error'));

        await expect(getScoreboardSnapshot({ trackKey: 'circuit' }))
            .rejects.toThrow('Network error');
    });
});
