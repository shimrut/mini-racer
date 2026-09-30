import express from 'express';
import { runRacedListFill } from './player/raced-list-fill.js';
import { createTelemetryRouter } from '@devvit/analytics/server/reddit';
import { isDailyGpChallengePlayable } from './daily/daily-gp-model.js';
import {
    getServerDailyGpChallenge,
    getServerFinalDailyGpPodium,
    getServerDailyGpPlaylist,
    getServerDailyGpSnapshot,
    getGuestProgressTransferDiagnostic,
    recordServerRaceStart,
    submitServerDailyGpRun,
} from './daily/daily-gp-store.js';
import {
    getServerPlayerPbGhost,
    getServerPlayerTrackPbSummaries,
    getServerPlayerBootstrap,
    selectServerGuestProgress,
    updateServerPlayerIdentity,
    updateServerPlayerPreferences,
} from './player/player-account-store.js';
import {
    confirmDailyGpShare,
    previewDailyGpShare,
} from './daily/daily-gp-share.js';
import {
    getRequestRateLimitIdentity,
    getRequestAppSlug,
    getRequestUsername,
    getRequestUserId,
    readContextPostId,
    readContextPostData,
    readContextSubredditName,
} from './request/request-context.js';
import { getPostBoundDailyGpChallenge } from './posts/post-bound-challenge.js';
import {
    enableDailyAutopost,
    ensureDailyMiniRacerPostForSubreddit,
    getDailyGpShareRequestContext,
} from './daily/daily-post-service.js';
import {
    deleteDailyAutopostSubscription,
    readAllDailyAutopostSubscriptions,
} from './daily/daily-autopost-store.js';
import {
    enableDailyPodiumAutopost,
    ensureDailyMiniRacerPodiumPostForSubreddit,
} from './podium/daily-podium-service.js';
import {
    deleteDailyPodiumAutopostSubscription,
    readAllDailyPodiumAutopostSubscriptions,
} from './podium/daily-podium-autopost-store.js';
import { ensureMiniRacerLauncherPostForSubreddit } from './posts/launcher-post-service.js';
import { resolveMenuTargetSubredditName, assertModeratorForSubreddit } from './moderator/moderator-access.js';
import { recordAnalyticsPodiumEvent } from './moderator/analytics-store.js';
import { getModeratorAnalyticsSummary } from './moderator/moderator-analytics-summary.js';
import {
    ensureModeratorAnalyticsPostForSubreddit,
    resolveAnalyticsToolSubredditName,
} from './moderator/moderator-analytics-post.js';
import { registerPlayerRoutes } from './routes/player-routes.js';
import { registerAnalyticsRoutes } from './routes/analytics-routes.js';
import { registerCompetitionRoutes } from './routes/competition-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { sweepHeadToHeadCatalog } from './head-to-head/head-to-head-catalog.js';
import { registerPbGhostRoutes } from './routes/pb-ghost-routes.js';
import { registerPodiumRoutes } from './routes/podium-routes.js';
import { registerCampaignRoutes } from './routes/campaign-routes.js';
import { registerHeadToHeadRoutes } from './routes/head-to-head-routes.js';
import { registerLeaderboardRaceRoutes } from './routes/leaderboard-race-routes.js';
import { registerCommunityMapRoutes } from './routes/community-map-routes.js';
import { registerTrackRoutes } from './routes/track-routes.js';
import {
    deleteStoredTrack,
    describePlacedStoredTracks,
    ensureStoredTracksLoaded,
    installStoredTrackResolver,
    listStoredTracks,
    readPlacedStoredTracks,
    readStoredTrack,
    saveStoredTrack,
} from './tracks/track-store.js';
import {
    ensureCommunityCreatorPostForSubreddit,
    resolveCreatorToolSubredditName,
} from './moderator/community-creator-post.js';
import {
    readCommunityDraft,
    saveCommunityDraft,
    publishCommunityDraft,
    listCommunityMaps,
    readPublicCommunityMap,
    changeCommunityMapStatus,
} from './community/community-map-store.js';
import {
    getServerCampaignBootstrap,
    getServerCampaignPbGhost,
    getServerCampaignSnapshot,
    startServerCampaignRace,
    submitServerCampaignRun,
} from './campaign/campaign-store.js';
import { createHeadToHeadService } from './head-to-head/head-to-head-service.js';
import {
    confirmHeadToHeadBrag,
    previewHeadToHeadBrag,
} from './head-to-head/head-to-head-brag.js';
import {
    confirmHeadToHeadComment,
    previewHeadToHeadComment,
} from './head-to-head/head-to-head-comment.js';
import {
    readHeadToHeadViewerBest,
    recordHeadToHeadBest,
    resolveHeadToHeadSource,
    validateHeadToHeadReplay,
} from './head-to-head/head-to-head-runtime.js';
import { resolveLegacyDailyGpPodiumAvatars } from './podium/daily-podium-avatar-backfill.js';
import { loadDailyPodiumReplayForPost } from './podium/daily-podium-replay.js';
import { prepareServerLeaderboardRace } from './competition/leaderboard-race-service.js';

const headToHeadService = createHeadToHeadService({
    resolveSource: resolveHeadToHeadSource,
    validateReplay: validateHeadToHeadReplay,
    recordBest: recordHeadToHeadBest,
    readViewerBest: readHeadToHeadViewerBest,
});

// Every track lookup in this server reads the stored tracks of the current
// request's subreddit first.
installStoredTrackResolver();

function registerProductionRoutes(app: express.Application): void {
    registerTrackRoutes(app, {
        resolveCreatorToolSubredditName,
        assertModeratorForSubreddit,
        listStoredTracks,
        readStoredTrack,
        saveStoredTrack,
        deleteStoredTrack,
        isTrackPlaced: async () => false,
        readPlacedStoredTracks,
    });
    registerCommunityMapRoutes(app, {
        resolveCreatorToolSubredditName,
        readContextSubredditName,
        assertModeratorForSubreddit,
        readCommunityDraft,
        saveCommunityDraft,
        publishCommunityDraft,
        listCommunityMaps,
        readPublicCommunityMap,
        changeCommunityMapStatus,
    });
    registerAnalyticsRoutes(app, {
        resolveAnalyticsToolSubredditName,
        assertModeratorForSubreddit,
        getServerAnalyticsSummary: () => getModeratorAnalyticsSummary(),
        getGuestProgressTransferDiagnostic: (input) => getGuestProgressTransferDiagnostic(input),
        getRequestUsername,
        recordRaceStart: (input) => recordServerRaceStart(input),
        recordPodiumEvent: (input) => recordAnalyticsPodiumEvent(input),
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
        resolveDailyPodiumReplay: (postId, postData) => (
            loadDailyPodiumReplayForPost(postId, postData)
        ),
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
        describeStoredTracks: describePlacedStoredTracks,
        getHeadToHeadRequestContext: () => ({
            username: getRequestUsername(),
            userId: getRequestUserId(),
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
        previewHeadToHeadComment,
        confirmHeadToHeadComment,
        getNextHeadToHead: headToHeadService.next,
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
        describeStoredTracks: describePlacedStoredTracks,
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
        runRacedListFill: () => runRacedListFill(),
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
        assertModeratorForSubreddit,
        ensureCommunityCreatorPostForSubreddit,
        sweepHeadToHeadCatalog,
    });
}

export function createServerApp({
    registerRoutes = registerProductionRoutes,
}: {
    registerRoutes?: (app: express.Application) => void;
} = {}) {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use(async (_req, _res, next) => {
        try {
            await ensureStoredTracksLoaded();
        } catch (error) {
            console.error('Stored tracks could not load:', error);
        }
        next();
    });
    app.use(createTelemetryRouter());
    registerRoutes(app);
    return app;
}
