import type { Application, Response } from 'express';
import { isDailyGhostArchiveChoice, type DailyGhostArchiveChoice } from '../daily/daily-ghost-archive.js';

export type AnalyticsRouteDependencies = {
    resolveAnalyticsToolSubredditName(): Promise<string | null>;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    getServerAnalyticsSummary(): Promise<unknown>;
    getGuestProgressTransferDiagnostic(input: {
        redditPlayerId?: unknown;
        transferId?: unknown;
    }): Promise<unknown>;
    getRequestUsername(): string | null;
    recordRaceStart(input: Record<string, unknown>): Promise<void>;
    recordPodiumEvent(input: Record<string, unknown>): Promise<void>;
    recordChallengeEvent(input: { action: unknown }): Promise<void>;
    getChallengeAnalyticsPage(subredditName: string, offset: number, period: 'today' | 'lifetime'): Promise<unknown>;
    getStorageSummary(): Promise<unknown>;
    readDailyGhostArchiveStatus(): Promise<unknown>;
    saveDailyGhostArchiveSetting(choice: DailyGhostArchiveChoice, changedBy: string): Promise<unknown>;
    readGhostCompactionState(): Promise<unknown>;
    setGhostCompactionStep(action: 'start' | 'pause', step: 'expired' | 'campaign'): Promise<unknown>;
    isGhostCompactionStepName(value: unknown): value is 'expired' | 'campaign';
};

const PODIUM_ANALYTICS_ACTIONS = new Set(['play', 'replay']);
const CHALLENGE_ANALYTICS_ACTIONS = new Set(['view', 'click', 'own_open']);

const CLIENT_REPORTED_START_MODES = new Set(['daily', 'campaign', 'challenge']);

export function registerAnalyticsRoutes(
    app: Application,
    dependencies: AnalyticsRouteDependencies,
): void {
    app.post('/api/analytics/race-start', async (req, res) => {
        const { mode, playerId, guestToken } = req.body ?? {};
        if (!CLIENT_REPORTED_START_MODES.has(mode)) {
            res.status(400).json({ error: 'Unsupported race start mode.' });
            return;
        }
        try {
            await dependencies.recordRaceStart({
                mode,
                playerId,
                guestToken,
                redditUsername: dependencies.getRequestUsername(),
            });
        } catch (error) {
            console.error('Failed to record Mini Racer race start:', error);
        }
        res.status(204).end();
    });

    app.post('/api/analytics/podium', async (req, res) => {
        const { action } = req.body ?? {};
        if (!PODIUM_ANALYTICS_ACTIONS.has(action)) {
            res.status(400).json({ error: 'Unsupported podium analytics action.' });
            return;
        }
        try {
            await dependencies.recordPodiumEvent({ action });
        } catch (error) {
            console.error('Failed to record Mini Racer podium analytics:', error);
        }
        res.status(204).end();
    });

    app.post('/api/analytics/challenge', async (req, res) => {
        const { action } = req.body ?? {};
        if (!CHALLENGE_ANALYTICS_ACTIONS.has(action)) {
            res.status(400).json({ error: 'Unsupported challenge analytics action.' });
            return;
        }
        try {
            await dependencies.recordChallengeEvent({ action });
        } catch (error) {
            console.error('Failed to record Mini Racer challenge analytics:', error);
        }
        res.status(204).end();
    });

    app.get('/api/analytics/challenges', async (req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            await dependencies.assertModeratorForSubreddit(subredditName);
            const rawOffset = req.query.offset ?? '0';
            const offset = typeof rawOffset === 'string' && /^\d+$/.test(rawOffset)
                ? Number(rawOffset)
                : Number.NaN;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 25) {
                res.status(400).json({ error: 'Invalid challenge analytics offset.' });
                return;
            }
            const rawPeriod = req.query.period ?? 'today';
            if (rawPeriod !== 'today' && rawPeriod !== 'lifetime') {
                res.status(400).json({ error: 'Invalid challenge analytics period.' });
                return;
            }
            res.status(200).json(await dependencies.getChallengeAnalyticsPage(subredditName, offset, rawPeriod));
        } catch (error) {
            const message = error instanceof Error && error.message ? error.message : 'Challenge analytics failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            if (status !== 403) console.error('Failed to load Mini Racer challenge analytics:', error);
            res.status(status).json({ error: message });
        }
    });

    app.get('/api/analytics/summary', async (_req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }

            await dependencies.assertModeratorForSubreddit(subredditName);
            res.status(200).json(await dependencies.getServerAnalyticsSummary());
        } catch (error) {
            console.error('Failed to load Reddit Mini Racer analytics summary:', error);
            const message = error instanceof Error && error.message
                ? error.message
                : 'Analytics summary failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            res.status(status).json({ error: message });
        }
    });

    // The Storage tab: the Redis size walk and the ghost move, read only when
    // the tab opens, so the Players tab does not wait for the walk.
    app.get('/api/analytics/storage', async (_req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            await dependencies.assertModeratorForSubreddit(subredditName);
            res.status(200).json(await dependencies.getStorageSummary());
        } catch (error) {
            const message = error instanceof Error && error.message ? error.message : 'Storage summary failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            if (status !== 403) console.error('Failed to load Mini Racer storage summary:', error);
            res.status(status).json({ error: message });
        }
    });

    // The move of old Daily ghosts to blob storage: its progress, and the
    // moderator's choice. Each install keeps its own choice.
    app.get('/api/analytics/ghost-archive', async (_req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            await dependencies.assertModeratorForSubreddit(subredditName);
            res.status(200).json(await dependencies.readDailyGhostArchiveStatus());
        } catch (error) {
            const message = error instanceof Error && error.message ? error.message : 'Ghost move status failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            if (status !== 403) console.error('Failed to load the Daily ghost move status:', error);
            res.status(status).json({ error: message });
        }
    });

    app.post('/api/analytics/ghost-archive', async (req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            const username = await dependencies.assertModeratorForSubreddit(subredditName);
            const choice = req.body?.choice;
            if (!isDailyGhostArchiveChoice(choice)) {
                res.status(400).json({ error: 'Unknown ghost move choice.' });
                return;
            }
            await dependencies.saveDailyGhostArchiveSetting(choice, username);
            console.log(`Daily ghost move set to ${choice} by u/${username} in r/${subredditName}.`);
            res.status(200).json(await dependencies.readDailyGhostArchiveStatus());
        } catch (error) {
            const message = error instanceof Error && error.message ? error.message : 'Ghost move choice failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            if (status !== 403) console.error('Failed to save the Daily ghost move choice:', error);
            res.status(status).json({ error: message });
        }
    });

    // Ghost compaction: its steps and progress, and Start or Pause for a step.
    app.get('/api/analytics/ghost-compaction', async (_req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            await dependencies.assertModeratorForSubreddit(subredditName);
            res.status(200).json(await dependencies.readGhostCompactionState());
        } catch (error) {
            const message = error instanceof Error && error.message ? error.message : 'Ghost compaction status failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            if (status !== 403) console.error('Failed to load the ghost compaction status:', error);
            res.status(status).json({ error: message });
        }
    });

    app.post('/api/analytics/ghost-compaction', async (req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            const username = await dependencies.assertModeratorForSubreddit(subredditName);
            const { action, step } = req.body ?? {};
            if ((action !== 'start' && action !== 'pause') || !dependencies.isGhostCompactionStepName(step)) {
                res.status(400).json({ error: 'Unknown ghost compaction action.' });
                return;
            }
            const state = await dependencies.setGhostCompactionStep(action, step);
            console.log(`Ghost compaction ${action} ${step} by u/${username} in r/${subredditName}.`);
            res.status(200).json(state);
        } catch (error) {
            const message = error instanceof Error && error.message ? error.message : 'Ghost compaction action failed';
            // A refused Start: another step runs, or an earlier step is not finished.
            const status = message.includes('Moderator access required')
                ? 403
                : error instanceof Error && error.name === 'GhostCompactionRefusal' ? 409 : 500;
            if (status === 500) console.error('Failed to change the ghost compaction step:', error);
            res.status(status).json({ error: message });
        }
    });

    app.get('/api/analytics/guest-transfer', async (req, res: Response) => {
        try {
            const subredditName = await dependencies.resolveAnalyticsToolSubredditName();
            if (!subredditName) {
                res.status(400).json({ error: 'Missing subreddit context for analytics.' });
                return;
            }
            await dependencies.assertModeratorForSubreddit(subredditName);

            const username = typeof req.query?.username === 'string' ? req.query.username.trim() : '';
            const transferId = typeof req.query?.transferId === 'string'
                ? req.query.transferId.trim()
                : undefined;
            if (!username) {
                res.status(400).json({ error: 'A Reddit username is required.' });
                return;
            }
            res.status(200).json(await dependencies.getGuestProgressTransferDiagnostic({
                redditPlayerId: `reddit:${username.toLowerCase()}`,
                transferId,
            }));
        } catch (error) {
            const message = error instanceof Error && error.message
                ? error.message
                : 'Guest transfer diagnostic failed';
            const status = message.includes('Moderator access required') ? 403 : 500;
            if (status !== 403) {
                console.error('Guest transfer diagnostic failed.');
            }
            res.status(status).json({ error: message });
        }
    });
}
