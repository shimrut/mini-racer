import type { Application, Response } from 'express';
import { TrackInputError } from '../tracks/track-shape.js';
import { TrackConflictError } from '../tracks/track-store.js';
import { TrackPlacementRetryError } from '../tracks/track-placement-lock.js';
import { normalizedCreatorUsername } from '../tracks/creator-track-access.js';

const MAX_PLAYER_TRACK_KEYS = 50;
const COPY_KINDS = ['unplayed', 'played-dailies', 'live-campaign'] as const;
type CopyKind = typeof COPY_KINDS[number];

export type TrackRouteDependencies = {
    resolveCreatorToolSubredditName(): string | null;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    listStoredTracks(username: string): Promise<unknown[]>;
    listStoredTrackRecords(username: string): Promise<unknown[]>;
    readStoredTrack(trackKey: string, username: string): Promise<unknown | null>;
    saveStoredTrack(
        trackKey: unknown,
        input: unknown,
        options: { username: string; baseRevision?: unknown },
    ): Promise<unknown>;
    deleteStoredTrack(
        trackKey: unknown,
        options: { username: string; baseRevision?: unknown; isPlaced?: (trackKey: string) => Promise<boolean> },
    ): Promise<boolean>;
    isTrackPlaced(trackKey: string): Promise<boolean>;
    readPlacedStoredTracks(trackKeys: string[]): Promise<unknown[]>;
    readCreatorDailyView(username: string): Promise<{ latestTrackKey: string | null }>;
    runTrackMigration(options: { username: string; dryRun?: boolean }): Promise<unknown>;
    readMigrationReport(): Promise<unknown>;
    runPlayedDailyCopy(options: { username: string; dryRun?: boolean }): Promise<unknown>;
    runLiveCampaignCopy(options: { username: string; dryRun?: boolean }): Promise<unknown>;
    readLockedCopyReport(kind: 'played-dailies' | 'live-campaign'): Promise<unknown>;
    // Compares every copy in Redis with the app again, and keeps the result.
    runCopyCheck?(options: { username: string }): Promise<unknown>;
    readCopyCheck?(): Promise<unknown>;
    // Removes what a copy wrote, when it is still exactly the app version.
    runCopyUndo?(kind: CopyKind, options: { username: string; dryRun?: boolean }): Promise<unknown>;
    readCopyUndoReport?(kind: CopyKind): Promise<unknown>;
    saveDailySchedule(
        keys: unknown,
        options: { username: string; baseRevision?: unknown; currentTrackKey?: string | null },
    ): Promise<unknown>;
};

export function errorResponse(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Track request failed.';
    const status = error instanceof TrackInputError ? 400
        : error instanceof TrackConflictError ? 409
            : error instanceof TrackPlacementRetryError ? 503
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

function assertCreatorAccount(username: string, expected: unknown): void {
    if (expected !== undefined && normalizedCreatorUsername(expected) !== normalizedCreatorUsername(username)) {
        throw new TrackConflictError('The Reddit account changed. Reopen the Creator before saving.');
    }
}

function readTrackKeysQuery(value: unknown): string[] {
    const text = typeof value === 'string' ? value : '';
    return [...new Set(text.split(',').map((key) => key.trim()).filter(Boolean))]
        .slice(0, MAX_PLAYER_TRACK_KEYS);
}

export function registerTrackRoutes(app: Application, dependencies: TrackRouteDependencies): void {
    app.get('/api/creator/tracks', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json({
                username,
                tracks: req.query.full === '1'
                    ? await dependencies.listStoredTrackRecords(username)
                    : await dependencies.listStoredTracks(username),
            });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.get('/api/creator/tracks/:key', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            assertCreatorAccount(username, req.query.creatorUsername);
            const track = await dependencies.readStoredTrack(req.params.key, username);
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
            assertCreatorAccount(username, req.body?.creatorUsername);
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
            const username = await creatorUsername(dependencies);
            assertCreatorAccount(username, req.query.creatorUsername);
            const deleted = await dependencies.deleteStoredTrack(req.params.key, {
                username,
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
            const username = await creatorUsername(dependencies);
            res.json(await dependencies.readCreatorDailyView(username));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.put('/api/creator/daily', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            const { latestTrackKey } = await dependencies.readCreatorDailyView(username);
            await dependencies.saveDailySchedule(req.body?.keys, {
                username,
                baseRevision: req.body?.baseRevision,
                currentTrackKey: latestTrackKey,
            });
            res.json(await dependencies.readCreatorDailyView(username));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    // The last run of each copy, and what a copy now would do.
    app.get('/api/creator/migration', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            const runUndo = dependencies.runCopyUndo;
            const readUndo = dependencies.readCopyUndoReport;
            const [report, preview, playedReport, playedPreview, campaignReport, campaignPreview, check, undo] = await Promise.all([
                dependencies.readMigrationReport(),
                dependencies.runTrackMigration({ username, dryRun: true }),
                dependencies.readLockedCopyReport('played-dailies'),
                dependencies.runPlayedDailyCopy({ username, dryRun: true }),
                dependencies.readLockedCopyReport('live-campaign'),
                dependencies.runLiveCampaignCopy({ username, dryRun: true }),
                dependencies.readCopyCheck?.() ?? null,
                runUndo && readUndo ? Promise.all(COPY_KINDS.map(async (kind) => [kind, {
                    preview: await runUndo(kind, { username, dryRun: true }),
                    report: await readUndo(kind),
                }])).then(Object.fromEntries) : null,
            ]);
            res.json({
                report,
                preview,
                playedDailies: { report: playedReport, preview: playedPreview },
                liveCampaign: { report: campaignReport, preview: campaignPreview },
                ...(dependencies.readCopyCheck ? { check } : {}),
                ...(undo ? { undo } : {}),
            });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    // Each copy checks every copy again when it ends. A failed check does not
    // undo the copy: the answer shows the copy report and the check error.
    async function withCopyCheck(username: string, report: unknown) {
        if (!dependencies.runCopyCheck) return { report };
        try {
            return { report, check: await dependencies.runCopyCheck({ username }) };
        } catch (error) {
            console.error('The copy check failed:', error);
            return { report, checkError: error instanceof Error ? error.message : 'The check failed.' };
        }
    }

    app.post('/api/creator/migration/played-dailies', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json(await withCopyCheck(username, await dependencies.runPlayedDailyCopy({ username })));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/migration/live-campaign', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json(await withCopyCheck(username, await dependencies.runLiveCampaignCopy({ username })));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/migration/undo/:kind', async (req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            const kind = COPY_KINDS.find((entry) => entry === req.params.kind);
            if (!kind || !dependencies.runCopyUndo) throw new TrackInputError('There is no such copy to undo.');
            res.json(await withCopyCheck(username, await dependencies.runCopyUndo(kind, { username })));
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/migration/check', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            if (!dependencies.runCopyCheck) throw new TrackInputError('The copy check is not available.');
            res.json({ check: await dependencies.runCopyCheck({ username }) });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    app.post('/api/creator/migration', async (_req, res) => {
        try {
            const username = await creatorUsername(dependencies);
            res.json(await withCopyCheck(username, await dependencies.runTrackMigration({ username })));
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
