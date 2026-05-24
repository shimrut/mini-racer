import { TRACKS } from '../track/tracks.js?v=1.91';
import { TRACK_MODE_DAILY_GP } from '../config.js?v=1.91';
import {
    getDailyChallengeSnapshot
} from '../daily-challenge/service.js?v=1.92';
import { getScoreboardSnapshot } from './service.js?v=1.91';

export class LeaderboardsUi {
    constructor({
        showRunsModal,
        dailyChallengeUi,
        getCachedTrackCardScoreboardSnapshot = () => null,
        getScoreboardSnapshot: loadScoreboardSnapshot = getScoreboardSnapshot,
        isRunsViewActive = () => true,
        updateModalScoreboardSnapshot = () => {},
    } = {}) {
        this.showRunsModal = showRunsModal;
        this.dailyChallengeUi = dailyChallengeUi;
        this.getCachedTrackCardScoreboardSnapshot = getCachedTrackCardScoreboardSnapshot;
        this.loadScoreboardSnapshot = loadScoreboardSnapshot;
        this.isRunsViewActive = isRunsViewActive;
        this.updateModalScoreboardSnapshot = updateModalScoreboardSnapshot;
        this._pendingDailyChallengeSnapshotRequest = null;
        this._requestVersion = 0;
    }

    showLeaderboardModalState(returnMode = 'close', {
        scoreboardSnapshot = null,
        scoreboardChallengeId = null,
        scoreboardTrackKey = null,
        scoreboardSubhead = null,
        onClose = null
    } = {}) {
        const payload = {
            scoreboardSnapshot,
            scoreboardMode: TRACK_MODE_DAILY_GP
        };
        if (scoreboardTrackKey !== null) {
            payload.scoreboardTrackKey = scoreboardTrackKey;
        }
        if (scoreboardChallengeId !== null) {
            payload.scoreboardChallengeId = scoreboardChallengeId;
        }
        if (scoreboardSubhead !== null) {
            payload.scoreboardSubhead = scoreboardSubhead;
        }
        if (typeof onClose === 'function') {
            payload.onClose = onClose;
        }
        this.showRunsModal(null, null, null, returnMode, payload);
    }

    cancelPendingRequests() {
        this._requestVersion += 1;
    }

    async requestDailyChallengeLeaderboardSnapshot(challengeId) {
        if (!challengeId) return null;

        const pendingRequest = this._pendingDailyChallengeSnapshotRequest;
        if (pendingRequest?.challengeId === challengeId) {
            return pendingRequest.promise;
        }

        const requestPromise = getDailyChallengeSnapshot({ challengeId })
            .then((scoreboardSnapshot) => {
                const summary = this.dailyChallengeUi.getSummary();
                if (summary?.challengeId === challengeId) {
                    this.dailyChallengeUi.setDailyChallengeSummary({
                        ...summary,
                        rankLabel: scoreboardSnapshot?.playerRankLabel || '--',
                        scoreboardSnapshot: scoreboardSnapshot || null
                    });
                }
                return scoreboardSnapshot || null;
            })
            .catch((error) => {
                console.error('Error loading daily challenge leaderboard:', error);
                return null;
            })
            .finally(() => {
                if (this._pendingDailyChallengeSnapshotRequest?.challengeId === challengeId) {
                    this._pendingDailyChallengeSnapshotRequest = null;
                }
            });

        this._pendingDailyChallengeSnapshotRequest = {
            challengeId,
            promise: requestPromise
        };
        return requestPromise;
    }

    async openDailyChallengeLeaderboard(returnMode = 'close', options = {}) {
        const summary = this.dailyChallengeUi.getSummary();
        if (!summary?.challengeId || !summary.trackKey) return;

        await this.openDailyChallengeLeaderboardForChallenge({
            id: summary.challengeId,
            trackKey: summary.trackKey,
            scoreboardSnapshot: summary.scoreboardSnapshot,
        }, returnMode, options);
    }

    async openDailyChallengeLeaderboardForChallenge(challenge, returnMode = 'close', {
        onClose = null
    } = {}) {
        if (!challenge?.id || !challenge.trackKey || !TRACKS[challenge.trackKey]) return;

        const requestId = ++this._requestVersion;
        const sharedOptions = {
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: challenge.trackKey,
            scoreboardSubhead: 'Leaderboard · Daily Challenge'
        };
        this.showLeaderboardModalState(returnMode, {
            ...sharedOptions,
            scoreboardChallengeId: challenge.id,
            scoreboardSnapshot: challenge.scoreboardSnapshot || { isLoading: true },
            onClose
        });

        const scoreboardSnapshot = await this.requestDailyChallengeLeaderboardSnapshot(challenge.id);
        if (requestId !== this._requestVersion) return;

        if (this.isRunsViewActive()) {
            this.showLeaderboardModalState(returnMode, {
                ...sharedOptions,
                scoreboardChallengeId: challenge.id,
                scoreboardSnapshot,
                onClose
            });
        } else {
            this.updateModalScoreboardSnapshot(scoreboardSnapshot);
        }
    }

    async showTrackLeaderboardModal(trackKey, returnMode = 'close') {
        if (!trackKey || !TRACKS[trackKey]) return;

        const cachedSnapshot = this.getCachedTrackCardScoreboardSnapshot(trackKey, TRACK_MODE_DAILY_GP);
        const requestId = ++this._requestVersion;
        this.showLeaderboardModalState(returnMode, {
            scoreboardSnapshot: cachedSnapshot || { isLoading: true },
            scoreboardTrackKey: trackKey
        });

        if (cachedSnapshot) return;

        try {
            const scoreboardSnapshot = await this.loadScoreboardSnapshot({
                trackKey,
                limit: 10
            });
            if (requestId !== this._requestVersion) return;

            if (this.isRunsViewActive()) {
                this.showLeaderboardModalState(returnMode, {
                    scoreboardSnapshot,
                    scoreboardTrackKey: trackKey
                });
            } else {
                this.updateModalScoreboardSnapshot(scoreboardSnapshot);
            }
        } catch (error) {
            console.error('Error loading track leaderboard:', error);
            if (requestId !== this._requestVersion) return;

            if (this.isRunsViewActive()) {
                this.showLeaderboardModalState(returnMode, {
                    scoreboardSnapshot: null,
                    scoreboardTrackKey: trackKey
                });
            } else {
                this.updateModalScoreboardSnapshot(null);
            }
        }
    }
}
