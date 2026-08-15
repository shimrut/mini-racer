import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAILY_GP_REDIS_TTL_SECONDS } from '../src/server/daily-gp-model.ts';

const hashes = new Map();
const mockRedis = {
    hSetNX: vi.fn(async (key, field, value) => {
        const hash = hashes.get(key) ?? new Map();
        if (hash.has(field)) return 0;
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
    }),
    hIncrBy: vi.fn(async (key, field, amount) => {
        const hash = hashes.get(key) ?? new Map();
        const next = Number(hash.get(field) || 0) + amount;
        hash.set(field, String(next));
        hashes.set(key, hash);
        return next;
    }),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? [])),
    expire: vi.fn(async () => true),
};

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));

const now = new Date('2026-08-15T12:00:00.000Z');

describe('server analytics store', () => {
    beforeEach(() => {
        hashes.clear();
        vi.clearAllMocks();
    });

    it('counts a player once per UTC day and classifies new vs returning from firstSeenAt', async () => {
        const {
            recordAnalyticsPresence,
            getServerAnalyticsSummary,
        } = await import('../src/server/analytics-store.ts');

        await recordAnalyticsPresence({
            playerId: 'reddit:racefan',
            firstSeenAt: '2026-08-15T01:00:00.000Z',
            now,
        });
        await recordAnalyticsPresence({
            playerId: 'reddit:racefan',
            firstSeenAt: '2026-08-15T01:00:00.000Z',
            now,
        });
        await recordAnalyticsPresence({
            playerId: 'guest:otter',
            firstSeenAt: '2026-07-01T00:00:00.000Z',
            now,
        });

        expect(mockRedis.hSetNX).toHaveBeenCalledWith(
            'dailygp:analytics:2026-08-15:players',
            'reddit:racefan',
            '1',
        );
        expect(mockRedis.expire).toHaveBeenCalledWith(
            'dailygp:analytics:2026-08-15:counters',
            DAILY_GP_REDIS_TTL_SECONDS,
        );

        const summary = await getServerAnalyticsSummary({ now });
        expect(summary.today).toMatchObject({
            date: '2026-08-15',
            uniquePlayers: 2,
            newPlayers: 1,
            returningPlayers: 1,
        });
        expect(summary.windows).toEqual([
            expect.objectContaining({ days: 7, uniquePlayers: 2, playerDays: 2 }),
            expect.objectContaining({ days: 14, uniquePlayers: 2, playerDays: 2 }),
            expect.objectContaining({ days: 30, uniquePlayers: 2, playerDays: 2 }),
        ]);
    });

    it('unions unique players across retained days without double-counting', async () => {
        const {
            recordAnalyticsPresence,
            getServerAnalyticsSummary,
        } = await import('../src/server/analytics-store.ts');

        await recordAnalyticsPresence({
            playerId: 'reddit:racefan',
            firstSeenAt: '2026-08-01T00:00:00.000Z',
            now: new Date('2026-08-14T12:00:00.000Z'),
        });
        await recordAnalyticsPresence({
            playerId: 'reddit:racefan',
            firstSeenAt: '2026-08-01T00:00:00.000Z',
            now,
        });
        await recordAnalyticsPresence({
            playerId: 'guest:new',
            firstSeenAt: '2026-08-15T00:00:00.000Z',
            now,
        });

        const summary = await getServerAnalyticsSummary({ now });
        expect(summary.windows.find((window) => window.days === 7)).toMatchObject({
            uniquePlayers: 2,
            playerDays: 3,
        });
    });

    it('records daily, campaign, and challenge plays on known tracks only', async () => {
        const {
            recordAnalyticsPlay,
            getServerAnalyticsSummary,
        } = await import('../src/server/analytics-store.ts');

        await recordAnalyticsPlay({
            mode: 'daily',
            action: 'finish',
            trackKey: 'circuit',
            now,
        });
        await recordAnalyticsPlay({
            mode: 'campaign',
            action: 'start',
            trackKey: 'numberZero',
            now,
        });
        await recordAnalyticsPlay({
            mode: 'challenge',
            action: 'create',
            trackKey: 'circuit',
            now,
        });
        await recordAnalyticsPlay({
            mode: 'challenge',
            action: 'finish',
            trackKey: 'circuit',
            now,
        });
        await recordAnalyticsPlay({
            mode: 'daily',
            action: 'finish',
            trackKey: 'not-a-track',
            now,
        });
        await recordAnalyticsPlay({
            mode: 'daily',
            action: 'start',
            trackKey: 'circuit',
            now,
        });

        const summary = await getServerAnalyticsSummary({ now });
        expect(summary.today).toMatchObject({
            dailyFinishes: 1,
            campaignStarts: 1,
            challengeCreates: 1,
            challengeFinishes: 1,
        });
        expect(summary.tracks.daily).toEqual([
            { trackKey: 'circuit', trackName: 'Classic Circuit', count: 1 },
        ]);
        expect(summary.tracks.campaign).toEqual([
            { trackKey: 'numberZero', trackName: 'Number Zero', count: 1 },
        ]);
        expect(summary.tracks.challenge).toEqual([
            { trackKey: 'circuit', trackName: 'Classic Circuit', count: 2 },
        ]);
    });

    it('swallows redis failures so gameplay callers stay unblocked', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mockRedis.hSetNX.mockRejectedValueOnce(new Error('redis down'));
        const { recordAnalyticsPresence } = await import('../src/server/analytics-store.ts');
        await expect(recordAnalyticsPresence({
            playerId: 'reddit:racefan',
            firstSeenAt: '2026-08-15T00:00:00.000Z',
            now,
        })).resolves.toBeUndefined();
    });
});
