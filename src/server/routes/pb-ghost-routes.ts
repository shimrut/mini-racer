import type { Application, Response } from 'express';
import { hasText } from '../shared/value-guards.js';

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

function sendAuthorizationFailure(
    res: Response,
    { playerId, guestToken }: { playerId?: unknown; guestToken?: unknown },
): void {
    if (hasText(playerId) || hasText(guestToken)) {
        res.status(401).json({ error: 'Guest token is required for this player.' });
        return;
    }
    res.status(400).json({ error: 'Invalid player identity.' });
}

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
                sendAuthorizationFailure(res, { playerId, guestToken });
                return;
            }
            res.status(200).json({ trackPbs: payload.trackPbs ?? {} });
        } catch (error) {
            console.error('Failed to load Mini Racer track personal bests:', error);
            res.status(500).json({ error: 'Track personal best lookup failed' });
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
                sendAuthorizationFailure(res, { playerId, guestToken });
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
            res.status(500).json({ error: 'Personal best ghost lookup failed' });
        }
    });
}
