import type { Application, Response } from 'express';

export type AnalyticsRouteDependencies = {
    getRequestUsername(): string | null;
    readContextPostId(): string | null;
    readContextSubredditName(): string | null;
    resolveAnalyticsToolSubredditName(): Promise<string | null>;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    submitServerAnalyticsEvent(input: Record<string, unknown>): Promise<{
        accepted: boolean;
        [key: string]: unknown;
    }>;
    getServerAnalyticsSummary(input: Record<string, unknown>): Promise<unknown>;
};

function setAnalyticsCorsHeaders(res: Response): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function registerAnalyticsRoutes(
    app: Application,
    dependencies: AnalyticsRouteDependencies,
): void {
    app.post('/api/analytics/event', async (req, res) => {
        try {
            const result = await dependencies.submitServerAnalyticsEvent({
                ...(req.body ?? {}),
                context: {
                    redditUsername: dependencies.getRequestUsername(),
                    postId: dependencies.readContextPostId(),
                    subredditName: dependencies.readContextSubredditName(),
                },
            });
            res.status(result.accepted ? 200 : 400).json(result);
        } catch (error) {
            console.error('Failed to record Reddit Mini Racer analytics event:', error);
            res.status(500).json({ accepted: false, error: 'Analytics event failed' });
        }
    });

    app.options('/api/analytics/summary', (_req, res) => {
        setAnalyticsCorsHeaders(res);
        res.status(204).end();
    });

    app.get('/api/analytics/summary', async (req, res) => {
        try {
            setAnalyticsCorsHeaders(res);
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }

            await dependencies.assertModeratorForSubreddit(subredditName);
            const { from, to, range } = req.query ?? {};
            const summary = await dependencies.getServerAnalyticsSummary({ from, to, range });
            res.status(200).json(summary);
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer analytics summary:', error);
            const message = error instanceof Error ? error.message : 'Analytics summary failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            res.status(status).json({ error: message });
        }
    });
}
