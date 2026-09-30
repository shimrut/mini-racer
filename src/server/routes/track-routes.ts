import type { Application, Response } from 'express';
import { TrackInputError } from '../tracks/track-shape.js';
import { TrackConflictError } from '../tracks/track-store.js';

const MAX_PLAYER_TRACK_KEYS = 50;

export type TrackRouteDependencies = {
    resolveCreatorToolSubredditName(): string | null;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    listStoredTracks(): Promise<unknown[]>;
    listStoredTrackRecords(): Promise<unknown[]>;
    readStoredTrack(trackKey: string): Promise<unknown | null>;
    saveStoredTrack(
        trackKey: unknown,
        input: unknown,
        options: { username: string; baseRevision?: unknown },
    ): Promise<unknown>;
    deleteStoredTrack(
        trackKey: unknown,
        options: { baseRevision?: unknown; isPlaced?: (trackKey: string) => Promise<boolean> },
    ): Promise<boolean>;
    isTrackPlaced(trackKey: string): Promise<boolean>;
    readPlacedStoredTracks(trackKeys: string[]): Promise<unknown[]>;
    readCreatorDailyView(): Promise<{ latestTrackKey: string | null }>;
    runTrackMigration(options: { username: string; dryRun?: boolean }): Promise<unknown>;
    readMigrationReport(): Promise<unknown>;
    saveDailySchedule(
        keys: unknown,
        options: { username: string; baseRevision?: unknown; currentTrackKey?: string | null },
    ): Promise<unknown>;
};

export function errorResponse(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Track request failed.';
    const status = error instanceof TrackInputError ? 400
        : error instanceof TrackConflictError ? 409
            : message.includes('Moderator access required') || message.includes('acting username') ? 403
                : 500;
    if (status === 500) console.error('Track request failed:', error);
    res.status(status).json({ error: message });
}

export async function creatorUsername(dependencies: {
    resolveCreatorToolSubredditName(): string | null;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
}): Promise<string> {
    const subredditName = dependencies.resolveCreatorToolSubredditName();
    if (!subredditName) {
        throw new TrackInputError('Open the Mini Racer Creator from its moderator menu.');
    }
    return dependencies.assertModeratorForSubreddit(subredditName);
}

function readTrackKeysQuery(value: unknown): string[] {
    const text = typeof value === 'string' ? value : '';
    return [...new Set(text.split(',').map((key) => key.trim()).filter(Boolean))]
        .slice(0, MAX_PLAYER_TRACK_KEYS);
}

export function registerTrackRoutes(app: Application, dependencies: TrackRouteDependencies): void {
    app.get('/api/creator/tracks', async (req, res) => {
        try {
            await creatorUsername(dependencies);
            res.json({
                tracks: req.query.full === '1'
                    ? await dependencies.listStoredTrackRecords()
                    : await dependencies.listStoredTracks(),
            });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.get('/api/creator/tracks/:key', async (req, res) => {
        try {
            await creatorUsername(dependencies);
            const track = await dependencies.readStoredTrack(req.params.key);
            if (!track) {
                res.status(404).json({ error: 'Track not found.' });
                return;
            }
            res.json({ track });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.put('/api/creator/tracks/:key', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            const track = await dependencies.saveStoredTrack(req.params.key, req.body, {
                username,
                baseRevision: req.body?.baseRevision,
            });
            res.json({ track });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.delete('/api/creator/tracks/:key', async (req, res) => {
        try {
            await creatorUsername(dependencies);
            const deleted = await dependencies.deleteStoredTrack(req.params.key, {
                baseRevision: req.query.baseRevision,
                isPlaced: (trackKey) => dependencies.isTrackPlaced(trackKey),
            });
            if (!deleted) {
                res.status(404).json({ error: 'Track not found.' });
                return;
            }
            res.json({ deleted: true });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.get('/api/creator/daily', async (_req, res) => {
        try {
            await creatorUsername(dependencies);
            res.json(await dependencies.readCreatorDailyView());
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.put('/api/creator/daily', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            const { latestTrackKey } = await dependencies.readCreatorDailyView();
            await dependencies.saveDailySchedule(req.body?.keys, {
                username,
                baseRevision: req.body?.baseRevision,
                currentTrackKey: latestTrackKey,
            });
            res.json(await dependencies.readCreatorDailyView());
        } catch (error) {
            errorResponse(res, error);
        }
    });

    // The last copy of unplayed tracks, and what a copy now would do.
    app.get('/api/creator/migration', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json({
                report: await dependencies.readMigrationReport(),
                preview: await dependencies.runTrackMigration({ username, dryRun: true }),
            });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/migration', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json({ report: await dependencies.runTrackMigration({ username }) });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    // Players load a stored track that a Daily or a published series uses.
    app.get('/api/tracks/stored', async (req, res) => {
        try {
            const keys = readTrackKeysQuery(req.query.keys);
            res.json({ tracks: keys.length ? await dependencies.readPlacedStoredTracks(keys) : [] });
        } catch (error) {
            errorResponse(res, error);
        }
    });
}
