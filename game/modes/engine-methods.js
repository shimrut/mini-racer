/**
 * Cross-mode routing for the race engine.
 *
 * Home, Daily, Campaign, and player Challenge all share one race loop, so the
 * decision of which mode owns a lobby, a restart, or a finish belongs here
 * rather than inside any single mode's module. Each mode still implements its
 * own lobby and finish behaviour; this layer only dispatches to them.
 */
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
        // Home renders the day's track behind the menu, and racing anything else
        // leaves `currentTrackKey` pointing at whatever was driven last. Only the
        // boot path used to set this background, so one race on a campaign stage
        // — or on any day but today — replaced the featured track for the rest of
        // the session.
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
