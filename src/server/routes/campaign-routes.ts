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
    getServerCampaignPoster(input: Record<string, unknown>): Promise<ServiceResult>;
    startServerCampaignRace(input: Record<string, unknown>): Promise<ServiceResult>;
    getServerCampaignSnapshot(input: Record<string, unknown>): Promise<ServiceResult>;
    getServerCampaignAggregate(input: Record<string, unknown>): Promise<ServiceResult>;
    submitServerCampaignRun(input: Record<string, unknown>): Promise<ServiceResult>;
    getServerCampaignPbGhost(input: Record<string, unknown>): Promise<ServiceResult>;
    previewServerCampaignResultsShare(input: Record<string, unknown>): Promise<ServiceResult>;
    confirmServerCampaignResultsShare(input: Record<string, unknown>): Promise<ServiceResult>;
    markServerCampaignResultsSharePending(input: Record<string, unknown>): Promise<void>;
    refreshServerCampaignResultsShare(input: Record<string, unknown>): Promise<void>;
    readContextSubredditName(): string | null;
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
    app.get('/api/campaign/poster', async (req, res) => {
        try {
            await dependencies.refreshStoredCatalog?.();
            const result = await dependencies.getServerCampaignPoster({ seriesId: req.query?.seriesId });
            const trackKey = result.status === 200 && result.body && typeof result.body === 'object'
                ? (result.body as { trackKey?: unknown }).trackKey : null;
            if (typeof trackKey !== 'string' || !trackKey) {
                send(res, result);
                return;
            }
            await dependencies.loadStoredTracks?.([trackKey]);
            send(res, {
                ...result,
                body: { ...(result.body as object), storedTracks: dependencies.describeStoredTracks?.([trackKey]) ?? [] },
            });
        } catch (error) {
            console.error('Failed to load Mini Racer Campaign poster:', error);
            sendFailure(res, error, { error: 'Campaign poster failed' });
        }
    });

    app.get('/api/campaign/bootstrap', async (req, res) => {
        try {
            const { playerId, guestToken, seriesId } = req.query ?? {};
            const result = await withStoredSeries(await dependencies.getServerCampaignBootstrap({
                playerId,
                guestToken,
                seriesId,
                redditUsername: dependencies.getRequestUsername(),
            }), dependencies);
            if (result.status === 200) {
                try {
                    await dependencies.refreshServerCampaignResultsShare?.({
                        seriesId: (result.body as { campaignId?: unknown })?.campaignId,
                        redditUsername: dependencies.getRequestUsername(),
                        subredditName: dependencies.readContextSubredditName?.(),
                        onlyIfPending: true,
                    });
                } catch (error) {
                    console.error('Campaign shared post could not be refreshed:', error);
                }
            }
            send(res, result);
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

    app.get('/api/campaign/aggregate', async (req, res) => {
        try {
            const { seriesId, limit, offset, playerId, guestToken } = req.query ?? {};
            send(res, await dependencies.getServerCampaignAggregate({
                seriesId, limit: parseOptionalInteger(limit), offset: parseOptionalInteger(offset), playerId, guestToken,
                redditUsername: dependencies.getRequestUsername(),
            }));
        } catch (error) {
            console.error('Failed to load Mini Racer Campaign aggregate standings:', error);
            sendFailure(res, error, { error: 'Campaign leaderboard failed' });
        }
    });

    app.post('/api/campaign/submit', async (req, res) => {
        try {
            const redditUsername = dependencies.getRequestUsername();
            const result = await dependencies.submitServerCampaignRun({
                ...(req.body ?? {}),
                redditUsername,
                requestRateLimitIdentity: dependencies.getRequestRateLimitIdentity(),
            });
            if (result.status === 200 && (result.body as { accepted?: boolean })?.accepted === true) {
                try {
                    await dependencies.markServerCampaignResultsSharePending({
                        raceId: req.body?.raceId,
                        redditUsername,
                        subredditName: dependencies.readContextSubredditName(),
                    });
                } catch (error) {
                    console.error('Campaign race saved, but its shared post could not be marked for refresh:', error);
                }
            }
            send(res, result);
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

    app.post('/api/campaign/share/preview', async (req, res) => {
        try {
            send(res, await dependencies.previewServerCampaignResultsShare({
                seriesId: req.body?.seriesId,
                redditUsername: dependencies.getRequestUsername(),
                subredditName: dependencies.readContextSubredditName(),
            }));
        } catch (error) {
            console.error('Failed to preview Mini Racer Campaign results:', error);
            sendFailure(res, error, { status: 'share_failed', error: 'Could not prepare this result for sharing.' });
        }
    });

    app.post('/api/campaign/share/confirm', async (req, res) => {
        try {
            send(res, await dependencies.confirmServerCampaignResultsShare({
                shareToken: req.body?.shareToken,
                redditUsername: dependencies.getRequestUsername(),
                subredditName: dependencies.readContextSubredditName(),
            }));
        } catch (error) {
            console.error('Failed to share Mini Racer Campaign results:', error);
            sendFailure(res, error, { status: 'share_failed', error: 'Could not share this result.' });
        }
    });
}
