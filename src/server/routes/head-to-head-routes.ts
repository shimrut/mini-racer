import type { Application } from 'express';
import type {
    HeadToHeadRequestContext,
    HeadToHeadServiceResult,
} from '../head-to-head-service.js';

export type HeadToHeadRouteDependencies = {
    getHeadToHeadRequestContext(): Promise<HeadToHeadRequestContext>
        | HeadToHeadRequestContext;
    readContextPostData(): Record<string, unknown> | null;
    previewHeadToHead(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult>;
    createHeadToHead(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult>;
    getHeadToHead(
        challengeId: string | null,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult>;
    submitHeadToHead(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult>;
    previewHeadToHeadBrag(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult>;
    confirmHeadToHeadBrag(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult>;
};

function postChallengeId(postData: Record<string, unknown> | null): string | null {
    return postData?.postType === 'head-to-head'
        && typeof postData.challengeId === 'string'
        ? postData.challengeId
        : null;
}

function withRequestIdentity(
    context: HeadToHeadRequestContext,
    input: Record<string, unknown> | null | undefined,
): HeadToHeadRequestContext {
    const requestedPostId = typeof input?.postId === 'string'
        && input.postId.startsWith('t3_')
        ? input.postId
        : null;
    return {
        ...context,
        postId: requestedPostId || context.postId || null,
        playerId: typeof input?.playerId === 'string' ? input.playerId : null,
        guestToken: typeof input?.guestToken === 'string' ? input.guestToken : null,
    };
}
export function registerHeadToHeadRoutes(
    app: Application,
    dependencies: HeadToHeadRouteDependencies,
): void {
    app.post('/api/head-to-head/preview', async (req, res) => {
        try {
            const result = await dependencies.previewHeadToHead(
                req.body ?? {},
                await dependencies.getHeadToHeadRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to preview Mini Racer head-to-head:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not prepare this challenge.' });
        }
    });

    app.post('/api/head-to-head/create', async (req, res) => {
        try {
            const result = await dependencies.createHeadToHead(
                req.body ?? {},
                await dependencies.getHeadToHeadRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to create Mini Racer head-to-head:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not create this challenge.' });
        }
    });

    app.get('/api/head-to-head', async (req, res) => {
        try {
            const queryId = typeof req.query?.challengeId === 'string'
                ? req.query.challengeId
                : null;
            const result = await dependencies.getHeadToHead(
                queryId || postChallengeId(dependencies.readContextPostData()),
                withRequestIdentity(
                    await dependencies.getHeadToHeadRequestContext(),
                    req.query as Record<string, unknown>,
                ),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to load Mini Racer head-to-head:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not load this challenge.' });
        }
    });

    app.post('/api/head-to-head/submit', async (req, res) => {
        try {
            const body = req.body ?? {};
            const result = await dependencies.submitHeadToHead(
                {
                    ...body,
                    challengeId: typeof body.challengeId === 'string'
                        ? body.challengeId
                        : postChallengeId(dependencies.readContextPostData()),
                },
                withRequestIdentity(
                    await dependencies.getHeadToHeadRequestContext(),
                    body,
                ),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to submit Mini Racer head-to-head:', error);
            res.status(500).json({ accepted: false, status: 'challenge_failed', error: 'Could not verify this challenge run.' });
        }
    });

    app.post('/api/head-to-head/brag/preview', async (req, res) => {
        try {
            const result = await dependencies.previewHeadToHeadBrag(
                req.body ?? {},
                withRequestIdentity(
                    await dependencies.getHeadToHeadRequestContext(),
                    req.body ?? {},
                ),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to preview Mini Racer challenge brag:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not prepare this brag.' });
        }
    });

    app.post('/api/head-to-head/brag/confirm', async (req, res) => {
        try {
            const result = await dependencies.confirmHeadToHeadBrag(
                req.body ?? {},
                await dependencies.getHeadToHeadRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to confirm Mini Racer challenge brag:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not post this brag.' });
        }
    });
}
