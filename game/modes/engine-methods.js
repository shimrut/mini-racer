import {
    cancelDeferredLobbyWork,
    deferLobbyWorkUntilAfterPaint,
} from '../lobby/deferred-work.js';
import { isVerificationQueueSubmissionBlocked } from '../scoreboard/verification-queue.js';
import { hasChangedTrackDefinition, reloadChangedRaceTrack } from '../track/race-definition.js';

export const modeRouterEngineMethods = {
    showHomeLobby() {
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
            const stage = this.campaignCarousel?.getSelectedChallenge?.();
            if (stage) {
                void this.openCampaignStandings?.(stage, { returnMode: 'close' });
            }
        }
    },

    handleActiveRaceLapCompleted(lapTime, details) {
        if (this.activeRaceMode === 'community') return;
        if (typeof this.handleChallengeLapCompleted === 'function') {
            this.handleChallengeLapCompleted(lapTime, details);
            return;
        }
        this.handleDailyChallengeLapCompleted?.(lapTime, details);
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
            return reloadChangedRaceTrack(this)
                .then(() => this.restartActiveRace())
                .catch((error) => {
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
