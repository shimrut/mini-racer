import type { Application } from 'express';
import { creatorUsername, errorResponse } from './track-routes.js';

export type CreatorSeriesRouteDependencies = {
    resolveCreatorToolSubredditName(): string | null;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    readCreatorSeriesView(username: string): Promise<unknown>;
    readStoredSeries(seriesId: string): Promise<unknown | null>;
    saveStoredSeries(seriesId: unknown, input: unknown, options: { username: string; baseRevision?: unknown }): Promise<unknown>;
    publishStoredSeries(seriesId: unknown, options: { username: string; baseRevision?: unknown }): Promise<unknown>;
    deleteStoredSeries(seriesId: unknown, options: { baseRevision?: unknown }): Promise<boolean>;
};

// The Campaign Planner of the Creator. Only moderators can use it.
export function registerCreatorSeriesRoutes(
    app: Application,
    dependencies: CreatorSeriesRouteDependencies,
): void {
    app.get('/api/creator/series', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json(await dependencies.readCreatorSeriesView(username));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.get('/api/creator/series/:id', async (req, res) => {
        try {
            await creatorUsername(dependencies);
            const series = await dependencies.readStoredSeries(req.params.id);
            if (!series) {
                res.status(404).json({ error: 'Series not found.' });
                return;
            }
            res.json({ series });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.put('/api/creator/series/:id', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json({
                series: await dependencies.saveStoredSeries(req.params.id, req.body, {
                    username,
                    baseRevision: req.body?.baseRevision,
                }),
            });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/series/:id/publish', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json({
                series: await dependencies.publishStoredSeries(req.params.id, {
                    username,
                    baseRevision: req.body?.baseRevision,
                }),
            });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.delete('/api/creator/series/:id', async (req, res) => {
        try {
            await creatorUsername(dependencies);
            const deleted = await dependencies.deleteStoredSeries(req.params.id, {
                baseRevision: req.query.baseRevision,
            });
            if (!deleted) {
                res.status(404).json({ error: 'Series not found.' });
                return;
            }
            res.json({ deleted: true });
        } catch (error) {
            errorResponse(res, error);
        }
    });
}
