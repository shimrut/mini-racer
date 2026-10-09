import {
    cancelDeferredLobbyWork,
    deferLobbyWorkUntilAfterPaint,
} from '../lobby/deferred-work.js';
import { isVerificationQueueSubmissionBlocked } from '../scoreboard/verification-queue.js';
import { hasChangedTrackDefinition, reloadChangedRaceTrack, revealInstalledRace } from '../track/race-definition.js';

export const modeRouterEngineMethods = {
    showHomeLobby() {
        const wasEnteringMode = this._modeEntryPending === true;
        this._modeEntryToken = (this._modeEntryToken || 0) + 1;
        this.cancelRacePreparation?.();
        if (wasEnteringMode) {
            this._modeEntryPending = false;
            this.loadingScreen?.dismiss?.();
        }
        cancelDeferredLobbyWork(this);
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'home';
        this.activeCampaignStage = null;
        this.activeHeadToHead = null;
        this.clearDailyChallengeRun();
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showHome();
        if (typeof this.syncReadyBackgroundTrack === 'function') {
            void this.syncReadyBackgroundTrack(this.currentDailyChallenge).catch((error) => {
                console.error('Error syncing Home background track:', error);
            });
        }
    },

    showDailyLobby({ selectChallengeId = null } = {}) {
        this.cancelRacePreparation?.();
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'daily';
        this.activeCampaignStage = null;
        this.activeHeadToHead = null;
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showDaily();
        if (this.dailyCarousel?.isEmpty?.()) {
            this.dailyCarousel.renderStatus?.({ loading: true });
        }
        deferLobbyWorkUntilAfterPaint(this, 'daily', () => {
            void this.refreshDailyCarousel?.({ selectChallengeId });
        });
    },

    openVisibleLobbyStandings(mode = this.activeRaceMode) {
        if (mode === 'daily') {
            const challenge = this.dailyCarousel?.getSelectedChallenge?.();
            if (challenge) this.openDailyCarouselStandings?.(challenge);
            return;
        }
        if (mode === 'campaign') {
            // The series screen has no stage: Standings opens the Campaign
            // leaderboard of a finished series.
            if (this.campaignLobbyView === 'series') {
                void this.openCampaignSeriesStandings?.();
                return;
            }
            const stage = this.campaignCarousel?.getSelectedChallenge?.();
            if (stage) {
                void this.openCampaignStandings?.(stage, { returnMode: 'close' });
            }
        }
    },

    handleActiveRaceLapCompleted(lapTime, details) {
        if (this.activeRaceMode === 'community') return;
        this.handleChallengeLapCompleted?.(lapTime, details);
    },

    handleActiveRaceWin(winData) {
        if (this.activeRaceMode === 'community') {
            this.handleCommunityWin(winData);
            return;
        }
        if (this.activeRaceMode === 'campaign') {
            void this.handleCampaignWin(winData);
            return;
        }
        if (this.activeRaceMode === 'challenge') {
            void this.handleHeadToHeadWin(winData);
            return;
        }
        this.handleDailyChallengeWin(winData);
    },

    restartActiveRace() {
        if (this.activeRaceMode === 'community') {
            this.restartCommunityRace();
            return;
        }
        if (isVerificationQueueSubmissionBlocked()) return;
        if (this.activeRaceMode === 'daily') {
            return this.restartDailyChallenge({ reason: 'restart' });
        }
        if (!this.currentChallengeRun) return;
        if (hasChangedTrackDefinition(this)) {
            this.cancelRacePreparation?.();
            const continuation = this._raceContinuationToken;
            const stillCurrent = () => this._raceContinuationToken === continuation;
            return reloadChangedRaceTrack(this, { isStillCurrent: stillCurrent })
                .then(async () => {
                    if (this._raceContinuationToken !== continuation) return;
                    await revealInstalledRace(this);
                    if (this._raceContinuationToken !== continuation) return;
                    this.restartActiveRace();
                })
                .catch((error) => {
                    if (!stillCurrent()) return;
                    console.error('Could not prepare the updated race track:', error);
                    this.returnToActiveLobby?.();
                    this.lobbyUi?.setRaceStartError?.(this.activeRaceMode, 'Could not confirm this track. Retry before racing.');
                });
        }
        if (this.activeRaceMode === 'challenge') this.recordHeadToHeadStart?.();
        void this.journeys?.endAttempt?.({ complete: false });
        void this.journeys?.startAttempt?.({ mode: this.activeRaceMode, reason: 'restart' });
        this.reset(true, { preserveDailyChallenge: true, showStartOverlay: false });
    },

    returnToActiveLobby() {
        if (this.activeRaceMode === 'community') return this.showCommunityLobby();
        if (this.activeRaceMode === 'campaign') return this.showCampaignLobby();
        if (this.activeRaceMode === 'challenge') {
            return this.showChallengeLobby();
        }
        const racedChallengeId = this.activeDailyChallenge?.id
            || this.lastPlayedDailyChallenge?.id
            || this.selectedDailyChallengeId
            || null;
        return this.showDailyLobby({ selectChallengeId: racedChallengeId });
    },
};
