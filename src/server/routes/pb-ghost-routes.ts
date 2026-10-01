import type { Application } from 'express';
import { sendPlayerAuthorizationFailure } from './player-routes.js';
import { sendFailure } from './route-errors.js';

type TrackPbPayload = {
    playerId: string | null;
    trackPbs?: unknown;
};

type PbGhostPayload = {
    playerId: string | null;
    challengeId: string | null;
    trackKey: string | null;
    personalBest: unknown;
};

export type PbGhostRouteDependencies = {
    getRequestUsername(): string | null;
    getServerPlayerTrackPbSummaries(input: Record<string, unknown>): Promise<TrackPbPayload>;
    getServerPlayerPbGhost(input: Record<string, unknown>): Promise<PbGhostPayload>;
};

function parseChallengeIds(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 7);
}

export function registerPbGhostRoutes(
    app: Application,
    dependencies: PbGhostRouteDependencies,
): void {
    app.get('/api/player/track-pbs', async (req, res) => {
        const { challengeIds, playerId, guestToken } = req.query ?? {};
        try {
            const payload = await dependencies.getServerPlayerTrackPbSummaries({
                challengeIds: parseChallengeIds(challengeIds),
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            });
            if (!payload.playerId) {
                sendPlayerAuthorizationFailure(res, { playerId, guestToken });
                return;
            }
            res.status(200).json({ trackPbs: payload.trackPbs ?? {} });
        } catch (error) {
            console.error('Failed to load Mini Racer track personal bests:', error);
            sendFailure(res, error, { error: 'Track personal best lookup failed' });
        }
    });

    app.get('/api/player/pb-ghost', async (req, res) => {
        const { challengeId, playerId, guestToken } = req.query ?? {};
        try {
            const payload = await dependencies.getServerPlayerPbGhost({
                challengeId,
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            });
            if (!payload.playerId) {
                sendPlayerAuthorizationFailure(res, { playerId, guestToken });
                return;
            }
            if (!payload.challengeId || !payload.trackKey) {
                res.status(404).json({ error: 'Daily challenge is not playable.' });
                return;
            }
            res.status(200).json({
                challengeId: payload.challengeId,
                trackKey: payload.trackKey,
                personalBest: payload.personalBest,
            });
        } catch (error) {
            console.error('Failed to load Mini Racer personal best ghost:', error);
            sendFailure(res, error, { error: 'Personal best ghost lookup failed' });
        }
    });
}
