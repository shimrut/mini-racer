import type { Application, Response } from 'express';

type ServiceResult = {
    status: number;
    body: unknown;
};

export type CampaignRouteDependencies = {
    getRequestUsername(): string | null;
    getRequestRateLimitIdentity(): string | null;
    getServerCampaignBootstrap(input: Record<string, unknown>): Promise<ServiceResult>;
    startServerCampaignRace(input: Record<string, unknown>): Promise<ServiceResult>;
    getServerCampaignSnapshot(input: Record<string, unknown>): Promise<ServiceResult>;
    submitServerCampaignRun(input: Record<string, unknown>): Promise<ServiceResult>;
    getServerCampaignPbGhost(input: Record<string, unknown>): Promise<ServiceResult>;
};

function parseOptionalInteger(value: unknown): number | undefined {
    if (value == null || value === '') return undefined;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function send(res: Response, result: ServiceResult) {
    res.status(result.status).json(result.body);
}

export function registerCampaignRoutes(
    app: Application,
    dependencies: CampaignRouteDependencies,
): void {
    app.get('/api/campaign/bootstrap', async (req, res) => {
        try {
            const { playerId, guestToken } = req.query ?? {};
            send(res, await dependencies.getServerCampaignBootstrap({
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            }));
        } catch (error) {
            console.error('Failed to load Mini Racer Campaign:', error);
            res.status(500).json({ error: 'Campaign bootstrap failed' });
        }
    });

    app.post('/api/campaign/start', async (req, res) => {
        try {
            send(res, await dependencies.startServerCampaignRace({
                ...(req.body ?? {}),
                redditUsername: dependencies.getRequestUsername(),
            }));
        } catch (error) {
            console.error('Failed to start Mini Racer Campaign race:', error);
            res.status(500).json({ error: 'Campaign race start failed' });
        }
    });

    app.get('/api/campaign/snapshot', async (req, res) => {
        try {
            const { raceId, limit, offset, playerId, guestToken } = req.query ?? {};
            send(res, await dependencies.getServerCampaignSnapshot({
                raceId,
                limit: parseOptionalInteger(limit),
                offset: parseOptionalInteger(offset),
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            }));
        } catch (error) {
            console.error('Failed to load Mini Racer Campaign standings:', error);
            res.status(500).json({ error: 'Campaign standings failed' });
        }
    });

    app.post('/api/campaign/submit', async (req, res) => {
        try {
            send(res, await dependencies.submitServerCampaignRun({
                ...(req.body ?? {}),
                redditUsername: dependencies.getRequestUsername(),
                requestRateLimitIdentity: dependencies.getRequestRateLimitIdentity(),
            }));
        } catch (error) {
            console.error('Failed to submit Mini Racer Campaign run:', error);
            res.status(500).json({ accepted: false, error: 'Campaign submission failed' });
        }
    });

    app.get('/api/campaign/pb-ghost', async (req, res) => {
        try {
            const { raceId, playerId, guestToken } = req.query ?? {};
            send(res, await dependencies.getServerCampaignPbGhost({
                raceId,
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            }));
        } catch (error) {
            console.error('Failed to load Mini Racer Campaign ghost:', error);
            res.status(500).json({ error: 'Campaign ghost lookup failed' });
        }
    });
}
