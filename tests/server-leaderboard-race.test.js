import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLeaderboardRaceRoutes } from '../src/server/routes/leaderboard-race-routes.ts';

const mocks = vi.hoisted(() => ({
    redis: {
        incrBy: vi.fn(async () => 1),
        expire: vi.fn(async () => true),
        expireTime: vi.fn(async () => Math.floor(Date.now() / 1000) + 60),
    },
    prepareDaily: vi.fn(async () => ({ status: 200, body: { mode: 'daily' } })),
    prepareCampaign: vi.fn(async () => ({ status: 200, body: { mode: 'campaign' } })),
}));

vi.mock('@devvit/redis', () => ({ redis: mocks.redis }));
vi.mock('../src/server/daily-gp-store.js', () => ({
    prepareServerDailyLeaderboardRace: mocks.prepareDaily,
}));
vi.mock('../src/server/campaign-store.js', () => ({
    prepareServerCampaignLeaderboardRace: mocks.prepareCampaign,
}));

describe('leaderboard opponent race server contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.redis.incrBy.mockResolvedValue(1);
        mocks.redis.expire.mockResolvedValue(true);
        mocks.redis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 60);
        mocks.prepareDaily.mockResolvedValue({ status: 200, body: { mode: 'daily' } });
        mocks.prepareCampaign.mockResolvedValue({ status: 200, body: { mode: 'campaign' } });
    });

    it('dispatches Daily preparation after applying a trusted per-competition rate limit', async () => {
        const { prepareServerLeaderboardRace } = await import('../src/server/leaderboard-race-service.ts');
        const input = {
            mode: 'daily',
            challengeId: 'daily-gp-2026-07-27',
            requestRateLimitIdentity: 'trusted-request',
            selection: { kind: 'row', rank: 2 },
        };
        expect(await prepareServerLeaderboardRace(input)).toEqual({
            status: 200,
            body: { mode: 'daily' },
        });
        expect(mocks.redis.incrBy).toHaveBeenCalledWith(
            'leaderboard-race:prepare-rate-limit:daily-gp-2026-07-27:trusted-request',
            1,
        );
        expect(mocks.prepareDaily).toHaveBeenCalledWith(input);
        expect(mocks.prepareCampaign).not.toHaveBeenCalled();
    });

    it('rejects missing trusted identity and returns rate-limit retry metadata', async () => {
        const { prepareServerLeaderboardRace } = await import('../src/server/leaderboard-race-service.ts');
        await expect(prepareServerLeaderboardRace({
            mode: 'campaign',
            raceId: 'numbered-v1-00',
        })).resolves.toMatchObject({
            status: 401,
            body: { reason: 'identity_required' },
        });

        mocks.redis.incrBy.mockResolvedValue(13);
        mocks.redis.expireTime.mockResolvedValue(Math.floor(Date.now() / 1000) + 17);
        await expect(prepareServerLeaderboardRace({
            mode: 'campaign',
            raceId: 'numbered-v1-00',
            requestRateLimitIdentity: 'trusted-request',
        })).resolves.toMatchObject({
            status: 429,
            body: { reason: 'rate_limited', retryAfterSeconds: 17 },
        });
        expect(mocks.prepareCampaign).not.toHaveBeenCalled();
    });

    it('forwards only server-derived identity fields through the HTTP route', async () => {
        let handler;
        const app = {
            post: vi.fn((path, callback) => {
                expect(path).toBe('/api/leaderboard-race/prepare');
                handler = callback;
            }),
        };
        const prepareServerLeaderboardRace = vi.fn(async () => ({
            status: 200,
            body: {
                mode: 'campaign',
                target: { displayName: 'Opponent', bestTimeMs: 12345 },
            },
        }));
        registerLeaderboardRaceRoutes(app, {
            getRequestUsername: () => 'TrustedRedditor',
            getRequestRateLimitIdentity: () => 'trusted-request',
            prepareServerLeaderboardRace,
        });
        const status = vi.fn();
        const json = vi.fn();
        status.mockReturnValue({ json });
        await handler({
            body: {
                mode: 'campaign',
                raceId: 'numbered-v1-00',
                redditUsername: 'Spoofed',
                requestRateLimitIdentity: 'spoofed-request',
            },
        }, { status });

        expect(prepareServerLeaderboardRace).toHaveBeenCalledWith({
            mode: 'campaign',
            raceId: 'numbered-v1-00',
            redditUsername: 'TrustedRedditor',
            requestRateLimitIdentity: 'trusted-request',
        });
        expect(status).toHaveBeenCalledWith(200);
        expect(json).toHaveBeenCalledWith({
            mode: 'campaign',
            target: { displayName: 'Opponent', bestTimeMs: 12345 },
        });
    });
});
