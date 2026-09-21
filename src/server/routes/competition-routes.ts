import type { Application } from 'express';
import type { DailyGpChallenge } from '../daily-gp-model.js';

type ServiceResult = {
    status: number;
    body: unknown;
};

export type CompetitionRouteDependencies = {
    getRequestUsername(): string | null;
    getRequestRateLimitIdentity(): string | null;
    getPostBoundDailyGpChallenge(): Promise<DailyGpChallenge | null>;
    getServerDailyGpChallenge(): Promise<DailyGpChallenge>;
    getServerDailyGpPlaylist(): Promise<DailyGpChallenge[]>;
    getServerDailyGpSnapshot(input: Record<string, unknown>): Promise<unknown>;
    submitServerDailyGpRun(input: Record<string, unknown>): Promise<ServiceResult>;
    isDailyGpChallengePlayable(challenge: DailyGpChallenge): boolean;
};

function parseOptionalInteger(value: unknown): number | undefined {
    return value ? parseInt(String(value), 10) : undefined;
}

export function registerCompetitionRoutes(
    app: Application,
    dependencies: CompetitionRouteDependencies,
): void {
    app.get('/api/scoreboard/snapshot', async (req, res) => {
        try {
            const { trackKey, playerId, guestToken, limit, offset } = req.query ?? {};
            const activeChallenge = await dependencies.getServerDailyGpChallenge();
            const challenge = trackKey === activeChallenge.trackKey
                ? activeChallenge
                : (await dependencies.getServerDailyGpPlaylist())
                    .find((entry) => entry.trackKey === trackKey) || null;
            if (!challenge) {
                res.status(200).json({
                    topRows: [],
                    nearbyRows: [],
                    currentPlayerRow: null,
                    totalCount: 0,
                    leaderboardEntryCount: 0,
                    playerRank: null,
                    playerRankLabel: null,
                    objectiveType: activeChallenge.objectiveType,
                    pageOffset: 0,
                    pageLimit: 0,
                    hasMore: false,
                    nextOffset: null,
                });
                return;
            }

            const snapshot = await dependencies.getServerDailyGpSnapshot({
                challengeId: challenge.id,
                loadedChallenge: challenge,
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
                limit: parseOptionalInteger(limit),
                offset: parseOptionalInteger(offset),
            });
            res.status(200).json(snapshot);
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer scoreboard snapshot:', error);
            res.status(500).json({ error: 'Scoreboard snapshot failed' });
        }
    });

    app.get('/api/daily/active', async (_req, res) => {
        try {
            const postBound = await dependencies.getPostBoundDailyGpChallenge();
            const challenge = postBound && dependencies.isDailyGpChallengePlayable(postBound)
                ? postBound
                : await dependencies.getServerDailyGpChallenge();
            res.status(200).json(challenge);
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer active challenge:', error);
            res.status(500).json({ error: 'Active challenge lookup failed' });
        }
    });

    app.get('/api/daily/playlist', async (_req, res) => {
        try {
            res.status(200).json({
                challenges: await dependencies.getServerDailyGpPlaylist(),
            });
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer daily playlist:', error);
            res.status(500).json({ error: 'Daily playlist lookup failed' });
        }
    });

    app.get('/api/daily/snapshot', async (req, res) => {
        try {
            const { challengeId, playerId, guestToken, limit, offset } = req.query ?? {};
            const snapshot = await dependencies.getServerDailyGpSnapshot({
                challengeId,
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
                limit: parseOptionalInteger(limit),
                offset: parseOptionalInteger(offset),
            });
            res.status(200).json(snapshot);
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer snapshot:', error);
            res.status(500).json({ error: 'Daily challenge snapshot failed' });
        }
    });

    app.post('/api/daily/submit', async (req, res) => {
        try {
            const result = await dependencies.submitServerDailyGpRun({
                ...(req.body ?? {}),
                redditUsername: dependencies.getRequestUsername(),
                requestRateLimitIdentity: dependencies.getRequestRateLimitIdentity(),
            });
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to submit Reddit Mini Racer run:', error);
            res.status(500).json({ accepted: false, error: 'Daily challenge submit failed' });
        }
    });
}
