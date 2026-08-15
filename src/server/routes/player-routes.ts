import type { Application, Response } from 'express';

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
    recordPlayerPresence?(playerId: string, firstSeenAt?: string | null): void;
};

function hasPlayerCredential(value: unknown): boolean {
    return typeof value === 'string' && Boolean(value.trim());
}

function sendPlayerAuthorizationFailure(
    res: Response,
    { playerId, guestToken }: { playerId?: unknown; guestToken?: unknown },
): void {
    if (hasPlayerCredential(playerId) || hasPlayerCredential(guestToken)) {
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
            dependencies.recordPlayerPresence?.(payload.playerId, payload.firstSeenAt);
            res.status(200).json(payload);
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer player bootstrap:', error);
            res.status(500).json({ error: 'Player bootstrap failed' });
        }
    });

    app.post('/api/player/progress-selection', async (req, res) => {
        try {
            const { playerId, guestToken, choice } = req.body ?? {};
            const payload = await dependencies.selectServerGuestProgress({
                playerId,
                guestToken,
                choice,
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
                res.status(statusCode).json({ error: error.message });
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
