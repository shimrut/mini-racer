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
        getServerCampaignPoster: vi.fn(async () => ({
            status: 200, body: { seriesId: 'hahah', trackKey: 'finalRoad', ground: 'tarmac', grounds: ['tarmac', 'dirt'] },
        })),
        startServerCampaignRace: vi.fn(async () => ({ status: 200, body: { race: {} } })),
        getServerCampaignSnapshot: vi.fn(async () => ({ status: 200, body: { rows: [] } })),
        getServerCampaignAggregate: vi.fn(async () => ({ status: 200, body: { ready: true, totalTimeMs: 12345 } })),
        submitServerCampaignRun: vi.fn(async () => ({ status: 200, body: { accepted: true } })),
        getServerCampaignPbGhost: vi.fn(async () => ({ status: 200, body: { personalBest: null } })),
        previewServerCampaignResultsShare: vi.fn(async () => ({ status: 200, body: { status: 'ready', shareToken: 'preview-token' } })),
        confirmServerCampaignResultsShare: vi.fn(async () => ({ status: 200, body: { status: 'shared' } })),
        markServerCampaignResultsSharePending: vi.fn(async () => {}),
        refreshServerCampaignResultsShare: vi.fn(async () => {}),
        readContextSubredditName: () => 'MiniRacer',
        ...overrides,
    };
}

describe('Campaign route contracts', () => {
    it('loads only the final public track for anonymous poster recovery without gameplay work', async () => {
        const storedTracks = [{ key: 'finalRoad', track: { name: 'Final Road' } }];
        const deps = dependencies({
            getRequestUsername: vi.fn(() => null),
            refreshStoredCatalog: vi.fn(async () => {}),
            loadStoredTracks: vi.fn(async () => {}),
            describeStoredTracks: vi.fn(() => storedTracks),
            describeStoredSeries: vi.fn(),
        });
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/poster?seriesId=hahah&trackKey=privateDraft&playerId=other&redditUsername=spoofed`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            seriesId: 'hahah', trackKey: 'finalRoad', ground: 'tarmac', grounds: ['tarmac', 'dirt'], storedTracks,
        });
        expect(deps.refreshStoredCatalog).toHaveBeenCalledOnce();
        expect(deps.getServerCampaignPoster).toHaveBeenCalledWith({ seriesId: 'hahah' });
        expect(deps.refreshStoredCatalog.mock.invocationCallOrder[0]).toBeLessThan(deps.getServerCampaignPoster.mock.invocationCallOrder[0]);
        expect(deps.loadStoredTracks).toHaveBeenCalledWith(['finalRoad']);
        expect(deps.describeStoredTracks).toHaveBeenCalledWith(['finalRoad']);
        expect(deps.describeStoredSeries).not.toHaveBeenCalled();
        expect(deps.getRequestUsername).not.toHaveBeenCalled();
        expect(deps.getServerCampaignBootstrap).not.toHaveBeenCalled();
        expect(deps.getServerCampaignSnapshot).not.toHaveBeenCalled();
        expect(deps.getServerCampaignAggregate).not.toHaveBeenCalled();
        expect(deps.refreshServerCampaignResultsShare).not.toHaveBeenCalled();
    });

    it('keeps unavailable poster series unavailable and loads no requested private track', async () => {
        const deps = dependencies({
            getServerCampaignPoster: vi.fn(async () => ({ status: 404, body: { error: 'This Campaign is unavailable.' } })),
            refreshStoredCatalog: vi.fn(async () => {}),
            loadStoredTracks: vi.fn(async () => {}),
            describeStoredTracks: vi.fn(),
        });
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/poster?seriesId=privateDraft&trackKey=privateTrack`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'This Campaign is unavailable.' });
        expect(deps.loadStoredTracks).not.toHaveBeenCalled();
        expect(deps.describeStoredTracks).not.toHaveBeenCalled();
    });

    it('loads aggregate standings using authenticated identity and parsed paging, ignoring supplied totals', async () => {
        const deps = dependencies();
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/aggregate?seriesId=numbered-v1&limit=20&offset=10&playerId=reddit:other&redditUsername=spoofed&totalTimeMs=1`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ready: true, totalTimeMs: 12345 });
        expect(deps.getServerCampaignAggregate).toHaveBeenCalledWith({
            seriesId: 'numbered-v1', limit: 20, offset: 10, playerId: 'reddit:other', redditUsername: 'RaceFan',
        });
    });
    it('previews only the series ID and authenticated Reddit context', async () => {
        const deps = dependencies();
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/share/preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                seriesId: 'numbered-v1',
                redditUsername: 'spoofed',
                subredditName: 'OtherCommunity',
                playerId: 'reddit:other',
                seriesName: 'Fake campaign',
                medalDistribution: { author: 99 },
            }),
        });
        expect(response.status).toBe(200);
        expect(deps.previewServerCampaignResultsShare).toHaveBeenCalledWith({
            seriesId: 'numbered-v1',
            redditUsername: 'RaceFan',
            subredditName: 'MiniRacer',
        });
        expect(deps.confirmServerCampaignResultsShare).not.toHaveBeenCalled();
    });

    it('confirms only the preview token and trusted context and exposes no direct posting route', async () => {
        const deps = dependencies();
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/share/confirm`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                shareToken: 'preview-token', seriesId: 'fake', redditUsername: 'spoofed', subredditName: 'OtherCommunity',
                medalDistribution: { author: 99 }, title: 'Forged title',
            }),
        });
        expect(response.status).toBe(200);
        expect(deps.confirmServerCampaignResultsShare).toHaveBeenCalledWith({
            shareToken: 'preview-token', redditUsername: 'RaceFan', subredditName: 'MiniRacer',
        });
        expect(await fetch(`${baseUrl}/api/campaign/share`, { method: 'POST' }).then((reply) => reply.status)).toBe(404);
    });

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
        expect(deps.markServerCampaignResultsSharePending).toHaveBeenCalledWith({
            raceId: 'numbered-v1-00', redditUsername: 'RaceFan', subredditName: 'MiniRacer',
        });
        expect(deps.refreshServerCampaignResultsShare).not.toHaveBeenCalled();
    });

    it.each([true, false])('marks an accepted save before replying when improved is %s', async (improved) => {
        let release;
        const pending = new Promise((resolve) => { release = resolve; });
        const result = { accepted: true, improved };
        const deps = dependencies({
            submitServerCampaignRun: vi.fn(async () => ({ status: 200, body: result })),
            markServerCampaignResultsSharePending: vi.fn(() => pending),
        });
        const routes = new Map();
        registerCampaignRoutes({ post: (path, handler) => routes.set(path, handler), get: vi.fn() }, deps);
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        const response = routes.get('/api/campaign/submit')({ body: { raceId: 'numbered-v1-00' } }, res);
        try {
            await vi.waitFor(() => expect(deps.markServerCampaignResultsSharePending).toHaveBeenCalledOnce());
            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).not.toHaveBeenCalled();
            expect(deps.refreshServerCampaignResultsShare).not.toHaveBeenCalled();
        } finally {
            release();
            await response;
        }
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(result);
    });

    it('keeps a saved race accepted when marking the shared post fails', async () => {
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        const deps = dependencies({ markServerCampaignResultsSharePending: vi.fn().mockRejectedValue(new Error('Redis unavailable')) });
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/submit`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raceId: 'numbered-v1-00' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ accepted: true });
        expect(errorLog).toHaveBeenCalled();
        errorLog.mockRestore();
    });

    it('does not mark or refresh a shared post for a rejected race', async () => {
        const deps = dependencies({ submitServerCampaignRun: vi.fn(async () => ({ status: 400, body: { accepted: false } })) });
        const baseUrl = await startApp(deps);
        await fetch(`${baseUrl}/api/campaign/submit`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raceId: 'numbered-v1-00' }),
        });
        expect(deps.markServerCampaignResultsSharePending).not.toHaveBeenCalled();
        expect(deps.refreshServerCampaignResultsShare).not.toHaveBeenCalled();
    });

    it('retries a waiting shared post when Campaign opens, and still opens if that retry fails', async () => {
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        const deps = dependencies({ refreshServerCampaignResultsShare: vi.fn().mockRejectedValue(new Error('Reddit unavailable')) });
        const baseUrl = await startApp(deps);
        const response = await fetch(`${baseUrl}/api/campaign/bootstrap`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ campaignId: 'numbered-v1' });
        expect(deps.refreshServerCampaignResultsShare).toHaveBeenCalledWith({
            seriesId: 'numbered-v1', redditUsername: 'RaceFan', subredditName: 'MiniRacer', onlyIfPending: true,
        });
        expect(errorLog).toHaveBeenCalled();
        errorLog.mockRestore();
    });

    it('refreshes the series loaded by bootstrap instead of the query series', async () => {
        const deps = dependencies({
            getServerCampaignBootstrap: vi.fn(async () => ({ status: 200, body: { campaignId: 'loaded-series' } })),
        });
        const baseUrl = await startApp(deps);
        expect((await fetch(`${baseUrl}/api/campaign/bootstrap?seriesId=requested-series`)).status).toBe(200);
        expect(deps.refreshServerCampaignResultsShare).toHaveBeenCalledWith({
            seriesId: 'loaded-series', redditUsername: 'RaceFan', subredditName: 'MiniRacer', onlyIfPending: true,
        });
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
