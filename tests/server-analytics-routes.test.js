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
            recordPodiumEvent: vi.fn(),
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
            recordPodiumEvent: vi.fn(),
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
            recordPodiumEvent: vi.fn(),
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

    it('records Play Now and View Replays taps from the podium post', async () => {
        const recordPodiumEvent = vi.fn(async () => {});
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, {
            resolveAnalyticsToolSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit: vi.fn(),
            getServerAnalyticsSummary: vi.fn(),
            getRequestUsername: () => 'RaceFan',
            recordRaceStart: vi.fn(),
            recordPodiumEvent,
        }));

        for (const action of ['play', 'replay']) {
            recordPodiumEvent.mockClear();
            const recorded = await fetch(`${baseUrl}/api/analytics/podium`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action }),
            });

            expect(recorded.status).toBe(204);
            await vi.waitFor(() => expect(recordPodiumEvent).toHaveBeenCalledWith({ action }));
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

describe('client analytics acknowledgement', () => {
    const reports = [
        {
            path: '/api/analytics/race-start',
            recorder: 'recordRaceStart',
            body: { mode: 'campaign', playerId: 'guest-1', guestToken: 'token-1' },
            recorded: { mode: 'campaign', playerId: 'guest-1', guestToken: 'token-1', redditUsername: 'RaceFan' },
            failureLog: 'Failed to record Mini Racer race start:',
        },
        {
            path: '/api/analytics/podium',
            recorder: 'recordPodiumEvent',
            body: { action: 'play' },
            recorded: { action: 'play' },
            failureLog: 'Failed to record Mini Racer podium analytics:',
        },
        {
            path: '/api/analytics/challenge',
            recorder: 'recordChallengeEvent',
            body: { action: 'view' },
            recorded: { action: 'view' },
            failureLog: 'Failed to record Mini Racer challenge analytics:',
        },
    ];

    it.each(reports)('waits for recording before replying to $path', async ({ path, recorder, body, recorded }) => {
        let release;
        const pending = new Promise((resolve) => { release = resolve; });
        const record = vi.fn(() => pending);
        const routes = new Map();
        registerAnalyticsRoutes({
            post: (route, handler) => routes.set(route, handler),
            get: vi.fn(),
        }, {
            [recorder]: record,
            getRequestUsername: () => 'RaceFan',
        });
        const res = { status: vi.fn().mockReturnThis(), end: vi.fn() };
        const response = routes.get(path)({ body }, res);
        try {
            expect(record).toHaveBeenCalledWith(recorded);
            expect(res.status).not.toHaveBeenCalled();
            expect(res.end).not.toHaveBeenCalled();
        } finally {
            release();
            await response;
        }
        expect(res.status).toHaveBeenCalledWith(204);
        expect(res.end).toHaveBeenCalledOnce();
    });

    it.each(reports)('logs a recording failure and still replies 204 to $path', async ({ path, recorder, body, failureLog }) => {
        const error = new Error('Redis unavailable');
        const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, {
            [recorder]: vi.fn(async () => { throw error; }),
            getRequestUsername: () => 'RaceFan',
        }));
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(response.status).toBe(204);
        expect(logError).toHaveBeenCalledWith(failureLog, error);
    });
});

describe('guest transfer diagnostic route', () => {
    function diagnosticDependencies(overrides = {}) {
        return {
            resolveAnalyticsToolSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit: vi.fn(async () => 'RaceMod'),
            getServerAnalyticsSummary: vi.fn(),
            getGuestProgressTransferDiagnostic: vi.fn(async () => ({ found: true, reason: 'resumable' })),
            getRequestUsername: () => 'RaceMod',
            recordRaceStart: vi.fn(),
            recordPodiumEvent: vi.fn(),
            ...overrides,
        };
    }

    it('returns case evidence to a moderator for one named account', async () => {
        const dependencies = diagnosticDependencies();
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, dependencies));

        const response = await fetch(
            `${baseUrl}/api/analytics/guest-transfer?username=Stuck-Player&transferId=guest-transfer:abc`,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ found: true, reason: 'resumable' });
        expect(dependencies.assertModeratorForSubreddit).toHaveBeenCalledWith('MiniRacer');
        expect(dependencies.getGuestProgressTransferDiagnostic).toHaveBeenCalledWith({
            redditPlayerId: 'reddit:stuck-player',
            transferId: 'guest-transfer:abc',
        });
    });

    it('denies a non-moderator and reads no evidence at all', async () => {
        const getGuestProgressTransferDiagnostic = vi.fn();
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, diagnosticDependencies({
            assertModeratorForSubreddit: async () => {
                throw new Error('Moderator access required for r/MiniRacer.');
            },
            getGuestProgressTransferDiagnostic,
        })));

        const response = await fetch(`${baseUrl}/api/analytics/guest-transfer?username=Stuck-Player`);

        expect(response.status).toBe(403);
        expect(getGuestProgressTransferDiagnostic).not.toHaveBeenCalled();
    });

    it('needs an account to look at', async () => {
        const getGuestProgressTransferDiagnostic = vi.fn();
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, diagnosticDependencies({
            getGuestProgressTransferDiagnostic,
        })));

        const response = await fetch(`${baseUrl}/api/analytics/guest-transfer`);

        expect(response.status).toBe(400);
        expect(getGuestProgressTransferDiagnostic).not.toHaveBeenCalled();
    });

    it('keeps case evidence out of the ordinary log', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, diagnosticDependencies({
            getGuestProgressTransferDiagnostic: async () => {
                throw new Error('guest:secret-id lookup exploded');
            },
        })));

        const response = await fetch(`${baseUrl}/api/analytics/guest-transfer?username=Stuck-Player`);

        expect(response.status).toBe(500);
        for (const call of consoleError.mock.calls) {
            expect(JSON.stringify(call)).not.toContain('guest:secret-id');
        }
    });
});

describe('issued challenge analytics routes', () => {
    function dependencies(overrides = {}) {
        return {
            resolveAnalyticsToolSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit: vi.fn(async () => 'RaceMod'),
            getServerAnalyticsSummary: vi.fn(),
            getGuestProgressTransferDiagnostic: vi.fn(),
            getRequestUsername: () => null,
            recordRaceStart: vi.fn(),
            recordPodiumEvent: vi.fn(),
            recordChallengeEvent: vi.fn(async () => {}),
            getChallengeAnalyticsPage: vi.fn(async () => ({ date: '2026-10-05', items: [], nextOffset: null })),
            ...overrides,
        };
    }

    function postEvent(baseUrl, body) {
        return fetch(`${baseUrl}/api/analytics/challenge`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('reports view, Accept and author-open actions without forwarding browser targets', async () => {
        const services = dependencies();
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        for (const action of ['view', 'click', 'own_open']) {
            const response = await postEvent(baseUrl, {
                action, trackKey: 'forgedTrack', postId: 't3_forged', subredditName: 'Other', userId: 't2_forged',
                postData: { postType: 'head-to-head', challengeId: 'forged' },
            });
            expect(response.status).toBe(204);
            await vi.waitFor(() => expect(services.recordChallengeEvent).toHaveBeenCalledWith({ action }));
        }
        expect(services.assertModeratorForSubreddit).not.toHaveBeenCalled();
    });

    it('rejects invalid actions without recording', async () => {
        const services = dependencies();
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        for (const action of ['start', '', null, ['view']]) {
            expect((await postEvent(baseUrl, { action })).status).toBe(400);
        }
        expect(services.recordChallengeEvent).not.toHaveBeenCalled();
    });

    it('uses moderator context for the paginated listing', async () => {
        const result = { date: '2026-10-05', items: [{ trackKey: 'countryRoad', today: { views: 4 }, lifetime: { views: 30 } }], nextOffset: 50 };
        const services = dependencies({ getChallengeAnalyticsPage: vi.fn(async () => result) });
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        const response = await fetch(`${baseUrl}/api/analytics/challenges?offset=25&subredditName=Forged`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(result);
        expect(services.assertModeratorForSubreddit).toHaveBeenCalledWith('MiniRacer');
        expect(services.getChallengeAnalyticsPage).toHaveBeenCalledWith('MiniRacer', 25);
    });

    it('defaults to the first track page and does not require a client identity', async () => {
        const services = dependencies();
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        expect((await fetch(`${baseUrl}/api/analytics/challenges`)).status).toBe(200);
        expect(services.getChallengeAnalyticsPage).toHaveBeenCalledWith('MiniRacer', 0);
    });

    it('denies non-moderators before reading catalog or counts', async () => {
        const services = dependencies({ assertModeratorForSubreddit: vi.fn(async () => { throw new Error('Moderator access required for r/MiniRacer.'); }) });
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        expect((await fetch(`${baseUrl}/api/analytics/challenges`)).status).toBe(403);
        expect(services.getChallengeAnalyticsPage).not.toHaveBeenCalled();
    });

    it('rejects missing subreddit context', async () => {
        const services = dependencies({ resolveAnalyticsToolSubredditName: async () => null });
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        expect((await fetch(`${baseUrl}/api/analytics/challenges`)).status).toBe(400);
        expect(services.assertModeratorForSubreddit).not.toHaveBeenCalled();
        expect(services.getChallengeAnalyticsPage).not.toHaveBeenCalled();
    });

    it.each(['-1', '1.5', 'NaN', '9007199254740991', '', '0&offset=1', 'Infinity'])('rejects invalid offset %s', async (value) => {
        const services = dependencies();
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        expect((await fetch(`${baseUrl}/api/analytics/challenges?offset=${value}`)).status).toBe(400);
        expect(services.getChallengeAnalyticsPage).not.toHaveBeenCalled();
    });

    it('surfaces metric read failure instead of returning zeroes', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const services = dependencies({ getChallengeAnalyticsPage: vi.fn(async () => { throw new Error('Redis unavailable'); }) });
        const baseUrl = await startApp((app) => registerAnalyticsRoutes(app, services));
        const response = await fetch(`${baseUrl}/api/analytics/challenges`);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'Redis unavailable' });
    });
});
