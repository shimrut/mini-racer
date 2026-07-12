import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedis = {
    hGet: vi.fn(),
    hSet: vi.fn(),
    hSetNX: vi.fn(),
    hGetAll: vi.fn(),
    expire: vi.fn(),
};

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: vi.fn(),
}));

describe('current daily gp week', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.expire.mockResolvedValue(true);
    });

    it('keeps the June 11, 2026 playlist stable from published history', async () => {
        const { getServerDailyGpPlaylist } = await import('../src/server/daily-gp-store.ts');

        const playlist = await getServerDailyGpPlaylist(new Date('2026-06-11T12:00:00.000Z'));

        expect(playlist.map((challenge) => challenge.trackKey)).toEqual([
            'lanternPier',
            'caspianBoulevard',
            'circuitPromax',
            'desertBridge',
            'turboShell',
            'harborPrincipality',
            'sunlitTemple',
        ]);
    });
});
