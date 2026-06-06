import { TRACKS } from '../track/tracks.js?v=2.09';
import { TRACK_MODE_DAILY_GP } from '../config.js?v=2.09';
import {
    getCachedDailyChallengePlaylist,
    getCachedDailyChallengeSnapshot,
    getDailyChallengePlaylist,
    prefetchDailyChallengeSnapshots,
    getDailyChallengeSnapshot
} from '../daily-challenge/service.js?v=2.09';
import { getScoreboardSnapshot } from './service.js?v=2.09';

export class LeaderboardsUi {
    constructor({
        showRunsModal,
        dailyChallengeUi,
        onStartDailyChallenge = null,
        getCachedTrackCardScoreboardSnapshot = () => null,
        getScoreboardSnapshot: loadScoreboardSnapshot = getScoreboardSnapshot,
        isRunsViewActive = () => true,
        updateModalScoreboardSnapshot = () => {},
    } = {}) {
        this.showRunsModal = showRunsModal;
        this.dailyChallengeUi = dailyChallengeUi;
        this.onStartDailyChallenge = onStartDailyChallenge;
        this.getCachedTrackCardScoreboardSnapshot = getCachedTrackCardScoreboardSnapshot;
        this.loadScoreboardSnapshot = loadScoreboardSnapshot;
        this.isRunsViewActive = isRunsViewActive;
        this.updateModalScoreboardSnapshot = updateModalScoreboardSnapshot;
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

    resolveInitialDailyChallengeSnapshot(challenge) {
        const providedSnapshot = challenge?.scoreboardSnapshot;
        if (
            providedSnapshot
            && typeof providedSnapshot === 'object'
            && !providedSnapshot.isLoading
        ) {
            return providedSnapshot;
        }

        return getCachedDailyChallengeSnapshot(challenge?.id);
    }

    syncDailyChallengeSummarySnapshot(challengeId, scoreboardSnapshot) {
        const summary = this.dailyChallengeUi.getSummary();
        if (summary?.challengeId !== challengeId) return;

        this.dailyChallengeUi.setDailyChallengeSummary({
            ...summary,
            rankLabel: scoreboardSnapshot?.playerRankLabel || '--',
            scoreboardSnapshot: scoreboardSnapshot || null
        });
    }

    async requestDailyChallengeLeaderboardSnapshot(challengeId, { forceRefresh = false } = {}) {
        if (!challengeId) return null;

        try {
            const scoreboardSnapshot = await getDailyChallengeSnapshot({
                challengeId,
                forceRefresh
            });
            this.syncDailyChallengeSummarySnapshot(challengeId, scoreboardSnapshot);
            return scoreboardSnapshot || null;
        } catch (error) {
            console.error('Error loading daily challenge leaderboard:', error);
            return null;
        }
    }

    async openDailyChallengeLeaderboard(returnMode = 'close', options = {}) {
        const summary = this.dailyChallengeUi.getSummary();
        if (!summary?.challengeId || !summary.trackKey) return;

        await this.openDailyChallengeLeaderboardForChallenge({
            id: summary.challengeId,
            trackKey: summary.trackKey,
        }, returnMode, options);
    }

    buildDailyChallengeLeaderboardRows(challenges = []) {
        return (Array.isArray(challenges) ? challenges : [])
            .filter((challenge) => challenge?.id && challenge.trackKey && TRACKS[challenge.trackKey])
            .map((challenge) => ({
                challenge,
                trackKey: challenge.trackKey,
                scoreboardSnapshot: this.resolveInitialDailyChallengeSnapshot(challenge) || { isLoading: true }
            }));
    }

    openDailyChallengeLeaderboardOverviewModal(challenges, actions) {
        const rows = this.buildDailyChallengeLeaderboardRows(challenges);
        this.dailyChallengeUi.openLeaderboardTracksModal(rows.length ? rows : null, actions);
        return rows;
    }

    async openDailyChallengeLeaderboardOverview() {
        const requestId = ++this._requestVersion;
        let loadedChallenges = getCachedDailyChallengePlaylist();
        let currentRows = [];
        const actions = {
            onPlay: (challenge) => {
                this.onStartDailyChallenge?.(challenge);
            },
            onTrack: (challenge) => {
                void this.openDailyChallengeLeaderboardForChallenge(challenge, 'close', {
                    onClose: () => {
                        if (loadedChallenges.length) {
                            currentRows = this.buildDailyChallengeLeaderboardRows(loadedChallenges);
                        }
                        this.dailyChallengeUi.openLeaderboardTracksModal(currentRows, actions);
                    }
                });
            }
        };

        currentRows = this.openDailyChallengeLeaderboardOverviewModal(
            loadedChallenges.length ? loadedChallenges : null,
            actions
        );

        try {
            loadedChallenges = await getDailyChallengePlaylist();
            await prefetchDailyChallengeSnapshots(
                loadedChallenges.map((challenge) => challenge?.id).filter(Boolean)
            );
            currentRows = this.buildDailyChallengeLeaderboardRows(loadedChallenges);
        } catch (error) {
            console.error('Error loading leaderboard tracks:', error);
            currentRows = [];
        }

        if (
            requestId === this._requestVersion
            && this.dailyChallengeUi.isLeaderboardTracksModalOpen?.()
        ) {
            this.dailyChallengeUi.renderLeaderboardTracks?.(currentRows, actions);
        }
    }

    async openDailyChallengeLeaderboardForChallenge(challenge, returnMode = 'close', {
        onClose = null
    } = {}) {
        if (!challenge?.id || !challenge.trackKey || !TRACKS[challenge.trackKey]) return;

        const requestId = ++this._requestVersion;
        const sharedOptions = {
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: challenge.trackKey,
            scoreboardSubhead: TRACKS[challenge.trackKey].name,
        };
        const initialSnapshot = this.resolveInitialDailyChallengeSnapshot(challenge);

        this.showLeaderboardModalState(returnMode, {
            ...sharedOptions,
            scoreboardChallengeId: challenge.id,
            scoreboardSnapshot: initialSnapshot || { isLoading: true },
            onClose
        });

        if (initialSnapshot) return;

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

    async showTrackLeaderboardModal(trackKey, returnMode = 'close', {
        scoreboardSnapshot = null
    } = {}) {
        if (!trackKey || !TRACKS[trackKey]) return;

        const providedSnapshot =
            scoreboardSnapshot
            && typeof scoreboardSnapshot === 'object'
            && !scoreboardSnapshot.isLoading
                ? scoreboardSnapshot
                : null;
        const cachedSnapshot = providedSnapshot
            || this.getCachedTrackCardScoreboardSnapshot(trackKey, TRACK_MODE_DAILY_GP);
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
