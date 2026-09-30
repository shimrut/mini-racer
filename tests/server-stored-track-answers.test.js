import { describe, expect, it, vi } from 'vitest';
import { registerCompetitionRoutes } from '../src/server/routes/competition-routes.ts';
import { registerHeadToHeadRoutes } from '../src/server/routes/head-to-head-routes.ts';
import { registerCampaignRoutes } from '../src/server/routes/campaign-routes.ts';

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

    it('keeps the Daily answers unchanged without stored tracks', async () => {
        const challenge = { id: 'daily-gp-2026-09-30', trackKey: 'circuit' };
        const handlers = routeHandlers(registerCompetitionRoutes, competitionDependencies([challenge]));
        const active = responseRecorder();
        await handlers.get['/api/daily/active']({}, active);
        expect(active.body).toBe(challenge);
        const playlist = responseRecorder();
        await handlers.get['/api/daily/playlist']({}, playlist);
        expect(playlist.body).toEqual({ challenges: [challenge] });
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
        expect(plain.body).toEqual({ campaignId: 'numbered-v1' });
    });
});
