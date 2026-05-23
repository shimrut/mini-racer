import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getLeaderboardPlayerName,
    getScoreboardSnapshot,
    submitScoreboardBestTime
} from '../game/scoreboard/service.js';

const VALID_REPLAY = { inputs: [{ frames: 1, left: false, right: false }] };

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

    it('getLeaderboardPlayerName produces stable public labels and guards missing ids', () => {
        expect(getLeaderboardPlayerName('')).toBe('Anonymous Racer');
        expect(getLeaderboardPlayerName(null)).toBe('Anonymous Racer');
        expect(getLeaderboardPlayerName('player-123')).toBe(getLeaderboardPlayerName('player-123'));
        expect(getLeaderboardPlayerName('player-123')).not.toBe(getLeaderboardPlayerName('player-456'));
    });

    it('submitScoreboardBestTime short-circuits invalid payloads', async () => {
        await expect(submitScoreboardBestTime({})).resolves.toBe(null);
        await expect(submitScoreboardBestTime({
            trackKey: 'missing-track',
            bestTime: 20,
            replay: VALID_REPLAY
        })).resolves.toBe(null);
        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 1.5,
            replay: VALID_REPLAY
        })).resolves.toBe(null);
        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 3600.001,
            replay: VALID_REPLAY
        })).resolves.toBe(null);
        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: Number.NaN,
            replay: VALID_REPLAY
        })).resolves.toBe(null);
        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 20,
            replay: null
        })).resolves.toBe(null);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('submitScoreboardBestTime accepts the configured time boundaries', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ accepted: true })
        });

        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 2,
            replay: VALID_REPLAY
        })).resolves.toMatchObject({ ok: true });

        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 3600,
            replay: VALID_REPLAY
        })).resolves.toMatchObject({ ok: true });

        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('submitScoreboardBestTime uses the default endpoint and handles non-json responses', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            status: 204,
            json: async () => {
                throw new Error('not json');
            }
        });

        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 20.123,
            replay: VALID_REPLAY
        })).resolves.toEqual({
            ok: true,
            status: 204,
            body: null
        });

        expect(fetch).toHaveBeenCalledWith('/api/scoreboard/submit', expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"bestTime":20.123')
        }));
    });

    it('submitScoreboardBestTime returns structured responses', async () => {
        fetch
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ accepted: true, updated: true, bestTimeMs: 20123 })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ accepted: false, updated: false, throttled: true, retryAfterSeconds: 4 })
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 422,
                json: async () => ({ error: 'Submitted lap time does not match replay' })
            });

        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 20.123,
            replay: VALID_REPLAY
        })).resolves.toEqual({
            ok: true,
            status: 200,
            body: { accepted: true, updated: true, bestTimeMs: 20123 }
        });

        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 20.123,
            replay: VALID_REPLAY
        })).resolves.toEqual({
            ok: true,
            status: 200,
            body: { accepted: false, updated: false, throttled: true, retryAfterSeconds: 4 }
        });

        await expect(submitScoreboardBestTime({
            trackKey: 'circuit',
            bestTime: 20.123,
            replay: VALID_REPLAY
        })).resolves.toEqual({
            ok: false,
            status: 422,
            body: { error: 'Submitted lap time does not match replay' }
        });
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

        await getScoreboardSnapshot({ trackKey: 'circuit', limit: 500 });

        expect(fetch).toHaveBeenCalledWith('/api/scoreboard/snapshot', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                trackKey: 'circuit',
                playerId: '550e8400-e29b-41d4-a716-446655440000',
                leaderboardIdentity: 'constructed',
                limit: 100
            })
        }));
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
            playerRank: null,
            playerRankLabel: null
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
            topRows: [{ playerId: 'leader', bestTimeMs: 19000 }],
            nearbyRows: [{ playerId: 'nearby', bestTimeMs: 24000 }],
            currentPlayerRow: { playerId: 'me', bestTimeMs: 25000 },
            totalCount: 10,
            leaderboardEntryCount: 10,
            playerRank: 0,
            playerRankLabel: '0'
        });
    });
});
