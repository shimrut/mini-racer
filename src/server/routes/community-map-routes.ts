import type { Application, Response } from 'express';
import { CommunityMapInputError } from '../community/community-map-validation.js';

export type CommunityMapRouteDependencies = {
    resolveCreatorToolSubredditName(): string | null;
    readContextSubredditName(): string | null;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    readCommunityDraft(subredditName: string, username: string): Promise<unknown>;
    saveCommunityDraft(subredditName: string, username: string, input: unknown): Promise<unknown>;
    publishCommunityDraft(subredditName: string, username: string, signature: unknown): Promise<unknown>;
    listCommunityMaps(subredditName: string, cursor: unknown, includeUnpublished?: boolean): Promise<unknown>;
    readPublicCommunityMap(subredditName: string, id: string): Promise<unknown>;
    changeCommunityMapStatus(subredditName: string, id: string, status: unknown): Promise<unknown>;
};

function errorResponse(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Community map request failed.';
    const status = error instanceof CommunityMapInputError ? 400
        : message.includes('Moderator access required') || message.includes('acting username') ? 403
            : 500;
    if (status === 500) console.error('Community map request failed:', error);
    res.status(status).json({ error: message });
}

async function creatorIdentity(dependencies: CommunityMapRouteDependencies): Promise<{
    subredditName: string;
    username: string;
}> {
    const subredditName = dependencies.resolveCreatorToolSubredditName();
    if (!subredditName) {
        throw new CommunityMapInputError('Open the Mini Racer Creator from its moderator menu.');
    }
    const username = await dependencies.assertModeratorForSubreddit(subredditName);
    return { subredditName, username };
}

export function registerCommunityMapRoutes(
    app: Application,
    dependencies: CommunityMapRouteDependencies,
): void {
    app.get('/api/creator/draft', async (_req, res) => {
        try {
            const { subredditName, username } = await creatorIdentity(dependencies);
            res.json({ draft: await dependencies.readCommunityDraft(subredditName, username) });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.put('/api/creator/draft', async (req, res) => {
        try {
            const { subredditName, username } = await creatorIdentity(dependencies);
            res.json({ draft: await dependencies.saveCommunityDraft(subredditName, username, req.body) });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/publish', async (req, res) => {
        try {
            const { subredditName, username } = await creatorIdentity(dependencies);
            res.json(await dependencies.publishCommunityDraft(
                subredditName,
                username,
                req.body?.completedLapSignature,
            ));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.get('/api/creator/maps', async (req, res) => {
        try {
            const { subredditName } = await creatorIdentity(dependencies);
            res.json(await dependencies.listCommunityMaps(subredditName, req.query.cursor, true));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/maps/:id/status', async (req, res) => {
        try {
            const { subredditName } = await creatorIdentity(dependencies);
            const map = await dependencies.changeCommunityMapStatus(
                subredditName,
                req.params.id,
                req.body?.status,
            );
            if (!map) {
                res.status(404).json({ error: 'Community map not found.' });
                return;
            }
            res.json({ map });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.get('/api/community/maps', async (req, res) => {
        try {
            const subredditName = dependencies.readContextSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context.' });
                return;
            }
            res.json(await dependencies.listCommunityMaps(subredditName, req.query.cursor));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.get('/api/community/maps/:id', async (req, res) => {
        try {
            const subredditName = dependencies.readContextSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context.' });
                return;
            }
            const map = await dependencies.readPublicCommunityMap(subredditName, req.params.id);
            if (!map) {
                res.status(404).json({ error: 'Community map not found.' });
                return;
            }
            res.json({ map });
        } catch (error) {
            errorResponse(res, error);
        }
    });
}
