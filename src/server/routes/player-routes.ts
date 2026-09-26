import type { Application, Response } from 'express';
import { hasText } from '../shared/value-guards.js';

type PlayerPayload = {
    playerId: string | null;
    firstSeenAt?: string | null;
    playerPreferences?: unknown;
};

export type PlayerRouteDependencies = {
    getRequestUsername(): string | null;
    getServerPlayerBootstrap(input: Record<string, unknown>): Promise<PlayerPayload>;
    selectServerGuestProgress(input: Record<string, unknown>): Promise<PlayerPayload>;
    updateServerPlayerIdentity(input: Record<string, unknown>): Promise<PlayerPayload>;
    updateServerPlayerPreferences(input: Record<string, unknown>): Promise<PlayerPayload>;
};

function sendPlayerAuthorizationFailure(
    res: Response,
    { playerId, guestToken }: { playerId?: unknown; guestToken?: unknown },
): void {
    if (hasText(playerId) || hasText(guestToken)) {
        res.status(401).json({ error: 'Guest token is required for this player.' });
        return;
    }
    res.status(400).json({ error: 'Invalid player identity.' });
}

export function registerPlayerRoutes(
    app: Application,
    dependencies: PlayerRouteDependencies,
): void {
    app.get('/api/player/bootstrap', async (req, res) => {
        try {
            const { playerId, guestToken } = req.query ?? {};
            const payload = await dependencies.getServerPlayerBootstrap({
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            });
            if (!payload.playerId) {
                sendPlayerAuthorizationFailure(res, { playerId, guestToken });
                return;
            }
            res.status(200).json(payload);
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer player bootstrap:', error);
            res.status(500).json({ error: 'Player bootstrap failed' });
        }
    });

    app.post('/api/player/progress-selection', async (req, res) => {
        try {
            const { playerId, guestToken, choice, action, transferId } = req.body ?? {};
            const payload = await dependencies.selectServerGuestProgress({
                playerId,
                guestToken,
                choice,
                action,
                transferId,
                redditUsername: dependencies.getRequestUsername(),
            });
            if (!payload.playerId) {
                sendPlayerAuthorizationFailure(res, { playerId, guestToken });
                return;
            }
            res.status(200).json(payload);
        } catch (error) {
            const statusCode = Number(error?.statusCode);
            if (statusCode === 401 || statusCode === 409 || statusCode === 503) {
                const reason = typeof error?.reason === 'string' ? error.reason : undefined;
                const transferId = typeof error?.transferId === 'string' ? error.transferId : undefined;
                res.status(statusCode).json({
                    error: reason === 'progress_selection_retryable'
                        ? 'Your save is busy. Wait a moment, then try again.'
                        : error.message,
                    ...(reason ? { reason } : {}),
                    ...(transferId ? { transferId } : {}),
                });
                return;
            }
            console.error('Failed to select Reddit Mini Racer guest progress:', error);
            res.status(500).json({ error: 'Guest progress selection failed' });
        }
    });

    app.post('/api/player/identity', async (req, res) => {
        try {
            const { playerId, guestToken, leaderboardIdentity } = req.body ?? {};
            const payload = await dependencies.updateServerPlayerIdentity({
                playerId,
                guestToken,
                leaderboardIdentity,
                redditUsername: dependencies.getRequestUsername(),
            });
            if (!payload.playerId) {
                sendPlayerAuthorizationFailure(res, { playerId, guestToken });
                return;
            }
            res.status(200).json(payload);
        } catch (error) {
            console.error('Failed to update Reddit Mini Racer player identity:', error);
            res.status(500).json({ error: 'Player identity update failed' });
        }
    });

    app.post('/api/player/preferences', async (req, res) => {
        try {
            const { playerId, guestToken, playerPreferences } = req.body ?? {};
            const payload = await dependencies.updateServerPlayerPreferences({
                playerId,
                guestToken,
                playerPreferences,
                redditUsername: dependencies.getRequestUsername(),
            });
            if (!payload.playerId) {
                sendPlayerAuthorizationFailure(res, { playerId, guestToken });
                return;
            }
            if (!payload.playerPreferences) {
                res.status(400).json({ error: 'Invalid player preferences' });
                return;
            }
            res.status(200).json(payload);
        } catch (error) {
            console.error('Failed to update Reddit Mini Racer player preferences:', error);
            res.status(500).json({ error: 'Player preferences update failed' });
        }
    });
}
