import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTrackRoutes } from '../src/server/routes/track-routes.ts';
import { TrackInputError } from '../src/server/tracks/track-shape.ts';
import { TrackConflictError } from '../src/server/tracks/track-store.ts';

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
        readStoredTrack: vi.fn(async () => null),
        saveStoredTrack: vi.fn(async (key) => ({ key, revision: 1 })),
        deleteStoredTrack: vi.fn(async () => true),
        isTrackPlaced: vi.fn(async () => false),
        readPlacedStoredTracks: vi.fn(async (keys) => keys.map((key) => ({ key }))),
        readCreatorDailyView: vi.fn(async () => ({ latestTrackKey: 'circuit', schedule: { keys: ['circuit'] } })),
        saveDailySchedule: vi.fn(async () => ({})),
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
