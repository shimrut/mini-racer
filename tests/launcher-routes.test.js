import { describe, expect, it, vi } from 'vitest';
import { registerInternalRoutes } from '../src/server/routes/internal-routes.ts';

function createRouteHarness(overrides = {}) {
    const routes = new Map();
    const app = {
        post: (path, handler) => routes.set(path, handler),
    };
    const dependencies = {
        resolveMenuTargetSubredditName: vi.fn(async () => 'MiniRacer'),
        getServerDailyGpChallenge: vi.fn(async () => ({ id: 'daily-today' })),
        getServerFinalDailyGpPodium: vi.fn(async () => null),
        ensureDailyMiniRacerPostForSubreddit: vi.fn(async () => ({
            created: false,
            postUrl: 'https://reddit.com/frozen',
        })),
        ensureMiniRacerLauncherPostForSubreddit: vi.fn(async (_subreddit, kind) => ({
            created: true,
            postUrl: `https://reddit.com/${kind}`,
        })),
        enableDailyAutopost: vi.fn(),
        deleteDailyAutopostSubscription: vi.fn(),
        ensureDailyMiniRacerPodiumPostForSubreddit: vi.fn(),
        enableDailyPodiumAutopost: vi.fn(),
        deleteDailyPodiumAutopostSubscription: vi.fn(),
        readAllDailyAutopostSubscriptions: vi.fn(async () => []),
        readAllDailyPodiumAutopostSubscriptions: vi.fn(async () => []),
        ensureModeratorAnalyticsPostForSubreddit: vi.fn(async () => ({
            created: false,
            postUrl: 'https://reddit.com/analytics',
        })),
        ...overrides,
    };
    registerInternalRoutes(app, dependencies);
    return { routes, dependencies };
}

async function invoke(routes, path) {
    const response = { json: vi.fn() };
    await routes.get(path)({ body: { targetId: 't5_mini' } }, response);
    return response.json.mock.calls[0][0];
}

describe('launcher moderator routes', () => {
    it.each([
        ['daily', 'Current Daily launcher post', 'https://reddit.com/daily'],
        ['campaign', 'Campaign launcher post', 'https://reddit.com/campaign'],
        ['lobby', 'Lobby launcher post', 'https://reddit.com/lobby'],
    ])('creates the %s launcher and navigates to its post', async (kind, label, postUrl) => {
        const { routes, dependencies } = createRouteHarness();

        await expect(invoke(routes, `/internal/menu/launcher-${kind}-create`)).resolves.toEqual({
            showToast: {
                text: `${label} created for r/MiniRacer.`,
                appearance: 'success',
            },
            navigateTo: postUrl,
        });
        expect(dependencies.ensureMiniRacerLauncherPostForSubreddit)
            .toHaveBeenCalledWith('MiniRacer', kind);
    });

    it('returns a context toast when Reddit omits the subreddit target', async () => {
        const { routes } = createRouteHarness({
            resolveMenuTargetSubredditName: vi.fn(async () => null),
        });

        await expect(invoke(routes, '/internal/menu/launcher-lobby-create')).resolves.toEqual({
            showToast: {
                text: 'Reddit did not provide a subreddit context for this install.',
                appearance: 'neutral',
            },
        });
    });
});
