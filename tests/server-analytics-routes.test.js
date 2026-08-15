import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerApp } from '../src/server/server-app.ts';
import { registerAnalyticsRoutes } from '../src/server/routes/analytics-routes.ts';
import { registerInternalRoutes } from '../src/server/routes/internal-routes.ts';
import { registerPlayerRoutes } from '../src/server/routes/player-routes.ts';
import { registerCampaignRoutes } from '../src/server/routes/campaign-routes.ts';
import { registerCompetitionRoutes } from '../src/server/routes/competition-routes.ts';

const openServers = new Set();

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...openServers].map((server) => new Promise((resolve) => {
        server.close(resolve);
    })));
    openServers.clear();
});

async function startApp(registerRoutes) {
    const app = createServerApp({ registerRoutes });
    const server = app.listen(0, '127.0.0.1');
    openServers.add(server);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

describe('analytics route contracts', () => {
    it('requires a moderator and returns the summary', async () => {
        const getServerAnalyticsSummary = vi.fn(async () => ({ today: { uniquePlayers: 4 } }));
        const assertModeratorForSubreddit = vi.fn(async () => 'RaceMod');
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, {
            resolveAnalyticsToolSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit,
            getServerAnalyticsSummary,
        }));

        const response = await fetch(`${baseUrl}/api/analytics/summary`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ today: { uniquePlayers: 4 } });
        expect(assertModeratorForSubreddit).toHaveBeenCalledWith('MiniRacer');
    });

    it('forbids non-moderators', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, {
            resolveAnalyticsToolSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit: async () => {
                throw new Error('Moderator access required for r/MiniRacer.');
            },
            getServerAnalyticsSummary: vi.fn(),
        }));

        const response = await fetch(`${baseUrl}/api/analytics/summary`);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            error: 'Moderator access required for r/MiniRacer.',
        });
    });

    it('records presence, campaign starts, daily finishes, and opens the analytics post', async () => {
        const recordPlayerPresence = vi.fn();
        const recordCampaignStart = vi.fn();
        const recordDailyFinish = vi.fn();
        const ensureModeratorAnalyticsPostForSubreddit = vi.fn(async () => ({
            created: false,
            postUrl: 'https://reddit.com/analytics',
        }));
        const baseUrl = await startApp((app) => {
            registerPlayerRoutes(app, {
                getRequestUsername: () => 'RaceFan',
                recordPlayerPresence,
                getServerPlayerBootstrap: async () => ({
                    playerId: 'reddit:racefan',
                    firstSeenAt: '2026-08-01T00:00:00.000Z',
                }),
                selectServerGuestProgress: vi.fn(),
                updateServerPlayerIdentity: vi.fn(),
                updateServerPlayerPreferences: vi.fn(),
            });
            registerCampaignRoutes(app, {
                getRequestUsername: () => 'RaceFan',
                getRequestRateLimitIdentity: () => 'request',
                recordCampaignStart,
                getServerCampaignBootstrap: vi.fn(),
                startServerCampaignRace: async () => ({
                    status: 200,
                    body: { race: { trackKey: 'numberZero' } },
                }),
                getServerCampaignSnapshot: vi.fn(),
                submitServerCampaignRun: vi.fn(),
                getServerCampaignPbGhost: vi.fn(),
            });
            registerCompetitionRoutes(app, {
                getRequestUsername: () => 'RaceFan',
                getRequestRateLimitIdentity: () => 'request',
                recordDailyFinish,
                getPostBoundDailyGpChallenge: vi.fn(),
                getServerDailyGpChallenge: vi.fn(),
                getServerDailyGpPlaylist: vi.fn(),
                getServerDailyGpSnapshot: vi.fn(),
                submitServerDailyGpRun: async () => ({
                    status: 200,
                    body: { accepted: true },
                }),
                isDailyGpChallengePlayable: () => true,
            });
            registerInternalRoutes(app, {
                resolveMenuTargetSubredditName: async () => 'MiniRacer',
                getServerDailyGpChallenge: vi.fn(),
                getServerFinalDailyGpPodium: vi.fn(),
                ensureDailyMiniRacerPostForSubreddit: vi.fn(),
                ensureMiniRacerLauncherPostForSubreddit: vi.fn(),
                enableDailyAutopost: vi.fn(),
                deleteDailyAutopostSubscription: vi.fn(),
                ensureDailyMiniRacerPodiumPostForSubreddit: vi.fn(),
                enableDailyPodiumAutopost: vi.fn(),
                deleteDailyPodiumAutopostSubscription: vi.fn(),
                readAllDailyAutopostSubscriptions: vi.fn(),
                readAllDailyPodiumAutopostSubscriptions: vi.fn(),
                ensureModeratorAnalyticsPostForSubreddit,
            });
        });

        const bootstrap = await fetch(`${baseUrl}/api/player/bootstrap?playerId=guest-1`);
        expect(bootstrap.status).toBe(200);
        expect(recordPlayerPresence).toHaveBeenCalledWith(
            'reddit:racefan',
            '2026-08-01T00:00:00.000Z',
        );

        const campaign = await fetch(`${baseUrl}/api/campaign/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raceId: 'numbered-v1-00' }),
        });
        expect(campaign.status).toBe(200);
        expect(recordCampaignStart).toHaveBeenCalledWith('numberZero');

        const daily = await fetch(`${baseUrl}/api/daily/submit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ trackKey: 'circuit' }),
        });
        expect(daily.status).toBe(200);
        expect(recordDailyFinish).toHaveBeenCalledWith('circuit');

        const menu = await fetch(`${baseUrl}/internal/menu/mod-analytics-open`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetId: 't5_mini' }),
        });
        expect(await menu.json()).toEqual({
            showToast: {
                text: 'Opening Mini Racer analytics for r/MiniRacer.',
                appearance: 'success',
            },
            navigateTo: 'https://reddit.com/analytics',
        });
    });
});
