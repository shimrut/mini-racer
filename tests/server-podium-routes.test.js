import express from 'express';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPodiumRoutes } from '../src/server/routes/podium-routes.ts';

const servers = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(dependencies) {
    const app = express();
    registerPodiumRoutes(app, dependencies);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
}

describe('podium avatar compatibility route', () => {
    it('backfills only a daily podium bound to the current post context', async () => {
        const resolveLegacyDailyGpPodiumAvatars = vi.fn(async () => ([
            { rank: 1, avatarUrl: 'https://styles.redditmedia.com/shimroot.png' },
        ]));
        const podium = { positions: [{ rank: 1, identityType: 'reddit', displayName: 'shimroot' }] };
        const baseUrl = await start({
            readContextPostId: () => 't3_podium',
            readContextPostData: () => ({ postType: 'daily-podium', podium }),
            resolveLegacyDailyGpPodiumAvatars,
            resolveDailyPodiumReplay: vi.fn(),
        });

        const response = await fetch(`${baseUrl}/api/podium/avatars`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            positions: [{ rank: 1, avatarUrl: 'https://styles.redditmedia.com/shimroot.png' }],
        });
        expect(resolveLegacyDailyGpPodiumAvatars).toHaveBeenCalledWith('t3_podium', podium);
    });

    it('does not resolve avatars outside a daily podium context', async () => {
        const resolveLegacyDailyGpPodiumAvatars = vi.fn();
        const baseUrl = await start({
            readContextPostId: () => 't3_race',
            readContextPostData: () => ({ postType: 'daily-race' }),
            resolveLegacyDailyGpPodiumAvatars,
            resolveDailyPodiumReplay: vi.fn(),
        });

        const response = await fetch(`${baseUrl}/api/podium/avatars`);
        expect(response.status).toBe(404);
        expect(resolveLegacyDailyGpPodiumAvatars).not.toHaveBeenCalled();
    });

    it('returns frozen podium ghosts without player ids', async () => {
        const resolveDailyPodiumReplay = vi.fn(async () => ({
            trackKey: 'circuit',
            ghosts: [
                { rank: 1, ghost: { schemaVersion: 2 } },
                { rank: 2, ghost: null },
                { rank: 3, ghost: null },
            ],
        }));
        const postData = { postType: 'daily-podium', challengeId: 'daily-gp-2026-08-21', replayDataHash: 'abc' };
        const baseUrl = await start({
            readContextPostId: () => 't3_podium',
            readContextPostData: () => postData,
            resolveLegacyDailyGpPodiumAvatars: vi.fn(),
            resolveDailyPodiumReplay,
        });

        const response = await fetch(`${baseUrl}/api/podium/replays`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            trackKey: 'circuit',
            ghosts: [
                { rank: 1, ghost: { schemaVersion: 2 } },
                { rank: 2, ghost: null },
                { rank: 3, ghost: null },
            ],
        });
        expect(JSON.stringify(await resolveDailyPodiumReplay.mock.results[0].value)).not.toContain('playerId');
        expect(resolveDailyPodiumReplay).toHaveBeenCalledWith('t3_podium', postData);
    });
});
