import type { Application } from 'express';
import { sendFailure } from './route-errors.js';

type ShareServiceResult = {
    status: number;
    body: unknown;
};

export type ShareRouteDependencies = {
    getDailyGpShareRequestContext(): Promise<Record<string, unknown>>;
    previewDailyGpShare(
        input: Record<string, unknown>,
        context: Record<string, unknown>,
    ): Promise<ShareServiceResult>;
    confirmDailyGpShare(
        input: Record<string, unknown>,
        context: Record<string, unknown>,
    ): Promise<ShareServiceResult>;
};

export function registerShareRoutes(
    app: Application,
    dependencies: ShareRouteDependencies,
): void {
    app.post('/api/daily/share/preview', async (req, res) => {
        try {
            const result = await dependencies.previewDailyGpShare(
                req.body ?? {},
                await dependencies.getDailyGpShareRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to preview Reddit Mini Racer result share:', error);
            sendFailure(res, error, {
                status: 'share_failed',
                error: 'Could not prepare this result for sharing.',
            });
        }
    });

    app.post('/api/daily/share/confirm', async (req, res) => {
        try {
            const result = await dependencies.confirmDailyGpShare(
                req.body ?? {},
                await dependencies.getDailyGpShareRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to share Reddit Mini Racer result:', error);
            sendFailure(res, error, {
                status: 'share_failed',
                error: 'Could not share this result.',
            });
        }
    });
}
