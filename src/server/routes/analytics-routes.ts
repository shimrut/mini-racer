import type { Application, Response } from 'express';

export type AnalyticsRouteDependencies = {
    resolveAnalyticsToolSubredditName(): Promise<string | null>;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    getServerAnalyticsSummary(): Promise<unknown>;
    getRequestUsername(): string | null;
    recordRaceStart(input: Record<string, unknown>): Promise<void>;
};

// Campaign start stamps /api/campaign/start for progress only. Analytics starts
// are counted here so Retry matches Daily and Head to Head.
const CLIENT_REPORTED_START_MODES = new Set(['daily', 'campaign', 'challenge']);

export function registerAnalyticsRoutes(
    app: Application,
    dependencies: AnalyticsRouteDependencies,
): void {
    // A race start has no other server call to hang off for Daily and Challenge, so the
    // client reports it here. It is fire-and-forget: analytics must never block a race.
    app.post('/api/analytics/race-start', async (req, res) => {
        const { mode, playerId, guestToken } = req.body ?? {};
        if (!CLIENT_REPORTED_START_MODES.has(mode)) {
            res.status(400).json({ error: 'Unsupported race start mode.' });
            return;
        }
        res.status(204).end();
        try {
            await dependencies.recordRaceStart({
                mode,
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            });
        } catch (error) {
            console.error('Failed to record Mini Racer race start:', error);
        }
    });

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
