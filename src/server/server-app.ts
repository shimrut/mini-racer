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
import { ensureMiniRacerLauncherPostForSubreddit } from './launcher-post-service.js';
import { resolveMenuTargetSubredditName } from './moderator-access.js';
import { registerPlayerRoutes } from './routes/player-routes.js';
import { registerCompetitionRoutes } from './routes/competition-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { registerPbGhostRoutes } from './routes/pb-ghost-routes.js';
import { registerPodiumRoutes } from './routes/podium-routes.js';
import { registerCampaignRoutes } from './routes/campaign-routes.js';
import { registerCampaignChallengeRoutes } from './routes/campaign-challenge-routes.js';
import { registerLeaderboardRaceRoutes } from './routes/leaderboard-race-routes.js';
import {
    getServerCampaignBootstrap,
    getServerCampaignPbGhost,
    getServerCampaignSnapshot,
    startServerCampaignRace,
    submitServerCampaignRun,
} from './campaign-store.js';
import { createCampaignChallengeService } from './campaign-challenge-service.js';
import {
    confirmCampaignChallengeBrag,
    previewCampaignChallengeBrag,
} from './campaign-challenge-brag.js';
import {
    resolveCampaignChallengeSource,
    validateCampaignChallengeReplay,
} from './campaign-challenge-runtime.js';
import { resolveLegacyDailyGpPodiumAvatars } from './daily-podium-avatar-backfill.js';
import { prepareServerLeaderboardRace } from './leaderboard-race-service.js';

const campaignChallengeService = createCampaignChallengeService({
    resolveSource: resolveCampaignChallengeSource,
    validateReplay: validateCampaignChallengeReplay,
});

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
    registerCampaignChallengeRoutes(app, {
        getCampaignChallengeRequestContext: () => ({
            username: getRequestUsername(),
            subredditName: readContextSubredditName(),
            appSlug: getRequestAppSlug(),
            postId: readContextPostId(),
            postData: readContextPostData(),
        }),
        readContextPostData,
        previewCampaignChallenge: campaignChallengeService.preview,
        createCampaignChallenge: campaignChallengeService.create,
        getCampaignChallenge: campaignChallengeService.get,
        submitCampaignChallenge: campaignChallengeService.submit,
        previewCampaignChallengeBrag,
        confirmCampaignChallengeBrag,
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
