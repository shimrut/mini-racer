import type { Application } from 'express';
import type { DailyGpChallenge } from '../daily-gp-model.js';
import type { LandingDestinations } from '../landing-service.js';

export type LandingRouteDependencies = {
    readContextSubredditName(): string | null;
    getServerDailyGpChallenge(): Promise<DailyGpChallenge>;
    getLandingDestinations(
        subredditName: string,
        challenge: DailyGpChallenge,
    ): Promise<LandingDestinations>;
};

export function registerLandingRoutes(
    app: Application,
    dependencies: LandingRouteDependencies,
): void {
    app.get('/api/landing/destinations', async (_req, res) => {
        try {
            const subredditName = dependencies.readContextSubredditName();
            if (!subredditName) {
                res.status(400).json({
                    error: 'Reddit did not provide a subreddit context for this post.',
                });
                return;
            }
            const challenge = await dependencies.getServerDailyGpChallenge();
            const destinations = await dependencies.getLandingDestinations(
                subredditName,
                challenge,
            );
            res.json(destinations);
        } catch (error) {
            console.error('Failed to resolve Mini Racer landing destinations:', error);
            res.status(500).json({
                error: error instanceof Error && error.message
                    ? error.message
                    : 'Could not resolve Daily or Campaign destinations.',
            });
        }
    });
}
