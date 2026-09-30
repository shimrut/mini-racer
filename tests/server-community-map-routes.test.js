import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCommunityMapRoutes } from '../src/server/routes/community-map-routes.ts';
import { registerInternalRoutes } from '../src/server/routes/internal-routes.ts';

const openServers = new Set();

afterEach(async () => {
    await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
    openServers.clear();
});

async function startApp(register) {
    const app = express();
    app.use(express.json());
    register(app);
    const server = app.listen(0, '127.0.0.1');
    openServers.add(server);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

function deps(overrides = {}) {
    return {
        resolveCreatorToolSubredditName: () => 'MiniRacer',
        readContextSubredditName: () => 'MiniRacer',
        assertModeratorForSubreddit: vi.fn(async () => 'RaceMod'),
        readCommunityDraft: vi.fn(async () => null),
        saveCommunityDraft: vi.fn(async (_sub, _user, input) => ({ track: input.track, revision: 1 })),
        publishCommunityDraft: vi.fn(async () => ({ map: { id: 'one' } })),
        listCommunityMaps: vi.fn(async () => ({ maps: [], nextCursor: null })),
        readPublicCommunityMap: vi.fn(async () => null),
        changeCommunityMapStatus: vi.fn(async () => null),
        ...overrides,
    };
}

describe('Community map routes', () => {
    it('checks moderator membership before reading or writing drafts', async () => {
        const dependencies = deps({
            assertModeratorForSubreddit: vi.fn(async () => {
                throw new Error('Moderator access required for r/MiniRacer.');
            }),
        });
        const base = await startApp((app) => registerCommunityMapRoutes(app, dependencies));
        const read = await fetch(`${base}/api/creator/draft`);
        const write = await fetch(`${base}/api/creator/draft`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ track: {} }),
        });
        expect(read.status).toBe(403);
        expect(write.status).toBe(403);
        expect(dependencies.readCommunityDraft).not.toHaveBeenCalled();
        expect(dependencies.saveCommunityDraft).not.toHaveBeenCalled();
    });

    it('requires the Creator post context for moderator routes', async () => {
        const dependencies = deps({ resolveCreatorToolSubredditName: () => null });
        const base = await startApp((app) => registerCommunityMapRoutes(app, dependencies));
        const response = await fetch(`${base}/api/creator/maps`);
        expect(response.status).toBe(400);
        expect(dependencies.assertModeratorForSubreddit).not.toHaveBeenCalled();
    });

    it('returns 404 for an unpublished direct lookup while allowing public list', async () => {
        const dependencies = deps();
        const base = await startApp((app) => registerCommunityMapRoutes(app, dependencies));
        const detail = await fetch(`${base}/api/community/maps/unpublished-id`);
        expect(detail.status).toBe(404);
        expect(dependencies.readPublicCommunityMap).toHaveBeenCalledWith('MiniRacer', 'unpublished-id');
        const list = await fetch(`${base}/api/community/maps`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual({ maps: [], nextCursor: null });
        expect(dependencies.assertModeratorForSubreddit).not.toHaveBeenCalled();
    });

    it('rechecks moderator membership before a status change', async () => {
        const dependencies = deps({
            changeCommunityMapStatus: vi.fn(async () => ({ id: 'one', status: 'unpublished' })),
        });
        const base = await startApp((app) => registerCommunityMapRoutes(app, dependencies));
        const response = await fetch(`${base}/api/creator/maps/one/status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'unpublished' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ map: { id: 'one', status: 'unpublished' } });
        expect(dependencies.assertModeratorForSubreddit).toHaveBeenCalledWith('MiniRacer');
    });

    it('checks moderator membership on the separate Reddit menu action', async () => {
        const ensurePost = vi.fn(async () => ({ created: false, postUrl: 'https://reddit.com/post' }));
        const base = await startApp((app) => registerInternalRoutes(app, {
            resolveMenuTargetSubredditName: async () => 'MiniRacer',
            assertModeratorForSubreddit: vi.fn(async () => {
                throw new Error('Moderator access required for r/MiniRacer.');
            }),
            ensureCommunityCreatorPostForSubreddit: ensurePost,
        }));
        const response = await fetch(`${base}/internal/menu/community-creator-open`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetId: 't5_mini' }),
        });
        expect((await response.json()).navigateTo).toBeUndefined();
        expect(ensurePost).not.toHaveBeenCalled();
    });
});
