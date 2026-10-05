export {
    getGuestPlayerToken,
    getOrCreatePlayerId,
} from './player-identity.js';

const API_BASE_URL = '/api';

export const API_ROUTES = Object.freeze({
    playerBootstrapUrl: `${API_BASE_URL}/player/bootstrap`,
    playerProgressSelectionUrl: `${API_BASE_URL}/player/progress-selection`,
    playerIdentityUrl: `${API_BASE_URL}/player/identity`,
    playerPreferencesUrl: `${API_BASE_URL}/player/preferences`,
    playerTrackPbsUrl: `${API_BASE_URL}/player/track-pbs`,
    playerPbGhostUrl: `${API_BASE_URL}/player/pb-ghost`,
    scoreboardSnapshotUrl: `${API_BASE_URL}/scoreboard/snapshot`,
    dailyActiveUrl: `${API_BASE_URL}/daily/active`,
    dailyPlaylistUrl: `${API_BASE_URL}/daily/playlist`,
    dailySnapshotUrl: `${API_BASE_URL}/daily/snapshot`,
    dailySubmitUrl: `${API_BASE_URL}/daily/submit`,
    dailySharePreviewUrl: `${API_BASE_URL}/daily/share/preview`,
    dailyShareConfirmUrl: `${API_BASE_URL}/daily/share/confirm`,
    leaderboardRacePrepareUrl: `${API_BASE_URL}/leaderboard-race/prepare`,
    campaignBootstrapUrl: `${API_BASE_URL}/campaign/bootstrap`,
    campaignStartUrl: `${API_BASE_URL}/campaign/start`,
    campaignSnapshotUrl: `${API_BASE_URL}/campaign/snapshot`,
    campaignAggregateUrl: `${API_BASE_URL}/campaign/aggregate`,
    campaignSubmitUrl: `${API_BASE_URL}/campaign/submit`,
    campaignPbGhostUrl: `${API_BASE_URL}/campaign/pb-ghost`,
    campaignSharePreviewUrl: `${API_BASE_URL}/campaign/share/preview`,
    campaignShareConfirmUrl: `${API_BASE_URL}/campaign/share/confirm`,
    headToHeadPreviewUrl: `${API_BASE_URL}/head-to-head/preview`,
    headToHeadCreateUrl: `${API_BASE_URL}/head-to-head/create`,
    headToHeadUrl: `${API_BASE_URL}/head-to-head`,
    headToHeadSubmitUrl: `${API_BASE_URL}/head-to-head/submit`,
    headToHeadBragPreviewUrl: `${API_BASE_URL}/head-to-head/brag/preview`,
    headToHeadBragConfirmUrl: `${API_BASE_URL}/head-to-head/brag/confirm`,
    headToHeadCommentPreviewUrl: `${API_BASE_URL}/head-to-head/comment/preview`,
    headToHeadCommentConfirmUrl: `${API_BASE_URL}/head-to-head/comment/confirm`,
    headToHeadNextUrl: `${API_BASE_URL}/head-to-head/next`,
});

export function clampRequestLimit(limit, { defaultLimit, maxLimit = 100 } = {}) {
    if (!Number.isFinite(limit)) {
        return defaultLimit;
    }
    return Math.min(Math.max(Math.trunc(limit), 1), maxLimit);
}
