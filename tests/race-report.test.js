import { describe, expect, it, vi } from 'vitest';

vi.mock('../game/scoreboard/player-identity.js', () => ({
    getOrCreatePlayerId: vi.fn(() => 'player-1'),
    getGuestPlayerToken: vi.fn(() => 'token-1'),
}));

import { reportRaceStart, RACE_START_URL } from '../game/journeys/race-report.js';

describe('reportRaceStart', () => {

    it('reports Daily, Campaign, and Head to Head starts on the same path', () => {
        const fetch = vi.fn(async () => ({ ok: true }));

        for (const mode of ['daily', 'campaign', 'challenge']) {
            fetch.mockClear();
            reportRaceStart(mode, { fetch });
            expect(fetch).toHaveBeenCalledWith(RACE_START_URL, expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    mode,
                    playerId: 'player-1',
                    guestToken: 'token-1',
                }),
            }));
        }
    });

    it('does not report an unknown mode', () => {
        const fetch = vi.fn(async () => ({ ok: true }));
        reportRaceStart('home', { fetch });
        expect(fetch).not.toHaveBeenCalled();
    });
});
