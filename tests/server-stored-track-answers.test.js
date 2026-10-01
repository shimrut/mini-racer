import { describe, expect, it, vi } from 'vitest';
import { registerCompetitionRoutes } from '../src/server/routes/competition-routes.ts';
import { registerHeadToHeadRoutes } from '../src/server/routes/head-to-head-routes.ts';
import { registerCampaignRoutes } from '../src/server/routes/campaign-routes.ts';
import { TrackPlacementRetryError } from '../src/server/tracks/track-placement-lock.ts';

function routeHandlers(register, dependencies) {
    const handlers = { get: {}, post: {} };
    register({
        get: (path, handler) => { handlers.get[path] = handler; },
        post: (path, handler) => { handlers.post[path] = handler; },
    }, dependencies);
    return handlers;
}

function responseRecorder() {
    const response = {
        statusCode: null,
        body: null,
        status(code) {
            response.statusCode = code;
            return response;
        },
        json(body) {
            response.body = body;
            return response;
        },
    };
    return response;
}

const stored = { key: 'nightLoop', name: 'Night Loop', track: { outer: [] } };
const describeStoredTracks = vi.fn((keys) => (keys.includes('nightLoop') ? [stored] : []));

function competitionDependencies(challenges) {
    return {
        getRequestUsername: () => null,
        getRequestRateLimitIdentity: () => null,
        getPostBoundDailyGpChallenge: async () => null,
        getServerDailyGpChallenge: async () => challenges[0],
        getServerDailyGpPlaylist: async () => challenges,
        getServerDailyGpSnapshot: vi.fn(),
        submitServerDailyGpRun: vi.fn(),
        isDailyGpChallengePlayable: () => true,
        describeStoredTracks,
    };
}

describe('answers that carry stored tracks', () => {
    it('adds the placed stored tracks to the Daily answers', async () => {
        const handlers = routeHandlers(registerCompetitionRoutes, competitionDependencies([
            { id: 'daily-gp-2026-10-01', trackKey: 'nightLoop' },
            { id: 'daily-gp-2026-09-30', trackKey: 'circuit' },
        ]));
        const active = responseRecorder();
        await handlers.get['/api/daily/active']({}, active);
        expect(active.body).toEqual({ id: 'daily-gp-2026-10-01', trackKey: 'nightLoop', storedTracks: [stored] });
        const playlist = responseRecorder();
        await handlers.get['/api/daily/playlist']({}, playlist);
        expect(playlist.body.storedTracks).toEqual([stored]);
    });

    it('explicitly confirms built-in Daily definitions without stored tracks', async () => {
        const challenge = { id: 'daily-gp-2026-09-30', trackKey: 'circuit' };
        const handlers = routeHandlers(registerCompetitionRoutes, competitionDependencies([challenge]));
        const active = responseRecorder();
        await handlers.get['/api/daily/active']({}, active);
        expect(active.body).toEqual({ ...challenge, storedTracks: [] });
        const playlist = responseRecorder();
        await handlers.get['/api/daily/playlist']({}, playlist);
        expect(playlist.body).toEqual({ challenges: [challenge], storedTracks: [] });
    });

    it('returns retryable unavailability when Daily placement cannot commit', async () => {
        const dependencies = competitionDependencies([]);
        dependencies.getServerDailyGpChallenge = async () => { throw new TrackPlacementRetryError(); };
        const response = responseRecorder();
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await routeHandlers(registerCompetitionRoutes, dependencies).get['/api/daily/active']({}, response);
            expect(response.statusCode).toBe(503);
            expect(response.body.error).toContain('Retry');
        } finally { log.mockRestore(); }
    });

    it('adds the stored track to a Head to Head answer', async () => {
        const handlers = routeHandlers(registerHeadToHeadRoutes, {
            describeStoredTracks,
            getHeadToHeadRequestContext: () => ({ username: null }),
            readContextPostData: () => null,
            getHeadToHead: async () => ({
                status: 200,
                body: { status: 'ready', challenge: { trackKey: 'nightLoop' } },
            }),
        });
        const response = responseRecorder();
        await handlers.get['/api/head-to-head']({ query: { challengeId: 'one' } }, response);
        expect(response.body.storedTracks).toEqual([stored]);
    });

    it('confirms an unchanged built-in Head to Head definition', async () => {
        const handlers = routeHandlers(registerHeadToHeadRoutes, {
            describeStoredTracks,
            getHeadToHeadRequestContext: () => ({ username: null }),
            readContextPostData: () => null,
            getHeadToHead: async () => ({ status: 200, body: { challenge: { trackKey: 'circuit' } } }),
        });
        const response = responseRecorder();
        await handlers.get['/api/head-to-head']({ query: {} }, response);
        expect(response.body.storedTracks).toEqual([]);
    });

    it('adds the published Creator series and their tracks to the Campaign answer', async () => {
        const nightSeries = { id: 'night-v1', stages: [{ trackKey: 'nightLoop' }, { trackKey: 'circuit' }] };
        const dependencies = {
            getRequestUsername: () => null,
            getRequestRateLimitIdentity: () => null,
            getServerCampaignBootstrap: async () => ({ status: 200, body: { campaignId: 'numbered-v1' } }),
            describeStoredSeries: () => [nightSeries],
            describeStoredTracks,
        };
        const handlers = routeHandlers(registerCampaignRoutes, dependencies);
        const response = responseRecorder();
        await handlers.get['/api/campaign/bootstrap']({ query: {} }, response);
        expect(response.body).toEqual({
            campaignId: 'numbered-v1',
            storedSeries: [nightSeries],
            storedTracks: [stored],
        });

        const plain = responseRecorder();
        await routeHandlers(registerCampaignRoutes, { ...dependencies, describeStoredSeries: () => [] })
            .get['/api/campaign/bootstrap']({ query: {} }, plain);
        expect(plain.body).toEqual({ campaignId: 'numbered-v1', storedTracks: [] });
    });

    it('confirms built-in Campaign stages without requiring a second track request', async () => {
        const describeTracks = vi.fn(() => []);
        const handlers = routeHandlers(registerCampaignRoutes, {
            getRequestUsername: () => null,
            getServerCampaignBootstrap: async () => ({ status: 200,
                body: { campaignId: 'numbered-v1', stages: [{ trackKey: 'numberOne' }] } }),
            describeStoredSeries: () => [], describeStoredTracks: describeTracks,
        });
        const response = responseRecorder();
        await handlers.get['/api/campaign/bootstrap']({ query: {} }, response);
        expect(describeTracks).toHaveBeenCalledWith(['numberOne']);
        expect(response.body.storedTracks).toEqual([]);
    });

    it('reads the catalog again and loads the named tracks before the answers describe them', async () => {
        const order = [];
        const refreshStoredCatalog = vi.fn(async () => { order.push('refresh'); });
        const loadStoredTracks = vi.fn(async (keys) => { order.push(`load:${keys.join(',')}`); });
        const describeTracks = vi.fn((keys) => { order.push('describe'); return describeStoredTracks(keys); });
        const campaign = responseRecorder();
        await routeHandlers(registerCampaignRoutes, {
            getRequestUsername: () => null,
            getServerCampaignBootstrap: async () => ({ status: 200,
                body: { campaignId: 'numbered-v1', stages: [{ trackKey: 'nightLoop' }] } }),
            describeStoredSeries: () => { order.push('series'); return []; },
            describeStoredTracks: describeTracks,
            refreshStoredCatalog,
            loadStoredTracks,
        }).get['/api/campaign/bootstrap']({ query: {} }, campaign);
        expect(order).toEqual(['refresh', 'series', 'load:nightLoop', 'describe']);
        expect(campaign.body.storedTracks).toEqual([stored]);

        order.length = 0;
        const headToHead = responseRecorder();
        await routeHandlers(registerHeadToHeadRoutes, {
            describeStoredTracks: describeTracks,
            refreshStoredCatalog,
            loadStoredTracks,
            getHeadToHeadRequestContext: () => ({ username: null }),
            readContextPostData: () => null,
            getHeadToHead: async () => ({ status: 200, body: { challenge: { trackKey: 'nightLoop' } } }),
        }).get['/api/head-to-head']({ query: {} }, headToHead);
        expect(order).toEqual(['refresh', 'load:nightLoop', 'describe']);
        expect(headToHead.body.storedTracks).toEqual([stored]);
    });

    it('answers 503 when the Campaign or Head to Head confirmation fails', async () => {
        const refreshStoredCatalog = async () => { throw new TrackPlacementRetryError('The tracks could not load. Try again.'); };
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const campaign = responseRecorder();
            await routeHandlers(registerCampaignRoutes, {
                getRequestUsername: () => null,
                getServerCampaignBootstrap: async () => ({ status: 200, body: { campaignId: 'numbered-v1' } }),
                describeStoredTracks,
                refreshStoredCatalog,
            }).get['/api/campaign/bootstrap']({ query: {} }, campaign);
            expect(campaign.statusCode).toBe(503);
            expect(campaign.body).toEqual({ error: 'The tracks could not load. Try again.' });

            const headToHead = responseRecorder();
            await routeHandlers(registerHeadToHeadRoutes, {
                describeStoredTracks,
                refreshStoredCatalog,
                getHeadToHeadRequestContext: () => ({ username: null }),
                readContextPostData: () => null,
                getHeadToHead: async () => ({ status: 200, body: { challenge: { trackKey: 'nightLoop' } } }),
            }).get['/api/head-to-head']({ query: {} }, headToHead);
            expect(headToHead.statusCode).toBe(503);
        } finally { log.mockRestore(); }
    });
});
