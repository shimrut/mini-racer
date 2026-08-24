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
            requestRateLimitIdentity: 'server-request-hash',
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

    it('sends the duel body before origin save and keeps the handler alive for Redis', async () => {
        const order = [];
        let finishOrigin;
        const originSave = new Promise((resolve) => {
            finishOrigin = resolve;
        });
        const submitHeadToHead = vi.fn(async () => ({
            status: 200,
            body: { accepted: true, outcome: 'won', acceptToken: 'token-1' },
            afterSend: async () => {
                await originSave;
                order.push('origin-save');
            },
        }));
        const handlers = routeHandlers({
            getHeadToHeadRequestContext: () => ({
                username: null,
                subredditName: 'MiniRacer',
                postData: { postType: 'head-to-head', challengeId: 'challenge-1' },
            }),
            readContextPostData: () => ({ postType: 'head-to-head', challengeId: 'challenge-1' }),
            previewHeadToHead: vi.fn(),
            createHeadToHead: vi.fn(),
            getHeadToHead: vi.fn(),
            submitHeadToHead,
            previewHeadToHeadBrag: vi.fn(),
            confirmHeadToHeadBrag: vi.fn(),
        });
        const submitResponse = responseRecorder();
        const json = submitResponse.json.bind(submitResponse);
        submitResponse.json = (body) => {
            order.push('json');
            return json(body);
        };

        const submitDone = handlers.post['/api/head-to-head/submit']({
            body: { replay: { inputs: [] } },
        }, submitResponse);

        await vi.waitFor(() => {
            expect(order).toEqual(['json']);
        });
        expect(submitResponse.statusCode).toBe(200);
        expect(submitResponse.body).toEqual({
            accepted: true,
            outcome: 'won',
            acceptToken: 'token-1',
        });
        expect(submitResponse.body).not.toHaveProperty('bestUpdate');

        finishOrigin();
        await submitDone;
        expect(order).toEqual(['json', 'origin-save']);
    });
});
