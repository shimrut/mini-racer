import type { Application, Response } from 'express';

export type AnalyticsRouteDependencies = {
    resolveAnalyticsToolSubredditName(): Promise<string | null>;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    getServerAnalyticsSummary(): Promise<unknown>;
    getGuestProgressTransferDiagnostic(input: {
        redditPlayerId?: unknown;
        transferId?: unknown;
    }): Promise<unknown>;
    getRequestUsername(): string | null;
    recordRaceStart(input: Record<string, unknown>): Promise<void>;
    recordPodiumEvent(input: Record<string, unknown>): Promise<void>;
};

const PODIUM_ANALYTICS_ACTIONS = new Set(['play', 'replay']);

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

    // Play Now and View Replays live on the podium post, so there is no race
    // submit to hang this off. Fire-and-forget: analytics must never block the post.
    app.post('/api/analytics/podium', async (req, res) => {
        const { action } = req.body ?? {};
        if (!PODIUM_ANALYTICS_ACTIONS.has(action)) {
            res.status(400).json({ error: 'Unsupported podium analytics action.' });
            return;
        }
        res.status(204).end();
        try {
            await dependencies.recordPodiumEvent({ action });
        } catch (error) {
            console.error('Failed to record Mini Racer podium analytics:', error);
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

    /**
     * Read-only case evidence for one account's guest progress transfer, for a reviewed repair.
     * It changes nothing. Its answer carries guest ids and stored evidence, so it is returned only
     * to a verified moderator and never written to an ordinary log.
     */
    app.get('/api/analytics/guest-transfer', async (req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            await dependencies.assertModeratorForSubreddit(subredditName);

            const username = typeof req.query?.username === 'string' ? req.query.username.trim() : '';
            const transferId = typeof req.query?.transferId === 'string'
                ? req.query.transferId.trim()
                : undefined;
            if (!username) {
                res.status(400).json({ error: 'A Reddit username is required.' });
                return;
            }
            res.status(200).json(await dependencies.getGuestProgressTransferDiagnostic({
                redditPlayerId: `reddit:${username.toLowerCase()}`,
                transferId,
            }));
        } catch (error) {
            // The message may name the moderator check, never the case evidence.
            const message = error instanceof Error && error.message
                ? error.message
                : 'Guest transfer diagnostic failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            if (status !== 403) {
                console.error('Guest transfer diagnostic failed.');
            }
            res.status(status).json({ error: message });
        }
    });
}
