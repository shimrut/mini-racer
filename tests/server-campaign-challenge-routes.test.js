import { describe, expect, it, vi } from 'vitest';
import { registerCampaignChallengeRoutes } from '../src/server/routes/campaign-challenge-routes.ts';

function routeHandlers(dependencies) {
    const handlers = { get: {}, post: {} };
    const app = {
        get: (path, handler) => { handlers.get[path] = handler; },
        post: (path, handler) => { handlers.post[path] = handler; },
    };
    registerCampaignChallengeRoutes(app, dependencies);
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

describe('Campaign challenge route identity forwarding', () => {
    it('forwards guest identity on challenge reads and submissions', async () => {
        const context = {
            username: null,
            subredditName: 'MiniRacer',
            postId: null,
            postData: { postType: 'campaign-challenge', challengeId: 'challenge-1' },
        };
        const getCampaignChallenge = vi.fn(async (challengeId, requestContext) => ({
            status: 200,
            body: { challengeId, requestContext },
        }));
        const submitCampaignChallenge = vi.fn(async (input, requestContext) => ({
            status: 200,
            body: { input, requestContext },
        }));
        const dependencies = {
            getCampaignChallengeRequestContext: () => context,
            readContextPostData: () => context.postData,
            previewCampaignChallenge: vi.fn(),
            createCampaignChallenge: vi.fn(),
            getCampaignChallenge,
            submitCampaignChallenge,
            previewCampaignChallengeBrag: vi.fn(),
            confirmCampaignChallengeBrag: vi.fn(),
        };
        const handlers = routeHandlers(dependencies);

        const readResponse = responseRecorder();
        await handlers.get['/api/campaign/challenge']({
            query: {
                postId: 't3_challenge1',
                playerId: 'guest-1',
                guestToken: 'signed-token',
            },
        }, readResponse);
        expect(readResponse.statusCode).toBe(200);
        expect(getCampaignChallenge).toHaveBeenCalledWith('challenge-1', {
            ...context,
            postId: 't3_challenge1',
            playerId: 'guest-1',
            guestToken: 'signed-token',
        });

        const submitResponse = responseRecorder();
        await handlers.post['/api/campaign/challenge/submit']({
            body: {
                replay: { inputs: [] },
                postId: 't3_challenge1',
                playerId: 'guest-1',
                guestToken: 'signed-token',
            },
        }, submitResponse);
        expect(submitResponse.statusCode).toBe(200);
        expect(submitCampaignChallenge).toHaveBeenCalledWith({
            replay: { inputs: [] },
            postId: 't3_challenge1',
            playerId: 'guest-1',
            guestToken: 'signed-token',
            challengeId: 'challenge-1',
        }, {
            ...context,
            postId: 't3_challenge1',
            playerId: 'guest-1',
            guestToken: 'signed-token',
        });
    });
});
