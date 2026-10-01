import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureStoredCatalogLoaded = vi.fn(async () => {});

vi.mock('../src/server/tracks/stored-catalog.ts', () => ({
    ensureStoredCatalogLoaded,
    StoredCatalogUnavailableError: class extends Error {},
}));

const { createServerApp } = await import('../src/server/server-app.ts');
const { registerAnalyticsRoutes } = await import('../src/server/routes/analytics-routes.ts');
const { registerCampaignRoutes } = await import('../src/server/routes/campaign-routes.ts');

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
        },
    };
}

async function startApp(dependencies) {
    const app = createServerApp({
        registerRoutes: (instance) => {
            registerCampaignRoutes(instance, dependencies.campaign);
            registerAnalyticsRoutes(instance, dependencies.analytics);
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

    it('lets the two analytics recorders and telemetry answer without the catalog', async () => {
        ensureStoredCatalogLoaded.mockRejectedValue(new Error('redis: timeout'));
        const dependencies = services();
        const baseUrl = await startApp(dependencies);
        expect((await post(`${baseUrl}/api/analytics/race-start`, { mode: 'daily' })).status).toBe(204);
        expect((await post(`${baseUrl}/api/analytics/podium`, { action: 'play' })).status).toBe(204);
        const telemetry = await post(`${baseUrl}/api/telemetry/journey/app-ready`, {});
        expect(telemetry.status).not.toBe(503);
        expect(ensureStoredCatalogLoaded).not.toHaveBeenCalled();
    });

    it('keeps the analytics summaries, other methods and unknown routes behind the gate', async () => {
        ensureStoredCatalogLoaded.mockRejectedValue(new Error('redis: timeout'));
        const dependencies = services();
        const baseUrl = await startApp(dependencies);
        expect((await fetch(`${baseUrl}/api/analytics/summary`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/analytics/guest-transfer?username=RaceFan`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/analytics/race-start`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/api/some/new-route`)).status).toBe(503);
        expect(dependencies.analytics.getServerAnalyticsSummary).not.toHaveBeenCalled();
    });
});
