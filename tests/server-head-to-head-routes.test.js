import { describe, expect, it, vi } from 'vitest';
import { registerHeadToHeadRoutes } from '../src/server/routes/head-to-head-routes.ts';

function routeHandlers(dependencies) {
    const handlers = { get: {}, post: {} };
    const app = {
        get: (path, handler) => { handlers.get[path] = handler; },
        post: (path, handler) => { handlers.post[path] = handler; },
    };
    registerHeadToHeadRoutes(app, dependencies);
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

describe('Head to Head route identity forwarding', () => {
    it('forwards guest identity on challenge reads and submissions', async () => {
        const context = {
            username: null,
            subredditName: 'MiniRacer',
            postId: null,
            postData: { postType: 'head-to-head', challengeId: 'challenge-1' },
        };
        const getHeadToHead = vi.fn(async (challengeId, requestContext) => ({
            status: 200,
            body: { challengeId, requestContext },
        }));
        const submitHeadToHead = vi.fn(async (input, requestContext) => ({
            status: 200,
            body: { input, requestContext },
        }));
        const dependencies = {
            getHeadToHeadRequestContext: () => context,
            readContextPostData: () => context.postData,
            previewHeadToHead: vi.fn(),
            createHeadToHead: vi.fn(),
            getHeadToHead,
            submitHeadToHead,
            previewHeadToHeadBrag: vi.fn(),
            confirmHeadToHeadBrag: vi.fn(),
        };
        const handlers = routeHandlers(dependencies);

        const readResponse = responseRecorder();
        await handlers.get['/api/head-to-head']({
            query: {
                postId: 't3_challenge1',
                playerId: 'guest-1',
                guestToken: 'signed-token',
            },
        }, readResponse);
        expect(readResponse.statusCode).toBe(200);
        expect(getHeadToHead).toHaveBeenCalledWith('challenge-1', {
            ...context,
            postId: 't3_challenge1',
            playerId: 'guest-1',
            guestToken: 'signed-token',
        });

        const submitResponse = responseRecorder();
        await handlers.post['/api/head-to-head/submit']({
            body: {
                replay: { inputs: [] },
                postId: 't3_challenge1',
                playerId: 'guest-1',
                guestToken: 'signed-token',
            },
        }, submitResponse);
        expect(submitResponse.statusCode).toBe(200);
        expect(submitHeadToHead).toHaveBeenCalledWith({
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
