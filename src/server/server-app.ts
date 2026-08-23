import express from 'express';
import { createTelemetryRouter } from '@devvit/analytics/server/reddit';
import { isDailyGpChallengePlayable } from './daily-gp-model.js';
import {
    getServerDailyGpChallenge,
    getServerFinalDailyGpPodium,
    getServerDailyGpPlaylist,
    getServerDailyGpSnapshot,
    getServerPlayerPbGhost,
    getServerPlayerTrackPbSummaries,
    getServerPlayerBootstrap,
    recordServerRaceStart,
    selectServerGuestProgress,
    submitServerDailyGpRun,
    updateServerPlayerIdentity,
    updateServerPlayerPreferences,
} from './daily-gp-store.js';
import {
    confirmDailyGpShare,
    previewDailyGpShare,
} from './daily-gp-share.js';
import {
    getRequestRateLimitIdentity,
    getRequestAppSlug,
    getRequestUsername,
    readContextPostId,
    readContextPostData,
    readContextSubredditName,
} from './request-context.js';
import { getPostBoundDailyGpChallenge } from './post-bound-challenge.js';
import {
    enableDailyAutopost,
    ensureDailyMiniRacerPostForSubreddit,
    getDailyGpShareRequestContext,
} from './daily-post-service.js';
import {
    deleteDailyAutopostSubscription,
    readAllDailyAutopostSubscriptions,
} from './daily-autopost-store.js';
import {
    enableDailyPodiumAutopost,
    ensureDailyMiniRacerPodiumPostForSubreddit,
} from './daily-podium-service.js';
import {
    deleteDailyPodiumAutopostSubscription,
    readAllDailyPodiumAutopostSubscriptions,
} from './daily-podium-autopost-store.js';
import { ensureMiniRacerLauncherPostForSubreddit } from './launcher-post-service.js';
import { resolveMenuTargetSubredditName, assertModeratorForSubreddit } from './moderator-access.js';
import {
    getServerAnalyticsSummary,
} from './analytics-store.js';
import {
    ensureModeratorAnalyticsPostForSubreddit,
    resolveAnalyticsToolSubredditName,
} from './moderator-analytics-post.js';
import { registerPlayerRoutes } from './routes/player-routes.js';
import { registerAnalyticsRoutes } from './routes/analytics-routes.js';
import { registerCompetitionRoutes } from './routes/competition-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { registerPbGhostRoutes } from './routes/pb-ghost-routes.js';
import { registerPodiumRoutes } from './routes/podium-routes.js';
import { registerCampaignRoutes } from './routes/campaign-routes.js';
import { registerHeadToHeadRoutes } from './routes/head-to-head-routes.js';
import { registerLeaderboardRaceRoutes } from './routes/leaderboard-race-routes.js';
import {
    getServerCampaignBootstrap,
    getServerCampaignPbGhost,
    getServerCampaignSnapshot,
    startServerCampaignRace,
    submitServerCampaignRun,
} from './campaign-store.js';
import { createHeadToHeadService } from './head-to-head-service.js';
import {
    confirmHeadToHeadBrag,
    previewHeadToHeadBrag,
} from './head-to-head-brag.js';
import {
    readHeadToHeadViewerBest,
    recordHeadToHeadBest,
    resolveHeadToHeadSource,
    validateHeadToHeadReplay,
} from './head-to-head-runtime.js';
import { resolveLegacyDailyGpPodiumAvatars } from './daily-podium-avatar-backfill.js';
import { prepareServerLeaderboardRace } from './leaderboard-race-service.js';

const headToHeadService = createHeadToHeadService({
    resolveSource: resolveHeadToHeadSource,
    validateReplay: validateHeadToHeadReplay,
    recordBest: recordHeadToHeadBest,
    readViewerBest: readHeadToHeadViewerBest,
});

function registerProductionRoutes(app: express.Application): void {
    registerAnalyticsRoutes(app, {
        resolveAnalyticsToolSubredditName,
        assertModeratorForSubreddit,
        getServerAnalyticsSummary: () => getServerAnalyticsSummary(),
        getRequestUsername,
        recordRaceStart: (input) => recordServerRaceStart(input),
    });
    registerPlayerRoutes(app, {
        getRequestUsername,
        getServerPlayerBootstrap: (input) => getServerPlayerBootstrap(input),
        selectServerGuestProgress: (input) => selectServerGuestProgress(input),
        updateServerPlayerIdentity: (input) => updateServerPlayerIdentity(input),
        updateServerPlayerPreferences: (input) => updateServerPlayerPreferences(input),
    });
    registerPbGhostRoutes(app, {
        getRequestUsername,
        getServerPlayerTrackPbSummaries: (input) => getServerPlayerTrackPbSummaries(input),
        getServerPlayerPbGhost: (input) => getServerPlayerPbGhost(input),
    });
    registerPodiumRoutes(app, {
        readContextPostId,
        readContextPostData,
        resolveLegacyDailyGpPodiumAvatars,
    });
    registerCampaignRoutes(app, {
        getRequestUsername,
        getRequestRateLimitIdentity,
        getServerCampaignBootstrap: (input) => getServerCampaignBootstrap(input),
        startServerCampaignRace: (input) => startServerCampaignRace(input),
        getServerCampaignSnapshot: (input) => getServerCampaignSnapshot(input),
        submitServerCampaignRun: (input) => submitServerCampaignRun(input),
        getServerCampaignPbGhost: (input) => getServerCampaignPbGhost(input),
    });
    registerHeadToHeadRoutes(app, {
        getHeadToHeadRequestContext: () => ({
            username: getRequestUsername(),
            subredditName: readContextSubredditName(),
            appSlug: getRequestAppSlug(),
            postId: readContextPostId(),
            postData: readContextPostData(),
            requestRateLimitIdentity: getRequestRateLimitIdentity(),
        }),
        readContextPostData,
        previewHeadToHead: headToHeadService.preview,
        createHeadToHead: headToHeadService.create,
        getHeadToHead: headToHeadService.get,
        submitHeadToHead: headToHeadService.submit,
        previewHeadToHeadBrag,
        confirmHeadToHeadBrag,
    });
    registerLeaderboardRaceRoutes(app, {
        getRequestUsername,
        getRequestRateLimitIdentity,
        prepareServerLeaderboardRace: (input) => prepareServerLeaderboardRace(input),
    });
    registerCompetitionRoutes(app, {
        getRequestUsername,
        getRequestRateLimitIdentity,
        getPostBoundDailyGpChallenge,
        getServerDailyGpChallenge,
        getServerDailyGpPlaylist,
        getServerDailyGpSnapshot: (input) => getServerDailyGpSnapshot(input),
        submitServerDailyGpRun: (input) => submitServerDailyGpRun(input),
        isDailyGpChallengePlayable,
    });
    registerShareRoutes(app, {
        getDailyGpShareRequestContext,
        previewDailyGpShare: (input, requestContext) => (
            previewDailyGpShare(input, requestContext)
        ),
        confirmDailyGpShare: (input, requestContext) => (
            confirmDailyGpShare(input, requestContext)
        ),
    });
    registerInternalRoutes(app, {
        resolveMenuTargetSubredditName,
        getServerDailyGpChallenge,
        getServerFinalDailyGpPodium,
        ensureDailyMiniRacerPostForSubreddit,
        ensureMiniRacerLauncherPostForSubreddit,
        enableDailyAutopost,
        deleteDailyAutopostSubscription,
        ensureDailyMiniRacerPodiumPostForSubreddit,
        enableDailyPodiumAutopost,
        deleteDailyPodiumAutopostSubscription,
        readAllDailyAutopostSubscriptions,
        readAllDailyPodiumAutopostSubscriptions,
        ensureModeratorAnalyticsPostForSubreddit,
    });
}

export function createServerApp({
    registerRoutes = registerProductionRoutes,
}: {
    registerRoutes?: (app: express.Application) => void;
} = {}) {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use(createTelemetryRouter());
    registerRoutes(app);
    return app;
}
