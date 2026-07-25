/** `/api` route table + request helpers. Player identity lives in `player-identity.js`. */

export {
    getGuestPlayerToken,
    getOrCreatePlayerId,
    rotateGuestPlayerIdentity,
    setGuestPlayerToken,
} from './player-identity.js';

const API_BASE_URL = '/api';

export const API_ROUTES = Object.freeze({
    apiBaseUrl: API_BASE_URL,
    playerBootstrapUrl: `${API_BASE_URL}/player/bootstrap`,
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
    campaignBootstrapUrl: `${API_BASE_URL}/campaign/bootstrap`,
    campaignStartUrl: `${API_BASE_URL}/campaign/start`,
    campaignSnapshotUrl: `${API_BASE_URL}/campaign/snapshot`,
    campaignSubmitUrl: `${API_BASE_URL}/campaign/submit`,
    campaignPbGhostUrl: `${API_BASE_URL}/campaign/pb-ghost`,
    campaignChallengePreviewUrl: `${API_BASE_URL}/campaign/challenge/preview`,
    campaignChallengeCreateUrl: `${API_BASE_URL}/campaign/challenge/create`,
    campaignChallengeUrl: `${API_BASE_URL}/campaign/challenge`,
    campaignChallengeSubmitUrl: `${API_BASE_URL}/campaign/challenge/submit`,
    campaignChallengeBragPreviewUrl: `${API_BASE_URL}/campaign/challenge/brag/preview`,
    campaignChallengeBragConfirmUrl: `${API_BASE_URL}/campaign/challenge/brag/confirm`,
});

export function clampRequestLimit(limit, { defaultLimit, maxLimit = 100 } = {}) {
    if (!Number.isFinite(limit)) {
        return defaultLimit;
    }
    return Math.min(Math.max(Math.trunc(limit), 1), maxLimit);
}
