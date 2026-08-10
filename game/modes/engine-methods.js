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
        this.activeHeadToHead = null;
        this.clearDailyChallengeRun();
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showHome();
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
        this.handleDailyChallengeLapCompleted(lapTime, details);
    },

    handleActiveRaceWin(winData) {
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
            return this.loadChallengeLobby(this.activeHeadToHead?.challengeId);
        }
        const racedChallengeId = this.activeDailyChallenge?.id
            || this.lastPlayedDailyChallenge?.id
            || this.selectedDailyChallengeId
            || null;
        return this.showDailyLobby({ selectChallengeId: racedChallengeId });
    },
};
