import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerApp } from '../src/server/server-app.ts';
import { registerCampaignRoutes } from '../src/server/routes/campaign-routes.ts';

const openServers = new Set();

afterEach(async () => {
    await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
    openServers.clear();
});

async function startApp(dependencies) {
    const app = createServerApp({
        registerRoutes: (instance) => registerCampaignRoutes(instance, dependencies),
    });
    const server = app.listen(0, '127.0.0.1');
    openServers.add(server);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

function dependencies(overrides = {}) {
    return {
        getRequestUsername: () => 'RaceFan',
        getRequestRateLimitIdentity: () => 'trusted-request',
        getServerCampaignBootstrap: vi.fn(async () => ({ status: 200, body: { campaignId: 'numbered-v1' } })),
        startServerCampaignRace: vi.fn(async () => ({ status: 200, body: { race: {} } })),
        getServerCampaignSnapshot: vi.fn(async () => ({ status: 200, body: { rows: [] } })),
        submitServerCampaignRun: vi.fn(async () => ({ status: 200, body: { accepted: true } })),
        getServerCampaignPbGhost: vi.fn(async () => ({ status: 200, body: { personalBest: null } })),
        ...overrides,
    };
}

describe('Campaign route contracts', () => {
    it('forwards only trusted Reddit identity into Campaign mutations', async () => {
        const deps = dependencies();
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/submit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                redditUsername: 'spoofed',
                replay: { inputs: [] },
            }),
        });

        expect(response.status).toBe(200);
        expect(deps.submitServerCampaignRun).toHaveBeenCalledWith({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            redditUsername: 'RaceFan',
            requestRateLimitIdentity: 'trusted-request',
            replay: { inputs: [] },
        });
        expect(deps.submitServerCampaignRun.mock.calls[0]).toHaveLength(1);
    });

    it('registers bootstrap, start, snapshot, and PB ghost endpoints', async () => {
        const deps = dependencies();
        const baseUrl = await startApp(deps);
        await expect(fetch(`${baseUrl}/api/campaign/bootstrap`).then((response) => response.status)).resolves.toBe(200);
        await expect(fetch(`${baseUrl}/api/campaign/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raceId: 'numbered-v1-00' }),
        }).then((response) => response.status)).resolves.toBe(200);
        await expect(fetch(`${baseUrl}/api/campaign/snapshot?raceId=numbered-v1-00&limit=20&offset=10`).then((response) => response.status)).resolves.toBe(200);
        await expect(fetch(`${baseUrl}/api/campaign/pb-ghost?raceId=numbered-v1-00`).then((response) => response.status)).resolves.toBe(200);
        expect(deps.getServerCampaignSnapshot).toHaveBeenCalledWith({
            raceId: 'numbered-v1-00',
            limit: 20,
            offset: 10,
            redditUsername: 'RaceFan',
        });
    });
});
