import type { Application, Response } from 'express';

export type AnalyticsRouteDependencies = {
    resolveAnalyticsToolSubredditName(): Promise<string | null>;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    getServerAnalyticsSummary(): Promise<unknown>;
};

export function registerAnalyticsRoutes(
    app: Application,
    dependencies: AnalyticsRouteDependencies,
): void {
    app.get('/api/analytics/summary', async (_req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }

            await dependencies.assertModeratorForSubreddit(subredditName);
            res.status(200).json(await dependencies.getServerAnalyticsSummary());
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer analytics summary:', error);
            const message = error instanceof Error && error.message
                ? error.message
                : 'Analytics summary failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            res.status(status).json({ error: message });
        }
    });
}
