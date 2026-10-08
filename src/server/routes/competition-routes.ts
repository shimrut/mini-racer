import type { Application } from 'express';
import type { DailyGpChallenge } from '../daily/daily-gp-model.js';
import { sendFailure } from './route-errors.js';

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
    // Rereads the catalog once the challenge is known (another server may place it), then loads its tracks.
    refreshStoredCatalog?(): Promise<void>;
    loadStoredTracks?(trackKeys: string[]): Promise<void>;
    // The placed stored tracks among these keys, so the game can load them.
    describeStoredTracks?(trackKeys: string[]): unknown[];
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
            sendFailure(res, error, { error: 'Scoreboard snapshot failed' });
        }
    });

    app.get('/api/daily/active', async (_req, res) => {
        try {
            const postBound = await dependencies.getPostBoundDailyGpChallenge();
            const challenge = postBound && dependencies.isDailyGpChallengePlayable(postBound)
                ? postBound
                : await dependencies.getServerDailyGpChallenge();
            await dependencies.refreshStoredCatalog?.();
            await dependencies.loadStoredTracks?.([challenge.trackKey]);
            const storedTracks = dependencies.describeStoredTracks?.([challenge.trackKey]) ?? [];
            res.status(200).json(dependencies.describeStoredTracks ? { ...challenge, storedTracks } : challenge);
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer active challenge:', error);
            sendFailure(res, error, {
                error: 'Active challenge lookup failed',
            });
        }
    });

    app.get('/api/daily/playlist', async (_req, res) => {
        try {
            const challenges = await dependencies.getServerDailyGpPlaylist();
            const trackKeys = challenges.map((challenge) => challenge.trackKey);
            await dependencies.refreshStoredCatalog?.();
            await dependencies.loadStoredTracks?.(trackKeys);
            const storedTracks = dependencies.describeStoredTracks?.(trackKeys) ?? [];
            res.status(200).json(dependencies.describeStoredTracks ? { challenges, storedTracks } : { challenges });
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer daily playlist:', error);
            sendFailure(res, error, {
                error: 'Daily playlist lookup failed',
            });
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
            sendFailure(res, error, { error: 'Daily challenge snapshot failed' });
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
            sendFailure(res, error, { accepted: false, error: 'Daily challenge submit failed' });
        }
    });
}
