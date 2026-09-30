import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTrackRoutes } from '../src/server/routes/track-routes.ts';
import { TrackInputError } from '../src/server/tracks/track-shape.ts';
import { TrackConflictError } from '../src/server/tracks/track-store.ts';
import { TrackPlacementRetryError } from '../src/server/tracks/track-placement-lock.ts';

vi.mock('@devvit/web/server', () => ({ redis: {}, context: {} }));

const openServers = new Set();

afterEach(async () => {
    await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
    openServers.clear();
});

async function startApp(dependencies) {
    const app = express();
    app.use(express.json());
    registerTrackRoutes(app, dependencies);
    const server = app.listen(0, '127.0.0.1');
    openServers.add(server);
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

function deps(overrides = {}) {
    return {
        resolveCreatorToolSubredditName: () => 'MiniRacer',
        assertModeratorForSubreddit: vi.fn(async () => 'RaceMod'),
        listStoredTracks: vi.fn(async () => []),
        listStoredTrackRecords: vi.fn(async () => [{ key: 'nightCut', track: {} }]),
        readStoredTrack: vi.fn(async () => null),
        saveStoredTrack: vi.fn(async (key) => ({ key, revision: 1 })),
        deleteStoredTrack: vi.fn(async () => true),
        isTrackPlaced: vi.fn(async () => false),
        readPlacedStoredTracks: vi.fn(async (keys) => keys.map((key) => ({ key }))),
        readCreatorDailyView: vi.fn(async () => ({ latestTrackKey: 'circuit', schedule: { keys: ['circuit'] } })),
        saveDailySchedule: vi.fn(async () => ({})),
        runTrackMigration: vi.fn(async (options) => ({ dryRun: Boolean(options.dryRun), copied: ['smallSteps'] })),
        readMigrationReport: vi.fn(async () => null),
        runPlayedDailyCopy: vi.fn(async (options) => ({ dryRun: Boolean(options.dryRun), copied: ['albertGardens'] })),
        runLiveCampaignCopy: vi.fn(async (options) => ({ dryRun: Boolean(options.dryRun), copied: ['numbered-v1'] })),
        readLockedCopyReport: vi.fn(async () => null),
        ...overrides,
    };
}

describe('track routes', () => {
    it('checks moderator membership before every Creator read and write', async () => {
        const dependencies = deps({
            assertModeratorForSubreddit: vi.fn(async () => {
                throw new Error('Moderator access required for r/MiniRacer.');
            }),
        });
        const base = await startApp(dependencies);
        const responses = await Promise.all([
            fetch(`${base}/api/creator/tracks`),
            fetch(`${base}/api/creator/tracks/nightCut`),
            fetch(`${base}/api/creator/tracks/nightCut`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ track: {} }),
            }),
            fetch(`${base}/api/creator/tracks/nightCut`, { method: 'DELETE' }),
        ]);
        expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
        expect(dependencies.saveStoredTrack).not.toHaveBeenCalled();
        expect(dependencies.deleteStoredTrack).not.toHaveBeenCalled();
    });

    it('passes the moderator and the base revision to a save', async () => {
        const dependencies = deps();
        const base = await startApp(dependencies);
        const response = await fetch(`${base}/api/creator/tracks/nightCut`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ track: { name: 'Night Cut' }, baseRevision: 3 }),
        });
        expect(response.status).toBe(200);
        expect(dependencies.saveStoredTrack).toHaveBeenCalledWith(
            'nightCut',
            { track: { name: 'Night Cut' }, baseRevision: 3 },
            { username: 'RaceMod', baseRevision: 3 },
        );
    });

    it('answers a bad track with 400 and a stale save with 409', async () => {
        const saveStoredTrack = vi.fn()
            .mockRejectedValueOnce(new TrackInputError('Give the track a name.'))
            .mockRejectedValueOnce(new TrackConflictError('This track changed on another device.'));
        const base = await startApp(deps({ saveStoredTrack }));
        const put = () => fetch(`${base}/api/creator/tracks/nightCut`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ track: {} }),
        });
        expect((await put()).status).toBe(400);
        expect((await put()).status).toBe(409);
    });

    it('checks the Daily list and the series before a delete', async () => {
        const dependencies = deps({
            deleteStoredTrack: vi.fn(async (_key, options) => {
                if (await options.isPlaced('nightCut')) throw new TrackInputError('Placed.');
                return true;
            }),
            isTrackPlaced: vi.fn(async () => true),
        });
        const base = await startApp(dependencies);
        const response = await fetch(`${base}/api/creator/tracks/nightCut?baseRevision=2`, { method: 'DELETE' });
        expect(response.status).toBe(400);
        expect(dependencies.deleteStoredTrack.mock.calls[0][1].baseRevision).toBe('2');
    });

    it('returns 503 for a busy placement fence without claiming a save', async () => {
        const base = await startApp(deps({
            saveStoredTrack: vi.fn(async () => { throw new TrackPlacementRetryError(); }),
        }));
        const response = await fetch(`${base}/api/creator/tracks/nightCut`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ track: {} }),
        });
        expect(response.status).toBe(503);
        expect((await response.json()).error).toContain('Retry');
    });

    it('saves the Daily list and keeps the latest Daily track in it', async () => {
        const dependencies = deps();
        const base = await startApp(dependencies);
        const response = await fetch(`${base}/api/creator/daily`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ keys: ['circuit', 'nightCut'], baseRevision: 4 }),
        });
        expect(response.status).toBe(200);
        expect(dependencies.saveDailySchedule).toHaveBeenCalledWith(['circuit', 'nightCut'], {
            username: 'RaceMod',
            baseRevision: 4,
            currentTrackKey: 'circuit',
        });
        expect((await response.json()).schedule.keys).toEqual(['circuit']);
    });

    it('checks moderator membership before the Daily list', async () => {
        const dependencies = deps({
            assertModeratorForSubreddit: vi.fn(async () => {
                throw new Error('Moderator access required for r/MiniRacer.');
            }),
        });
        const base = await startApp(dependencies);
        expect((await fetch(`${base}/api/creator/daily`)).status).toBe(403);
        expect(dependencies.readCreatorDailyView).not.toHaveBeenCalled();
    });

    it('shows a dry run of the copy, and runs it on POST', async () => {
        const dependencies = deps();
        const base = await startApp(dependencies);
        const preview = await (await fetch(`${base}/api/creator/migration`)).json();
        expect(preview).toEqual({
            report: null,
            preview: { dryRun: true, copied: ['smallSteps'] },
            playedDailies: { report: null, preview: { dryRun: true, copied: ['albertGardens'] } },
            liveCampaign: { report: null, preview: { dryRun: true, copied: ['numbered-v1'] } },
        });
        const run = await (await fetch(`${base}/api/creator/migration`, { method: 'POST' })).json();
        expect(run.report.dryRun).toBe(false);
        expect(dependencies.runTrackMigration).toHaveBeenLastCalledWith({ username: 'RaceMod' });
        const played = await (await fetch(`${base}/api/creator/migration/played-dailies`, { method: 'POST' })).json();
        expect(played.report).toEqual({ dryRun: false, copied: ['albertGardens'] });
        expect(dependencies.runPlayedDailyCopy).toHaveBeenLastCalledWith({ username: 'RaceMod' });
        expect(dependencies.readLockedCopyReport).toHaveBeenCalledWith('played-dailies');
        const campaign = await (await fetch(`${base}/api/creator/migration/live-campaign`, { method: 'POST' })).json();
        expect(campaign.report).toEqual({ dryRun: false, copied: ['numbered-v1'] });
        expect(dependencies.runLiveCampaignCopy).toHaveBeenLastCalledWith({ username: 'RaceMod' });
    });

    it('gives players placed tracks without a moderator check, 50 keys at most', async () => {
        const dependencies = deps();
        const base = await startApp(dependencies);
        const keys = Array.from({ length: 60 }, (_unused, index) => `track${index}`);
        const response = await fetch(`${base}/api/tracks/stored?keys=${keys.join(',')},track1`);
        expect(response.status).toBe(200);
        expect((await response.json()).tracks).toHaveLength(50);
        expect(dependencies.assertModeratorForSubreddit).not.toHaveBeenCalled();
    });
});
