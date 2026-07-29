import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({
    getGuestPlayerToken: vi.fn(() => 'guest-token'),
    getOrCreatePlayerId: vi.fn(() => 'guest-id'),
    setGuestPlayerToken: vi.fn(),
}));
const environment = vi.hoisted(() => ({
    isLocalEnvironment: vi.fn(() => false),
}));

vi.mock('../game/scoreboard/player-identity.js', () => identity);
vi.mock('../game/track/environment.js', () => environment);

const { prepareLeaderboardOpponentRace } = await import(
    '../game/scoreboard/opponent-race-service.js'
);

describe('leaderboard opponent race service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        environment.isLocalEnvironment.mockReturnValue(false);
    });

    it('prepares a Daily row with guest credentials and a versioned selection', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ guestToken: 'rotated', target: { displayName: 'Rival' } }),
        });

        const response = await prepareLeaderboardOpponentRace({
            mode: 'daily',
            competitionId: 'daily-1',
            entry: {
                rank: 4,
                displayName: 'Rival',
                bestTimeMs: 12_345,
                updatedAt: '2026-07-27T08:00:00.000Z',
            },
            fetchImpl,
        });

        expect(response.ok).toBe(true);
        const [, request] = fetchImpl.mock.calls[0];
        expect(JSON.parse(request.body)).toEqual({
            mode: 'daily',
            challengeId: 'daily-1',
            playerId: 'guest-id',
            guestToken: 'guest-token',
            selection: {
                kind: 'row',
                rank: 4,
                displayName: 'Rival',
                bestTimeMs: 12_345,
                updatedAt: '2026-07-27T08:00:00.000Z',
            },
        });
        expect(identity.setGuestPlayerToken).toHaveBeenCalledWith('rotated');
    });

    it('uses a local Campaign benchmark only for next-faster resolution', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ target: { displayName: 'Next Rival' } }),
        });

        await prepareLeaderboardOpponentRace({
            mode: 'campaign',
            competitionId: 'numbered-v1-00',
            nextFasterThanMs: 9_876,
            fetchImpl,
        });

        const [, request] = fetchImpl.mock.calls[0];
        expect(JSON.parse(request.body)).toEqual({
            mode: 'campaign',
            raceId: 'numbered-v1-00',
            selection: {
                kind: 'next-faster',
                benchmarkTimeMs: 9_876,
            },
        });
        expect(identity.getOrCreatePlayerId).not.toHaveBeenCalled();
    });

    it('rejects malformed rows before making a request', async () => {
        const fetchImpl = vi.fn();
        const response = await prepareLeaderboardOpponentRace({
            mode: 'daily',
            competitionId: 'daily-1',
            entry: { rank: 1 },
            fetchImpl,
        });

        expect(response.status).toBe(400);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
