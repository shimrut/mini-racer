import { describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';

const mockRedis = new RedisTestDouble();

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('../src/server/competition/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: vi.fn(),
}));

describe('current daily gp week', () => {
    it('keeps the June 11, 2026 playlist stable from published history', async () => {
        const { getServerDailyGpPlaylist } = await import('../src/server/daily/daily-gp-store.ts');

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
