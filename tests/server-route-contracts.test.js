import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerApp } from '../src/server/server-app.ts';
import { registerPlayerRoutes } from '../src/server/routes/player-routes.ts';
import { registerCompetitionRoutes } from '../src/server/routes/competition-routes.ts';
import { registerShareRoutes } from '../src/server/routes/share-routes.ts';
import { registerInternalRoutes } from '../src/server/routes/internal-routes.ts';
import { registerPbGhostRoutes } from '../src/server/routes/pb-ghost-routes.ts';

const openServers = new Set();

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...openServers].map((server) => new Promise((resolve) => {
        server.close(resolve);
    })));
    openServers.clear();
});

async function startApp(registerRoutes) {
    const app = createServerApp({ registerRoutes });
    expect(app.listening).toBeUndefined();

    const server = app.listen(0, '127.0.0.1');
    openServers.add(server);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

async function readJson(response) {
    return response.json();
}

describe('server route contracts', () => {
    it('mounts the official Devvit Journeys telemetry router', async () => {
        const baseUrl = await startApp(() => {});
        const response = await fetch(`${baseUrl}/api/telemetry/journey/progress`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ progress: 0.5, action: 'checkpoint' }),
        });

        expect(response.status).toBe(400);
        expect(await readJson(response)).toEqual({
            error: 'journeyId is required.',
            receipt: {
                status: 'JOURNEY_RECEIPT_INVALID',
                message: 'Invalid: Event payload was not recorded.',
            },
        });
    });

    it('authorizes and forwards PB ghost summary and full-trace lookups', async () => {
        const getServerPlayerTrackPbSummaries = vi.fn(async () => ({
            playerId: 'guest:guest-1',
            trackPbs: {
                'daily-gp-2026-07-16': {
                    trackKey: 'circuit',
                    bestTimeMs: 12345,
                    checkpointTimesSec: [4.2, 9.8],
                    ghostAvailable: true,
                },
            },
        }));
        const getServerPlayerPbGhost = vi.fn(async () => ({
            playerId: 'guest:guest-1',
            challengeId: 'daily-gp-2026-07-16',
            trackKey: 'circuit',
            personalBest: {
                bestTimeMs: 12345,
                checkpointTimesSec: [4.2, 9.8],
                updatedAt: '2026-07-16T12:00:00.000Z',
                ghost: {
                    schemaVersion: 2,
                    sampleIntervalMs: 50,
                    finishTimeMs: 50,
                    origin: [0, 0, 0],
                    deltas: [100, 100, 100],
                },
            },
        }));
        const baseUrl = await startApp((app) => registerPbGhostRoutes(app, {
            getRequestUsername: () => null,
            getServerPlayerTrackPbSummaries,
            getServerPlayerPbGhost,
        }));

        const summaries = await fetch(
            `${baseUrl}/api/player/track-pbs?challengeIds=daily-gp-2026-07-16,daily-gp-2026-07-15&playerId=guest-1&guestToken=signed`,
        );
        expect(summaries.status).toBe(200);
        expect(await readJson(summaries)).toEqual({
            trackPbs: {
                'daily-gp-2026-07-16': {
                    trackKey: 'circuit',
                    bestTimeMs: 12345,
                    checkpointTimesSec: [4.2, 9.8],
                    ghostAvailable: true,
                },
            },
        });
        expect(getServerPlayerTrackPbSummaries).toHaveBeenCalledWith({
            challengeIds: ['daily-gp-2026-07-16', 'daily-gp-2026-07-15'],
            playerId: 'guest-1',
            guestToken: 'signed',
            redditUsername: null,
        });

        const fullGhost = await fetch(
            `${baseUrl}/api/player/pb-ghost?challengeId=daily-gp-2026-07-16&playerId=guest-1&guestToken=signed`,
        );
        expect(fullGhost.status).toBe(200);
        expect(await readJson(fullGhost)).toMatchObject({
            challengeId: 'daily-gp-2026-07-16',
            trackKey: 'circuit',
            personalBest: {
                bestTimeMs: 12345,
                ghost: { sampleIntervalMs: 50 },
            },
        });
    });

    it('rejects unauthorized PB ghost access and unavailable challenges', async () => {
        const getServerPlayerPbGhost = vi.fn()
            .mockResolvedValueOnce({
                playerId: null,
                challengeId: null,
                trackKey: null,
                personalBest: null,
            })
            .mockResolvedValueOnce({
                playerId: 'guest:guest-1',
                challengeId: null,
                trackKey: null,
                personalBest: null,
            });
        const baseUrl = await startApp((app) => registerPbGhostRoutes(app, {
            getRequestUsername: () => null,
            getServerPlayerTrackPbSummaries: vi.fn(async () => ({
                playerId: null,
                trackPbs: {},
            })),
            getServerPlayerPbGhost,
        }));

        const unauthorized = await fetch(
            `${baseUrl}/api/player/pb-ghost?challengeId=missing&playerId=guest-1&guestToken=invalid`,
        );
        expect(unauthorized.status).toBe(401);

        const unavailable = await fetch(
            `${baseUrl}/api/player/pb-ghost?challengeId=missing&playerId=guest-1&guestToken=signed`,
        );
        expect(unavailable.status).toBe(404);
        expect(await readJson(unavailable)).toEqual({
            error: 'Daily challenge is not playable.',
        });
    });

    it('preserves player authorization status distinctions', async () => {
        const getServerPlayerBootstrap = vi.fn(async () => ({ playerId: null }));
        const baseUrl = await startApp((app) => registerPlayerRoutes(app, {
            getRequestUsername: () => null,
            getServerPlayerBootstrap,
            updateServerPlayerIdentity: vi.fn(),
            updateServerPlayerPreferences: vi.fn(),
        }));

        const malformed = await fetch(`${baseUrl}/api/player/bootstrap`);
        expect(malformed.status).toBe(400);
        expect(await readJson(malformed)).toEqual({ error: 'Invalid player identity.' });

        const unauthorized = await fetch(
            `${baseUrl}/api/player/bootstrap?playerId=guest-1&guestToken=invalid`,
        );
        expect(unauthorized.status).toBe(401);
        expect(await readJson(unauthorized)).toEqual({
            error: 'Guest token is required for this player.',
        });
        expect(getServerPlayerBootstrap).toHaveBeenLastCalledWith({
            playerId: 'guest-1',
            guestToken: 'invalid',
            redditUsername: null,
        });
    });

    it('returns a retryable progress-selection response for temporary transfer contention', async () => {
        const retryable = new Error('Campaign discard is temporarily busy.');
        retryable.statusCode = 503;
        retryable.reason = 'progress_selection_retryable';
        const selectServerGuestProgress = vi.fn(async () => {
            throw retryable;
        });
        const baseUrl = await startApp((app) => registerPlayerRoutes(app, {
            getRequestUsername: () => 'RaceFan',
            getServerPlayerBootstrap: vi.fn(),
            selectServerGuestProgress,
            updateServerPlayerIdentity: vi.fn(),
            updateServerPlayerPreferences: vi.fn(),
        }));

        const response = await fetch(`${baseUrl}/api/player/progress-selection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerId: 'guest-1',
                guestToken: 'signed-token',
                choice: 'account',
            }),
        });

        expect(response.status).toBe(503);
        expect(await readJson(response)).toEqual({
            error: 'Your save is busy. Wait a moment, then try again.',
            reason: 'progress_selection_retryable',
        });
    });

    it('tells the client to continue a transfer that works in pieces, and names it', async () => {
        const { GuestProgressSelectionContinueError } = await import(
            '../src/server/guest-transfer/guest-progress-selection-error.ts'
        );
        const selectServerGuestProgress = vi.fn(async () => {
            throw new GuestProgressSelectionContinueError('guest-transfer:abc');
        });
        const baseUrl = await startApp((app) => registerPlayerRoutes(app, {
            getRequestUsername: () => 'RaceFan',
            getServerPlayerBootstrap: vi.fn(),
            selectServerGuestProgress,
            updateServerPlayerIdentity: vi.fn(),
            updateServerPlayerPreferences: vi.fn(),
        }));

        const response = await fetch(`${baseUrl}/api/player/progress-selection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'resume', transferId: 'guest-transfer:abc' }),
        });

        expect(response.status).toBe(503);
        expect(await readJson(response)).toEqual({
            error: 'Moving your progress. Continuing…',
            reason: 'progress_selection_continue',
            transferId: 'guest-transfer:abc',
        });
    });

    it('preserves player mutation forwarding, success, and invalid-preference responses', async () => {
        const updateServerPlayerIdentity = vi.fn(async () => ({
            playerId: 'guest:guest-1',
            leaderboardIdentity: 'reddit',
        }));
        const updateServerPlayerPreferences = vi.fn()
            .mockResolvedValueOnce({
                playerId: 'guest:guest-1',
                playerPreferences: null,
            })
            .mockResolvedValueOnce({
                playerId: 'guest:guest-1',
                playerPreferences: { musicEnabled: true },
            });
        const baseUrl = await startApp((app) => registerPlayerRoutes(app, {
            getRequestUsername: () => 'RaceFan',
            getServerPlayerBootstrap: vi.fn(),
            updateServerPlayerIdentity,
            updateServerPlayerPreferences,
        }));

        const identity = await fetch(`${baseUrl}/api/player/identity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerId: 'guest-1',
                guestToken: 'signed-token',
                leaderboardIdentity: 'reddit',
            }),
        });
        expect(identity.status).toBe(200);
        expect(await readJson(identity)).toEqual({
            playerId: 'guest:guest-1',
            leaderboardIdentity: 'reddit',
        });
        expect(updateServerPlayerIdentity).toHaveBeenCalledWith({
            playerId: 'guest-1',
            guestToken: 'signed-token',
            leaderboardIdentity: 'reddit',
            redditUsername: 'RaceFan',
        });

        const invalidPreferences = await fetch(`${baseUrl}/api/player/preferences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerId: 'guest-1',
                guestToken: 'signed-token',
                playerPreferences: { musicEnabled: 'yes' },
            }),
        });
        expect(invalidPreferences.status).toBe(400);
        expect(await readJson(invalidPreferences)).toEqual({
            error: 'Invalid player preferences',
        });

        const validPreferences = await fetch(`${baseUrl}/api/player/preferences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerId: 'guest-1',
                guestToken: 'signed-token',
                playerPreferences: { musicEnabled: true },
            }),
        });
        expect(validPreferences.status).toBe(200);
        expect(await readJson(validPreferences)).toEqual({
            playerId: 'guest:guest-1',
            playerPreferences: { musicEnabled: true },
        });
    });

    it('preserves competition fallback and submission forwarding', async () => {
        const activeChallenge = {
            id: 'daily-gp-2026-07-16',
            challengeDate: '2026-07-16',
            trackKey: 'circuit',
            startsAt: '2026-07-16T00:00:00.000Z',
            endsAt: '2026-07-17T00:00:00.000Z',
            availableUntil: '2026-07-23T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const submitServerDailyGpRun = vi.fn(async (input) => ({
            status: 422,
            body: { accepted: false, reason: input.trackKey },
        }));
        const baseUrl = await startApp((app) => registerCompetitionRoutes(app, {
            getRequestUsername: () => 'pm-user',
            getRequestRateLimitIdentity: () => 'request-id',
            getPostBoundDailyGpChallenge: vi.fn(async () => null),
            getServerDailyGpChallenge: vi.fn(async () => activeChallenge),
            getServerDailyGpPlaylist: vi.fn(async () => []),
            getServerDailyGpSnapshot: vi.fn(),
            submitServerDailyGpRun,
            isDailyGpChallengePlayable: () => true,
        }));

        const unknown = await fetch(`${baseUrl}/api/scoreboard/snapshot?trackKey=missing`);
        expect(unknown.status).toBe(200);
        expect(await readJson(unknown)).toMatchObject({
            topRows: [],
            totalCount: 0,
            objectiveType: 'single_lap_fastest',
            pageOffset: 0,
            pageLimit: 0,
        });

        const submitted = await fetch(`${baseUrl}/api/daily/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackKey: 'circuit' }),
        });
        expect(submitted.status).toBe(422);
        expect(await readJson(submitted)).toEqual({
            accepted: false,
            reason: 'circuit',
        });
        expect(submitServerDailyGpRun).toHaveBeenCalledWith({
            trackKey: 'circuit',
            redditUsername: 'pm-user',
            requestRateLimitIdentity: 'request-id',
        });
        expect(submitServerDailyGpRun.mock.calls[0]).toHaveLength(1);
    });

    it('preserves active, playlist, and paginated snapshot contracts', async () => {
        const activeChallenge = {
            id: 'daily-gp-2026-07-16',
            challengeDate: '2026-07-16',
            trackKey: 'circuit',
            startsAt: '2026-07-16T00:00:00.000Z',
            endsAt: '2026-07-17T00:00:00.000Z',
            availableUntil: '2026-07-23T00:00:00.000Z',
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const postChallenge = {
            ...activeChallenge,
            id: 'daily-gp-2026-07-15',
            challengeDate: '2026-07-15',
        };
        const getServerDailyGpSnapshot = vi.fn(async (input) => ({
            challengeId: input.challengeId,
            pageOffset: input.offset,
            pageLimit: input.limit,
        }));
        const baseUrl = await startApp((app) => registerCompetitionRoutes(app, {
            getRequestUsername: () => 'RaceFan',
            getRequestRateLimitIdentity: () => 'request-id',
            getPostBoundDailyGpChallenge: vi.fn(async () => postChallenge),
            getServerDailyGpChallenge: vi.fn(async () => activeChallenge),
            getServerDailyGpPlaylist: vi.fn(async () => [activeChallenge, postChallenge]),
            getServerDailyGpSnapshot,
            submitServerDailyGpRun: vi.fn(),
            isDailyGpChallengePlayable: () => true,
        }));

        const active = await fetch(`${baseUrl}/api/daily/active`);
        expect(await readJson(active)).toEqual(postChallenge);

        const playlist = await fetch(`${baseUrl}/api/daily/playlist`);
        expect(await readJson(playlist)).toEqual({
            challenges: [activeChallenge, postChallenge],
        });

        const dailySnapshot = await fetch(
            `${baseUrl}/api/daily/snapshot?challengeId=${postChallenge.id}&playerId=guest-1&guestToken=signed&limit=50&offset=100`,
        );
        expect(await readJson(dailySnapshot)).toEqual({
            challengeId: postChallenge.id,
            pageOffset: 100,
            pageLimit: 50,
        });
        expect(getServerDailyGpSnapshot).toHaveBeenCalledWith({
            challengeId: postChallenge.id,
            playerId: 'guest-1',
            guestToken: 'signed',
            redditUsername: 'RaceFan',
            limit: 50,
            offset: 100,
        });

        const scoreboardSnapshot = await fetch(
            `${baseUrl}/api/scoreboard/snapshot?trackKey=circuit&limit=25&offset=75`,
        );
        expect(await readJson(scoreboardSnapshot)).toEqual({
            challengeId: activeChallenge.id,
            pageOffset: 75,
            pageLimit: 25,
        });
        expect(getServerDailyGpSnapshot).toHaveBeenLastCalledWith({
            challengeId: activeChallenge.id,
            loadedChallenge: activeChallenge,
            playerId: undefined,
            guestToken: undefined,
            redditUsername: 'RaceFan',
            limit: 25,
            offset: 75,
        });
    });

    it('preserves share service statuses and request context', async () => {
        const previewDailyGpShare = vi.fn(async () => ({
            status: 409,
            body: { status: 'not_shareable' },
        }));
        const baseUrl = await startApp((app) => registerShareRoutes(app, {
            getDailyGpShareRequestContext: async () => ({
                username: 'pm-user',
                subredditName: 'mini_racer_dev',
            }),
            previewDailyGpShare,
            confirmDailyGpShare: vi.fn(),
        }));

        const response = await fetch(`${baseUrl}/api/daily/share/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: 'daily-gp-2026-07-16' }),
        });
        expect(response.status).toBe(409);
        expect(await readJson(response)).toEqual({ status: 'not_shareable' });
        expect(previewDailyGpShare).toHaveBeenCalledWith(
            { challengeId: 'daily-gp-2026-07-16' },
            { username: 'pm-user', subredditName: 'mini_racer_dev' },
        );
    });

    it('preserves share confirmation and failure response shapes', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const confirmDailyGpShare = vi.fn(async () => ({
            status: 200,
            body: { status: 'shared', commentUrl: 'https://reddit.com/comment' },
        }));
        const previewDailyGpShare = vi.fn(async () => {
            throw new Error('preview failed');
        });
        const baseUrl = await startApp((app) => registerShareRoutes(app, {
            getDailyGpShareRequestContext: async () => ({
                username: 'RaceFan',
                subredditName: 'MiniRacer',
                appSlug: 'mini-racer',
            }),
            previewDailyGpShare,
            confirmDailyGpShare,
        }));

        const confirmed = await fetch(`${baseUrl}/api/daily/share/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shareToken: 'token' }),
        });
        expect(confirmed.status).toBe(200);
        expect(await readJson(confirmed)).toEqual({
            status: 'shared',
            commentUrl: 'https://reddit.com/comment',
        });

        const failed = await fetch(`${baseUrl}/api/daily/share/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(failed.status).toBe(500);
        expect(await readJson(failed)).toEqual({
            status: 'share_failed',
            error: 'Could not prepare this result for sharing.',
        });
    });

    it('preserves menu fallbacks and scheduler isolation', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const ensureDailyMiniRacerPostForSubreddit = vi.fn(async (subredditName) => {
            if (subredditName === 'broken') {
                throw new Error('post failed');
            }
            return { created: subredditName === 'created', postUrl: null };
        });
        const baseUrl = await startApp((app) => registerInternalRoutes(app, {
            resolveMenuTargetSubredditName: async () => null,
            getServerDailyGpChallenge: async () => ({ id: 'daily-gp-2026-07-16' }),
            ensureDailyMiniRacerPostForSubreddit,
            enableDailyAutopost: vi.fn(),
            deleteDailyAutopostSubscription: vi.fn(),
            readAllDailyAutopostSubscriptions: async () => [
                { subredditName: 'disabled', enabled: false },
                { subredditName: 'broken', enabled: true },
                { subredditName: 'created', enabled: true },
            ],
        }));

        const menu = await fetch(`${baseUrl}/internal/menu/post-create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetId: '' }),
        });
        expect(await readJson(menu)).toEqual({
            showToast: {
                text: 'Reddit did not provide a subreddit context for this install.',
                appearance: 'neutral',
            },
        });

        const scheduler = await fetch(`${baseUrl}/internal/scheduler/daily-posts`, {
            method: 'POST',
        });
        expect(scheduler.status).toBe(200);
        expect(await readJson(scheduler)).toEqual({
            ok: true,
            challengeId: 'daily-gp-2026-07-16',
            createdCount: 1,
        });
        expect(ensureDailyMiniRacerPostForSubreddit).toHaveBeenCalledTimes(2);
    });

    it('runs the raced list fill from its scheduler task and reports a failed run', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const runRacedListFill = vi.fn()
            .mockResolvedValueOnce({ status: 'working', rows: 1000 })
            .mockRejectedValueOnce(new Error('storage unavailable'));
        const baseUrl = await startApp((app) => registerInternalRoutes(app, { runRacedListFill }));

        const working = await fetch(`${baseUrl}/internal/scheduler/raced-list-fill`, { method: 'POST' });
        expect(working.status).toBe(200);
        expect(await readJson(working)).toEqual({ ok: true, status: 'working', rows: 1000 });

        const failed = await fetch(`${baseUrl}/internal/scheduler/raced-list-fill`, { method: 'POST' });
        expect(failed.status).toBe(500);
        expect(await readJson(failed)).toEqual({ ok: false, error: 'Scheduled raced list fill run failed' });
    });

    it('runs the Daily ghost archive from its scheduler task and reports a failed run', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const report = { status: 'worked', moved: 3, restored: 0, held: 1, failed: 0, passesEnded: 1 };
        const runDailyGhostArchive = vi.fn()
            .mockResolvedValueOnce(report)
            .mockRejectedValueOnce(new Error('blob storage unavailable'));
        const baseUrl = await startApp((app) => registerInternalRoutes(app, { runDailyGhostArchive }));

        const worked = await fetch(`${baseUrl}/internal/scheduler/daily-ghost-archive`, { method: 'POST' });
        expect(worked.status).toBe(200);
        expect(await readJson(worked)).toEqual({ ok: true, ...report });

        const failed = await fetch(`${baseUrl}/internal/scheduler/daily-ghost-archive`, { method: 'POST' });
        expect(failed.status).toBe(500);
        expect(await readJson(failed)).toEqual({ ok: false, error: 'Scheduled Daily ghost archive run failed' });
    });

    it('preserves daily-post moderator menu success responses and side effects', async () => {
        const enableDailyAutopost = vi.fn();
        const deleteDailyAutopostSubscription = vi.fn();
        const ensureDailyMiniRacerPostForSubreddit = vi.fn()
            .mockResolvedValueOnce({
                created: false,
                postUrl: 'https://reddit.com/existing',
            })
            .mockResolvedValueOnce({
                created: true,
                postUrl: 'https://reddit.com/today',
            });
        const baseUrl = await startApp((app) => registerInternalRoutes(app, {
            resolveMenuTargetSubredditName: async () => 'MiniRacer',
            getServerDailyGpChallenge: async () => ({ id: 'daily-gp-2026-07-16' }),
            ensureDailyMiniRacerPostForSubreddit,
            enableDailyAutopost,
            deleteDailyAutopostSubscription,
            readAllDailyAutopostSubscriptions: async () => [],
        }));
        const request = (path) => fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetId: 't5_mini' }),
        });

        const created = await request('/internal/menu/post-create');
        expect(await readJson(created)).toEqual({
            navigateTo: 'https://reddit.com/existing',
        });

        const enabled = await request('/internal/menu/post-enable-daily');
        expect(await readJson(enabled)).toEqual({
            showToast: {
                text: 'Daily Mini Racer posts enabled for r/MiniRacer. Today\'s post is live.',
                appearance: 'success',
            },
            navigateTo: 'https://reddit.com/today',
        });
        expect(enableDailyAutopost).toHaveBeenCalledWith('MiniRacer');

        const disabled = await request('/internal/menu/post-disable-daily');
        expect(await readJson(disabled)).toEqual({
            showToast: {
                text: 'Daily Mini Racer posts disabled for r/MiniRacer.',
                appearance: 'success',
            },
        });
        expect(deleteDailyAutopostSubscription).toHaveBeenCalledWith('MiniRacer');

    });

    it('supports independent podium automation menus and isolates scheduled subreddit failures', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-17T00:01:00.000Z'));
        const podium = {
            challengeId: 'daily-gp-2026-07-10',
            challengeDate: '2026-07-10',
            trackKey: 'circuit',
            trackName: 'Classic Circuit',
            positions: [
                { rank: 1, displayName: 'RaceFan', identityType: 'reddit', formattedTime: '0:12.34' },
                { rank: 2, displayName: 'Turbo Otter 42', identityType: 'private', formattedTime: '0:13.56' },
                { rank: 3, displayName: 'No verified finish', identityType: 'empty', formattedTime: null },
            ],
        };
        const enableDailyPodiumAutopost = vi.fn();
        const deleteDailyPodiumAutopostSubscription = vi.fn();
        const ensureDailyMiniRacerPodiumPostForSubreddit = vi.fn(async (subredditName) => {
            if (subredditName === 'broken') throw new Error('podium failed');
            return {
                created: subredditName === 'MiniRacer' || subredditName === 'created',
                postUrl: subredditName === 'MiniRacer' ? 'https://reddit.com/podium' : null,
            };
        });
        const baseUrl = await startApp((app) => registerInternalRoutes(app, {
            resolveMenuTargetSubredditName: async () => 'MiniRacer',
            getServerDailyGpChallenge: vi.fn(),
            getServerFinalDailyGpPodium: async () => podium,
            ensureDailyMiniRacerPostForSubreddit: vi.fn(),
            enableDailyAutopost: vi.fn(),
            deleteDailyAutopostSubscription: vi.fn(),
            ensureDailyMiniRacerPodiumPostForSubreddit,
            enableDailyPodiumAutopost,
            deleteDailyPodiumAutopostSubscription,
            readAllDailyAutopostSubscriptions: async () => [],
            readAllDailyPodiumAutopostSubscriptions: async () => [
                { subredditName: 'disabled', enabled: false },
                { subredditName: 'broken', enabled: true },
                { subredditName: 'created', enabled: true },
            ],
        }));
        const request = (path) => fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetId: 't5_mini' }),
        });

        const enabled = await request('/internal/menu/podium-enable-daily');
        expect(await readJson(enabled)).toEqual({
            showToast: {
                text: 'Daily Mini Racer podium posts enabled for r/MiniRacer. The latest podium is live.',
                appearance: 'success',
            },
            navigateTo: 'https://reddit.com/podium',
        });
        expect(enableDailyPodiumAutopost).toHaveBeenCalledWith('MiniRacer');

        const disabled = await request('/internal/menu/podium-disable-daily');
        expect(await readJson(disabled)).toEqual({
            showToast: {
                text: 'Daily Mini Racer podium posts disabled for r/MiniRacer.',
                appearance: 'success',
            },
        });
        expect(deleteDailyPodiumAutopostSubscription).toHaveBeenCalledWith('MiniRacer');

        const scheduled = await request('/internal/scheduler/daily-podium-posts');
        expect(scheduled.status).toBe(200);
        expect(await readJson(scheduled)).toEqual({
            ok: true,
            challengeId: podium.challengeId,
            createdCount: 1,
        });
        expect(ensureDailyMiniRacerPodiumPostForSubreddit).toHaveBeenCalledTimes(3);
        expect(ensureDailyMiniRacerPodiumPostForSubreddit).not.toHaveBeenCalledWith(
            'disabled',
            expect.anything(),
        );
    });

    it('preserves menu error toasts and scheduler-level failures', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const baseUrl = await startApp((app) => registerInternalRoutes(app, {
            resolveMenuTargetSubredditName: async () => 'MiniRacer',
            getServerDailyGpChallenge: vi.fn()
                .mockRejectedValueOnce(new Error('create failed'))
                .mockRejectedValueOnce(new Error('scheduler failed')),
            ensureDailyMiniRacerPostForSubreddit: vi.fn(),
            enableDailyAutopost: vi.fn(),
            deleteDailyAutopostSubscription: vi.fn(),
            readAllDailyAutopostSubscriptions: async () => [],
        }));

        const menu = await fetch(`${baseUrl}/internal/menu/post-create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(await readJson(menu)).toEqual({
            showToast: {
                text: 'Could not create the Mini Racer post: create failed',
                appearance: 'neutral',
            },
        });

        const scheduler = await fetch(`${baseUrl}/internal/scheduler/daily-posts`, {
            method: 'POST',
        });
        expect(scheduler.status).toBe(500);
        expect(await readJson(scheduler)).toEqual({
            ok: false,
            error: 'Scheduled daily post run failed',
        });
    });
});
