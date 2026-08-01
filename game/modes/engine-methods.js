/** Cross-mode routing: Home, Daily, Campaign and Challenge share one race loop, so which mode owns a lobby/restart/finish is decided here and dispatched to each mode's own implementation. */
import {
    cancelDeferredLobbyWork,
    deferLobbyWorkUntilAfterPaint,
} from '../lobby/deferred-work.js';

export const modeRouterEngineMethods = {
    showHomeLobby() {
        cancelDeferredLobbyWork(this);
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'home';
        this.activeCampaignStage = null;
        this.activeCampaignChallenge = null;
        this.clearDailyChallengeRun();
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showHome();
        // Re-syncs the background to today's track, since a race on any other
        // track (or day) leaves currentTrackKey pointing at it.
        void this.syncReadyBackgroundTrack(this.currentDailyChallenge).catch((error) => {
            console.error('Error syncing Home background track:', error);
        });
    },

    showDailyLobby({ selectChallengeId = null } = {}) {
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'daily';
        this.activeCampaignStage = null;
        this.activeCampaignChallenge = null;
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showDaily();
        if (this.dailyCarousel?.isEmpty?.()) {
            this.dailyCarousel.renderStatus?.({ loading: true });
        }
        // Switching panes is the response to the tap. Card construction and
        // preview canvases wait until that lightweight state has painted.
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
            if (stage?.unlocked === false) return;
            if (stage) {
                void this.openCampaignStandings?.(stage, { returnMode: 'close' });
            }
        }
    },

    handleActiveRaceLapCompleted(lapTime, details) {
        this.handleDailyChallengeLapCompleted(lapTime, details);
    },

    handleActiveRaceWin(winData) {
        if (this.activeRaceMode === 'campaign') {
            void this.handleCampaignWin(winData);
            return;
        }
        if (this.activeRaceMode === 'challenge') {
            void this.handleCampaignChallengeWin(winData);
            return;
        }
        this.handleDailyChallengeWin(winData);
    },

    restartActiveRace() {
        if (this.activeRaceMode === 'daily') {
            this.restartDailyChallenge({ reason: 'restart' });
            return;
        }
        if (!this.currentChallengeRun) return;
        void this.journeys?.endAttempt?.({ complete: false });
        void this.journeys?.startAttempt?.({ reason: 'restart' });
        this.reset(true, { preserveDailyChallenge: true, showStartOverlay: false });
    },

    returnToActiveLobby() {
        if (this.activeRaceMode === 'campaign') return this.showCampaignLobby();
        if (this.activeRaceMode === 'challenge') {
            return this.loadChallengeLobby(this.activeCampaignChallenge?.challengeId);
        }
        // Capture this before showDailyLobby resets the completed run. Scroll
        // position is presentation state; the race record is the authority for
        // which day must be restored.
        const racedChallengeId = this.activeDailyChallenge?.id
            || this.lastPlayedDailyChallenge?.id
            || this.selectedDailyChallengeId
            || null;
        return this.showDailyLobby({ selectChallengeId: racedChallengeId });
    },
};
