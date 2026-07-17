import express from 'express';
import { isDailyGpChallengePlayable } from './daily-gp-model.js';
import {
    getServerDailyGpChallenge,
    getServerFinalDailyGpPodium,
    getServerDailyGpPlaylist,
    getServerDailyGpSnapshot,
    getServerPlayerPbGhost,
    getServerPlayerTrackPbSummaries,
    getServerPlayerBootstrap,
    submitServerDailyGpRun,
    updateServerPlayerIdentity,
    updateServerPlayerPreferences,
} from './daily-gp-store.js';
import {
    confirmDailyGpShare,
    previewDailyGpShare,
} from './daily-gp-share.js';
import {
    getServerAnalyticsSummary,
    submitServerAnalyticsEvent,
} from './analytics-store.js';
import {
    getRequestRateLimitIdentity,
    getRequestUsername,
    readContextPostId,
    readContextSubredditName,
} from './request-context.js';
import { getPostBoundDailyGpChallenge } from './post-bound-challenge.js';
import { getCommunityMemberTotalForLeaderboard } from './community-context.js';
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
import {
    assertModeratorForSubreddit,
    resolveMenuTargetSubredditName,
} from './moderator-access.js';
import {
    ensureModeratorAnalyticsPostForSubreddit,
    resolveAnalyticsToolSubredditName,
} from './moderator-analytics-post.js';
import { registerPlayerRoutes } from './routes/player-routes.js';
import { registerCompetitionRoutes } from './routes/competition-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerAnalyticsRoutes } from './routes/analytics-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { registerPbGhostRoutes } from './routes/pb-ghost-routes.js';

function registerProductionRoutes(app: express.Application): void {
    registerPlayerRoutes(app, {
        getRequestUsername,
        getServerPlayerBootstrap: (input) => getServerPlayerBootstrap(input),
        updateServerPlayerIdentity: (input) => updateServerPlayerIdentity(input),
        updateServerPlayerPreferences: (input) => updateServerPlayerPreferences(input),
    });
    registerPbGhostRoutes(app, {
        getRequestUsername,
        getServerPlayerTrackPbSummaries: (input) => getServerPlayerTrackPbSummaries(input),
        getServerPlayerPbGhost: (input) => getServerPlayerPbGhost(input),
    });
    registerCompetitionRoutes(app, {
        getRequestUsername,
        getRequestRateLimitIdentity,
        getPostBoundDailyGpChallenge,
        getCommunityMemberTotalForLeaderboard,
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
    registerAnalyticsRoutes(app, {
        getRequestUsername,
        readContextPostId,
        readContextSubredditName,
        resolveAnalyticsToolSubredditName,
        assertModeratorForSubreddit,
        submitServerAnalyticsEvent: (input) => submitServerAnalyticsEvent(input),
        getServerAnalyticsSummary: (input) => getServerAnalyticsSummary(input),
    });
    registerInternalRoutes(app, {
        resolveMenuTargetSubredditName,
        getServerDailyGpChallenge,
        getServerFinalDailyGpPodium,
        ensureDailyMiniRacerPostForSubreddit,
        enableDailyAutopost,
        deleteDailyAutopostSubscription,
        ensureDailyMiniRacerPodiumPostForSubreddit,
        enableDailyPodiumAutopost,
        deleteDailyPodiumAutopostSubscription,
        assertModeratorForSubreddit,
        ensureModeratorAnalyticsPostForSubreddit,
        readAllDailyAutopostSubscriptions,
        readAllDailyPodiumAutopostSubscriptions,
    });
}

export function createServerApp({
    registerRoutes = registerProductionRoutes,
}: {
    registerRoutes?: (app: express.Application) => void;
} = {}) {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerRoutes(app);
    return app;
}
