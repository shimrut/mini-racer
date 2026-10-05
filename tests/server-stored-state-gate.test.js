import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureStoredCatalogLoaded = vi.fn(async () => {});
const mockContext = vi.hoisted(() => ({ subredditId: 't5_gate' }));

vi.mock('@devvit/web/server', async (importOriginal) => ({
    ...(await importOriginal()),
    context: mockContext,
}));

vi.mock('../src/server/tracks/stored-catalog.ts', () => ({
    ensureStoredCatalogLoaded,
    StoredCatalogUnavailableError: class extends Error {},
}));

const { createServerApp } = await import('../src/server/server-app.ts');
const { registerAnalyticsRoutes } = await import('../src/server/routes/analytics-routes.ts');
const { registerCampaignRoutes } = await import('../src/server/routes/campaign-routes.ts');
const { registerTrackRoutes } = await import('../src/server/routes/track-routes.ts');
const seriesStore = await import('../src/server/campaign/series-store.ts');
const { TrackPlacementRetryError } = await import('../src/server/tracks/track-placement-lock.ts');
const { CAMPAIGN_SERIES } = await import('../game/campaign/manifest.js');

const openServers = new Set();

beforeEach(() => {
    ensureStoredCatalogLoaded.mockReset();
    ensureStoredCatalogLoaded.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
    openServers.clear();
});

function services() {
    return {
        campaign: {
            getRequestUsername: () => 'RaceFan',
            getRequestRateLimitIdentity: () => 'trusted-request',
            getServerCampaignBootstrap: vi.fn(async () => ({ status: 200, body: { campaignId: 'numbered-v1' } })),
            startServerCampaignRace: vi.fn(),
            getServerCampaignSnapshot: vi.fn(),
            submitServerCampaignRun: vi.fn(),
            getServerCampaignPbGhost: vi.fn(),
            describeStoredTracks: () => [],
        },
        analytics: {
            resolveAnalyticsToolSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit: vi.fn(async () => 'RaceMod'),
            getServerAnalyticsSummary: vi.fn(async () => ({})),
            getGuestProgressTransferDiagnostic: vi.fn(async () => ({})),
            getRequestUsername: () => 'RaceFan',
            recordRaceStart: vi.fn(async () => {}),
            recordPodiumEvent: vi.fn(async () => {}),
            recordChallengeEvent: vi.fn(async () => {}),
            getChallengeAnalyticsPage: vi.fn(async () => ({ items: [], nextOffset: null })),
        },
        tracks: {
            readPlacedStoredTracks: vi.fn(async () => []),
        },
    };
}

async function startApp(dependencies) {
    const app = createServerApp({
        registerRoutes: (instance) => {
            registerCampaignRoutes(instance, dependencies.campaign);
            registerAnalyticsRoutes(instance, dependencies.analytics);
            registerTrackRoutes(instance, dependencies.tracks);
        },
    });
    const server = app.listen(0, '127.0.0.1');
    openServers.add(server);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('the stored catalog gate', () => {
    it('answers 503 and runs no route when the catalog cannot load', async () => {
        ensureStoredCatalogLoaded.mockRejectedValue(new Error('redis: timeout'));
        const dependencies = services();
        const baseUrl = await startApp(dependencies);
        const response = await fetch(`${baseUrl}/api/campaign/bootstrap`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'The tracks could not load. Try again.' });
        expect(dependencies.campaign.getServerCampaignBootstrap).not.toHaveBeenCalled();
    });

    it('runs the route after the catalog loads', async () => {
        const dependencies = services();
        const baseUrl = await startApp(dependencies);
        const response = await fetch(`${baseUrl}/api/campaign/bootstrap`);
        expect(response.status).toBe(200);
        expect(ensureStoredCatalogLoaded).toHaveBeenCalledTimes(1);
        expect(dependencies.campaign.getServerCampaignBootstrap).toHaveBeenCalledTimes(1);
    });

    it('lets the analytics recorders and telemetry answer without the catalog', async () => {
        ensureStoredCatalogLoaded.mockRejectedValue(new Error('redis: timeout'));
        const dependencies = services();
        const baseUrl = await startApp(dependencies);
        expect((await post(`${baseUrl}/api/analytics/race-start`, { mode: 'daily' })).status).toBe(204);
        expect((await post(`${baseUrl}/api/analytics/podium`, { action: 'play' })).status).toBe(204);
        expect((await post(`${baseUrl}/api/analytics/challenge`, { action: 'view' })).status).toBe(204);
        const telemetry = await post(`${baseUrl}/api/telemetry/journey/app-ready`, {});
        expect(telemetry.status).not.toBe(503);
        expect(ensureStoredCatalogLoaded).not.toHaveBeenCalled();
    });

    it('lets the stored tracks request read its own tracks without the catalog', async () => {
        ensureStoredCatalogLoaded.mockRejectedValue(new Error('redis: timeout'));
        const dependencies = services();
        const baseUrl = await startApp(dependencies);
        const response = await fetch(`${baseUrl}/api/tracks/stored?keys=nightCut,roughCut`);
        expect(response.status).toBe(200);
        expect(dependencies.tracks.readPlacedStoredTracks).toHaveBeenCalledWith(['nightCut', 'roughCut']);
        expect(ensureStoredCatalogLoaded).not.toHaveBeenCalled();
    });

    it('answers retry when the stored tracks disagree', async () => {
        const dependencies = services();
        dependencies.tracks.readPlacedStoredTracks.mockRejectedValue(new TrackPlacementRetryError('The tracks could not load. Try again.'));
        const baseUrl = await startApp(dependencies);
        expect((await fetch(`${baseUrl}/api/tracks/stored?keys=nightCut`)).status).toBe(503);
    });

    it('keeps the analytics summaries, other methods and unknown routes behind the gate', async () => {
        ensureStoredCatalogLoaded.mockRejectedValue(new Error('redis: timeout'));
        const dependencies = services();
        const baseUrl = await startApp(dependencies);
        expect((await fetch(`${baseUrl}/api/analytics/summary`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/analytics/guest-transfer?username=RaceFan`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/analytics/race-start`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/analytics/challenge`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/analytics/challenges`)).status).toBe(503);
        expect((await post(`${baseUrl}/api/analytics/challenge/other`, { action: 'view' })).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/some/new-route`)).status).toBe(503);
        expect(dependencies.analytics.getServerAnalyticsSummary).not.toHaveBeenCalled();
    });
});

describe('one series list for each request', () => {
    function oneStageSeries(id, trackKey) {
        return Object.freeze({ id, name: id, ground: 'tarmac', stages: [{ trackKey, laps: 1, requiredMedals: 0 }] });
    }

    afterEach(() => seriesStore.clearStoredSeriesCacheForTests());

    it('gives a route the list it started with, while a later request gets the newer list', async () => {
        const night = oneStageSeries('night-v1', 'babylonRace');
        const dawn = oneStageSeries('dawn-v1', 'smallSteps');
        seriesStore.clearStoredSeriesCacheForTests();
        seriesStore.publishStoredSeriesSnapshot('t5_gate', { revision: '1', published: Object.freeze([night]) });
        const ids = () => CAMPAIGN_SERIES.map((series) => series.id);
        let reachedGate;
        const reached = new Promise((resolve) => { reachedGate = resolve; });
        let releaseGate;
        const gate = new Promise((resolve) => { releaseGate = resolve; });
        const app = createServerApp({
            registerRoutes: (instance) => {
                instance.get('/api/test/series', async (req, res) => {
                    const before = ids();
                    if (req.query.wait) {
                        reachedGate();
                        await gate;
                    }
                    res.json({ before, after: ids() });
                });
            },
        });
        const server = app.listen(0, '127.0.0.1');
        openServers.add(server);
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        const first = fetch(`${baseUrl}/api/test/series?wait=1`).then((response) => response.json());
        await reached;
        // Another request refreshed the cache with a newly published series.
        seriesStore.publishStoredSeriesSnapshot('t5_gate', { revision: '2', published: Object.freeze([night, dawn]) });
        const second = await (await fetch(`${baseUrl}/api/test/series`)).json();
        releaseGate();

        expect(await first).toEqual({
            before: ['numbered-v1', 'night-v1'],
            after: ['numbered-v1', 'night-v1'],
        });
        expect(second).toEqual({
            before: ['numbered-v1', 'night-v1', 'dawn-v1'],
            after: ['numbered-v1', 'night-v1', 'dawn-v1'],
        });
        // Code outside a request reads the cache.
        expect(ids()).toEqual(['numbered-v1', 'night-v1', 'dawn-v1']);
    });
});
