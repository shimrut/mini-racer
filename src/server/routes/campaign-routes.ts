import type { Application, Response } from 'express';
import { sendFailure } from './route-errors.js';

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
    // The published Creator series, and the placed stored tracks among these keys.
    describeStoredSeries?(): readonly { stages: readonly { trackKey: string }[] }[];
    describeStoredTracks?(trackKeys: string[]): unknown[];
    // Reads the catalog again after the answer is built, then loads the
    // tracks that the answer names.
    refreshStoredCatalog?(): Promise<void>;
    loadStoredTracks?(trackKeys: string[]): Promise<void>;
};

// The Campaign answer carries the published Creator series and their stored
// tracks, so the game can show them without a second request.
async function withStoredSeries(result: ServiceResult, dependencies: CampaignRouteDependencies): Promise<ServiceResult> {
    await dependencies.refreshStoredCatalog?.();
    const storedSeries = dependencies.describeStoredSeries?.() ?? [];
    if (!result.body || typeof result.body !== 'object') return result;
    const stages = (result.body as { stages?: { trackKey?: unknown }[] }).stages;
    const trackKeys = [...new Set([
        ...storedSeries.flatMap((series) => series.stages.map((stage) => stage.trackKey)),
        ...(Array.isArray(stages) ? stages.flatMap((stage) => typeof stage?.trackKey === 'string' ? [stage.trackKey] : []) : []),
    ])];
    await dependencies.loadStoredTracks?.(trackKeys);
    const storedTracks = dependencies.describeStoredTracks?.(trackKeys) ?? [];
    return {
        ...result,
        body: { ...result.body, ...(storedSeries.length ? { storedSeries } : {}),
            ...(dependencies.describeStoredTracks ? { storedTracks } : {}) },
    };
}

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
            const { playerId, guestToken, seriesId } = req.query ?? {};
            send(res, await withStoredSeries(await dependencies.getServerCampaignBootstrap({
                playerId,
                guestToken,
                seriesId,
                redditUsername: dependencies.getRequestUsername(),
            }), dependencies));
        } catch (error) {
            console.error('Failed to load Mini Racer Campaign:', error);
            sendFailure(res, error, { error: 'Campaign bootstrap failed' });
        }
    });

    app.post('/api/campaign/start', async (req, res) => {
        try {
            const result = await dependencies.startServerCampaignRace({
                ...(req.body ?? {}),
                redditUsername: dependencies.getRequestUsername(),
            });
            send(res, result);
        } catch (error) {
            console.error('Failed to start Mini Racer Campaign race:', error);
            sendFailure(res, error, { error: 'Campaign race start failed' });
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
            sendFailure(res, error, { error: 'Campaign standings failed' });
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
            sendFailure(res, error, { accepted: false, error: 'Campaign submission failed' });
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
            sendFailure(res, error, { error: 'Campaign ghost lookup failed' });
        }
    });
}
