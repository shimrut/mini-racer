import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    hGet: vi.fn(),
    hMGet: vi.fn(),
    hSet: vi.fn(),
    hSetNX: vi.fn(),
    hGetAll: vi.fn(),
    hScan: vi.fn(),
    hDel: vi.fn(),
    expire: vi.fn(),
    incrBy: vi.fn(),
};

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('../src/server/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: vi.fn(),
}));

describe('current daily gp week', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue(null);
        mockRedis.set.mockResolvedValue('OK');
        mockRedis.del.mockResolvedValue(undefined);
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hMGet.mockImplementation(async (_key, fields) => fields.map(() => null));
        mockRedis.hSet.mockResolvedValue(1);
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.hScan.mockResolvedValue({ cursor: 0, fieldValues: [] });
        mockRedis.hDel.mockResolvedValue(0);
        mockRedis.expire.mockResolvedValue(true);
        mockRedis.incrBy.mockResolvedValue(0);
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
