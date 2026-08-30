import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerApp } from '../src/server/server-app.ts';
import { registerAnalyticsRoutes } from '../src/server/routes/analytics-routes.ts';
import { registerInternalRoutes } from '../src/server/routes/internal-routes.ts';
import { registerPlayerRoutes } from '../src/server/routes/player-routes.ts';

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
            getRequestUsername: () => 'RaceFan',
            recordRaceStart: vi.fn(),
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
            getRequestUsername: () => 'RaceFan',
            recordRaceStart: vi.fn(),
        }));

        const response = await fetch(`${baseUrl}/api/analytics/summary`);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            error: 'Moderator access required for r/MiniRacer.',
        });
    });

    it('records a client-reported race start for Daily, Campaign, and Head to Head', async () => {
        const recordRaceStart = vi.fn(async () => {});
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, {
            resolveAnalyticsToolSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit: vi.fn(),
            getServerAnalyticsSummary: vi.fn(),
            getRequestUsername: () => 'RaceFan',
            recordRaceStart,
        }));

        for (const mode of ['daily', 'campaign', 'challenge']) {
            recordRaceStart.mockClear();
            const started = await fetch(`${baseUrl}/api/analytics/race-start`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ mode, playerId: 'guest-1', guestToken: 'token-1' }),
            });

            expect(started.status).toBe(204);
            await vi.waitFor(() => expect(recordRaceStart).toHaveBeenCalledWith({
                mode,
                playerId: 'guest-1',
                guestToken: 'token-1',
                redditUsername: 'RaceFan',
            }));
        }
    });

    it('no longer counts a player from the bootstrap request', async () => {
        const baseUrl = await startApp((app) => registerPlayerRoutes(app, {
            getRequestUsername: () => 'RaceFan',
            getServerPlayerBootstrap: async () => ({ playerId: 'reddit:racefan' }),
            selectServerGuestProgress: vi.fn(),
            updateServerPlayerIdentity: vi.fn(),
            updateServerPlayerPreferences: vi.fn(),
        }));

        const bootstrap = await fetch(`${baseUrl}/api/player/bootstrap?playerId=guest-1`);
        expect(bootstrap.status).toBe(200);
        expect(await bootstrap.json()).toEqual({ playerId: 'reddit:racefan' });
    });

    it('opens the analytics post from the moderator menu', async () => {
        const ensureModeratorAnalyticsPostForSubreddit = vi.fn(async () => ({
            created: false,
            postUrl: 'https://reddit.com/analytics',
        }));
        const baseUrl = await startApp((app) => registerInternalRoutes(app, {
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
        }));

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
