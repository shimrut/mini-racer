import type { Application } from 'express';
import { sendFailure } from './route-errors.js';

type ServiceResult = {
    status: number;
    body: unknown;
};

export type LeaderboardRaceRouteDependencies = {
    getRequestUsername(): string | null;
    getRequestRateLimitIdentity(): string | null;
    prepareServerLeaderboardRace(input: Record<string, unknown>): Promise<ServiceResult>;
};

export function registerLeaderboardRaceRoutes(
    app: Application,
    dependencies: LeaderboardRaceRouteDependencies,
): void {
    app.post('/api/leaderboard-race/prepare', async (req, res) => {
        try {
            const result = await dependencies.prepareServerLeaderboardRace({
                ...(req.body ?? {}),
                redditUsername: dependencies.getRequestUsername(),
                requestRateLimitIdentity: dependencies.getRequestRateLimitIdentity(),
            });
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to prepare Mini Racer leaderboard opponent race:', error);
            sendFailure(res, error, { error: 'Opponent race preparation failed' });
        }
    });
}
