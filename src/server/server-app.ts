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
import { getChallengeAnalyticsPage, recordChallengeAnalyticsEvent } from './moderator/challenge-analytics-store.js';
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
import { isTrackInDailySchedule, saveDailySchedule } from './daily/daily-schedule-store.js';
import { readCreatorDailyView } from './daily/daily-schedule-view.js';
import {
    readLockedCopyReport, readMigrationReport, runLiveCampaignCopy, runPlayedDailyCopy, runTrackMigration,
} from './tracks/track-migration.js';
import { registerCreatorSeriesRoutes } from './routes/creator-series-routes.js';
import {
    copyAppSeriesDrafts,
    copyLiveAppSeries,
    deleteStoredSeries,
    installStoredSeriesResolver,
    isTrackInStoredSeries,
    publishStoredSeries,
    readStoredSeries,
    resolveStoredSeriesForRequest,
    runWithPinnedStoredSeries,
    saveStoredSeries,
} from './campaign/series-store.js';
import { findSeriesUsingTrack } from './campaign/series-usage.js';
import { readCreatorSeriesView } from './campaign/series-view.js';
import {
    deleteStoredTrack,
    describePlacedStoredTracks,
    installStoredTrackResolver,
    runWithPinnedStoredTracks,
    readPlacedStoredTracks,
    saveStoredTrack,
} from './tracks/track-store.js';
import {
    creatorTrackRecord, listCreatorTrackRecords, listCreatorTracks, readCreatorTrack,
} from './tracks/creator-track-access.js';
import { ensureStoredCatalogLoaded, loadStoredTracks, reloadPinnedCatalog } from './tracks/stored-catalog.js';
import { readCopyCheck, runCopyCheck } from './tracks/copy-check.js';
import { readCopyUndoReport, runCopyUndo } from './tracks/copy-undo.js';
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
    getServerCampaignAggregate,
    runCampaignAggregateFills,
    startServerCampaignRace,
    submitServerCampaignRun,
} from './campaign/campaign-store.js';
import { createHeadToHeadService } from './head-to-head/head-to-head-service.js';
import { previewServerCampaignResultsShare, confirmServerCampaignResultsShare, refreshServerCampaignResultsShare } from './campaign/campaign-share.js';
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
// request's subreddit first, and the Campaign reads its published series.
installStoredTrackResolver();
installStoredSeriesResolver();

async function isTrackPlaced(trackKey: string): Promise<boolean> {
    return await isTrackInDailySchedule(trackKey) || await isTrackInStoredSeries(trackKey);
}

function registerProductionRoutes(app: express.Application): void {
    registerTrackRoutes(app, {
        resolveCreatorToolSubredditName,
        assertModeratorForSubreddit,
        listStoredTracks: listCreatorTracks,
        listStoredTrackRecords: listCreatorTrackRecords,
        readStoredTrack: readCreatorTrack,
        saveStoredTrack: async (key, input, options) => creatorTrackRecord(await saveStoredTrack(key, input, options)),
        deleteStoredTrack,
        isTrackPlaced,
        readPlacedStoredTracks,
        readCreatorDailyView,
        saveDailySchedule: (keys, options) => saveDailySchedule(keys, {
            ...options,
            findSeriesUsingTrack: (trackKey) => findSeriesUsingTrack(trackKey),
        }),
        runTrackMigration: (options) => runTrackMigration({
            ...options,
            hooks: { copySeries: (copyOptions) => copyAppSeriesDrafts(copyOptions) },
        }),
        readMigrationReport,
        runPlayedDailyCopy,
        runLiveCampaignCopy: (options) => runLiveCampaignCopy({
            ...options,
            copyLiveSeries: (copyOptions) => copyLiveAppSeries(copyOptions),
        }),
        readLockedCopyReport,
        runCopyCheck: (options) => runCopyCheck(options),
        readCopyCheck,
        runCopyUndo: (kind, options) => runCopyUndo(kind, options),
        readCopyUndoReport,
    });
    registerCreatorSeriesRoutes(app, {
        resolveCreatorToolSubredditName,
        assertModeratorForSubreddit,
        readCreatorSeriesView,
        readStoredSeries,
        saveStoredSeries: (seriesId, input, options) => saveStoredSeries(seriesId, input, {
            ...options,
            isTrackUsedElsewhere: async (trackKey, id) => await isTrackInDailySchedule(trackKey)
                || Boolean(await findSeriesUsingTrack(trackKey, id)),
        }),
        publishStoredSeries,
        deleteStoredSeries,
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
        recordChallengeEvent: recordChallengeAnalyticsEvent,
        getChallengeAnalyticsPage,
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
        getServerCampaignAggregate: (input) => getServerCampaignAggregate(input),
        submitServerCampaignRun: (input) => submitServerCampaignRun(input),
        getServerCampaignPbGhost: (input) => getServerCampaignPbGhost(input),
        previewServerCampaignResultsShare: (input) => previewServerCampaignResultsShare(input),
        confirmServerCampaignResultsShare: (input) => confirmServerCampaignResultsShare(input),
        refreshServerCampaignResultsShare: (input) => refreshServerCampaignResultsShare(input),
        readContextSubredditName,
        describeStoredSeries: resolveStoredSeriesForRequest,
        describeStoredTracks: describePlacedStoredTracks,
        refreshStoredCatalog: reloadPinnedCatalog,
        loadStoredTracks,
    });
    registerHeadToHeadRoutes(app, {
        describeStoredTracks: describePlacedStoredTracks,
        refreshStoredCatalog: reloadPinnedCatalog,
        loadStoredTracks,
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
        refreshStoredCatalog: reloadPinnedCatalog,
        loadStoredTracks,
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
        runRacedListFill: async () => {
            const result = await runRacedListFill();
            await runCampaignAggregateFills();
            return result;
        },
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

// Routes that need no catalog load: they read no track and no series, or they
// read their own tracks. Match the method and the exact path.
const CATALOG_FREE_ROUTES = new Set([
    'POST /api/analytics/race-start',
    'POST /api/analytics/podium',
    'POST /api/analytics/challenge',
    // Reads its own index fields and records, and checks that they agree.
    'GET /api/tracks/stored',
]);

export function createServerApp({
    registerRoutes = registerProductionRoutes,
}: {
    registerRoutes?: (app: express.Application) => void;
} = {}) {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use(createTelemetryRouter());
    // A request that cannot know which layout is live must not answer as if
    // the app layout were live. Only routes that never read a track skip this.
    app.use(async (req, res, next) => {
        if (CATALOG_FREE_ROUTES.has(`${req.method} ${req.path}`)) {
            next();
            return;
        }
        try {
            await ensureStoredCatalogLoaded();
        } catch (error) {
            console.error('Stored tracks could not load:', error);
            res.status(503).json({ error: 'The tracks could not load. Try again.' });
            return;
        }
        // The route reads one fixed track list and series list from here to
        // its end.
        runWithPinnedStoredSeries(() => runWithPinnedStoredTracks(next));
    });
    registerRoutes(app);
    return app;
}
