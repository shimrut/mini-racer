import {
    collectVisibleActionButtons,
    createMenuKeyboardState,
    dismissMenuKeyboardCue,
    handleMenuListKeydown,
    resetMenuKeyboardState,
} from '../ui/menu-keyboard-nav.js';
import {
    normalizeCampaignLobbyState,
    normalizeChallengeLobbyState,
} from './service.js';

const LOBBY_MODES = ['home', 'daily', 'campaign', 'challenge'];
const BLOCKING_OVERLAY_IDS = [
    'modal',
    'settings-modal',
    'garage-modal',
    'daily-playlist-modal',
];

function setText(element, value) {
    if (element) element.textContent = value;
}

export class LobbyUi {
    constructor({
        onSelectDaily = null,
        onSelectCampaign = null,
        onBack = null,
        onStartDaily = null,
        onStartCampaign = null,
        onOpenCampaignStandings = null,
        onOpenCampaignTracks = null,
        onAcceptChallenge = null,
    } = {}) {
        this.onSelectDaily = onSelectDaily;
        this.onSelectCampaign = onSelectCampaign;
        this.onBack = onBack;
        this.onStartDaily = onStartDaily;
        this.onStartCampaign = onStartCampaign;
        this.onOpenCampaignStandings = onOpenCampaignStandings;
        this.onOpenCampaignTracks = onOpenCampaignTracks;
        this.onAcceptChallenge = onAcceptChallenge;
        this.mode = 'home';
        this.campaignState = normalizeCampaignLobbyState();
        this.challengeState = normalizeChallengeLobbyState();
        this._dailyTrackName = '';
        this._campaignPrimaryLoading = false;
        this._menuKeyboardState = createMenuKeyboardState();
        this._bound = false;
        this._keydownHandler = (event) => this.handleKeydown(event);
        this._pointerMoveHandler = (event) => this.handlePointerMove(event);
    }

    get overlay() { return document.getElementById('start-overlay'); }
    get activePane() { return document.getElementById(`lobby-${this.mode}-pane`); }
    get campaignPrimaryBtn() { return document.getElementById('campaign-primary-btn'); }
    get challengeAcceptBtn() { return document.getElementById('challenge-accept-btn'); }

    bind() {
        if (this._bound || typeof document === 'undefined') return;
        this._bound = true;
        document.getElementById('lobby-home-daily-btn')
            ?.addEventListener('click', () => this.onSelectDaily?.());
        document.getElementById('lobby-home-campaign-btn')
            ?.addEventListener('click', () => this.onSelectCampaign?.());
        document.getElementById('lobby-daily-back-btn')
            ?.addEventListener('click', () => this.onBack?.('daily'));
        document.getElementById('lobby-campaign-back-btn')
            ?.addEventListener('click', () => this.onBack?.('campaign'));
        document.getElementById('lobby-challenge-back-btn')
            ?.addEventListener('click', () => this.onBack?.('challenge'));
        document.getElementById('daily-challenge-start-btn')
            ?.addEventListener('click', () => this.onStartDaily?.());
        document.getElementById('campaign-standings-btn')
            ?.addEventListener('click', () => this.onOpenCampaignStandings?.());
        document.getElementById('campaign-tracks-btn')
            ?.addEventListener('click', () => this.onOpenCampaignTracks?.());
        this.campaignPrimaryBtn?.addEventListener('click', () => {
            if (this.campaignState.complete) return;
            // Resolve the continue stage after bootstrap is ready — do not pass a stale stage.
            this.onStartCampaign?.();
        });
        this.challengeAcceptBtn?.addEventListener('click', () => {
            if (!this.challengeState.canAccept) return;
            this.onAcceptChallenge?.(this.challengeState);
        });
        document.addEventListener('keydown', this._keydownHandler, true);
        document.addEventListener('pointermove', this._pointerMoveHandler, true);
    }

    showHome() {
        this.showPane('home');
    }

    showDaily() {
        this.showPane('daily');
    }

    showCampaign(state = this.campaignState) {
        this.campaignState = normalizeCampaignLobbyState(state);
        this.renderCampaign();
        this.showPane('campaign');
    }

    showChallenge(state = this.challengeState) {
        this.challengeState = normalizeChallengeLobbyState(state);
        this.renderChallenge();
        this.showPane('challenge');
    }

    showPane(mode) {
        if (!LOBBY_MODES.includes(mode)) return false;
        this.mode = mode;
        for (const candidate of LOBBY_MODES) {
            const pane = document.getElementById(`lobby-${candidate}-pane`);
            if (!pane) continue;
            const isActive = candidate === mode;
            pane.hidden = !isActive;
            pane.classList.toggle('is-active', isActive);
            pane.setAttribute('aria-hidden', String(!isActive));
        }
        if (document.body?.dataset) document.body.dataset.lobbyMode = mode;
        this.updateModeLabel(mode);
        this.overlay?.setAttribute('aria-label', this.getPaneAriaLabel(mode));
        this.resetKeyboardNav();
        requestAnimationFrame(() => this.focus());
        return true;
    }

    updateModeLabel(mode = this.mode) {
        const subhead = document.querySelector('[data-lobby-subhead]');
        const label = document.querySelector('[data-lobby-mode-label]');
        if (!label) return;
        if (mode === 'daily') {
            if (subhead) subhead.hidden = false;
            label.textContent = 'Daily';
            this.syncLobbySubheadDetail();
            return;
        }
        if (mode === 'campaign') {
            if (subhead) subhead.hidden = false;
            label.textContent = 'Campaign';
            this.updateDailyTrackLabel('');
            return;
        }
        if (mode === 'challenge') {
            if (subhead) subhead.hidden = false;
            label.textContent = 'Challenge';
            this.syncLobbySubheadDetail();
            return;
        }
        if (subhead) subhead.hidden = true;
        label.textContent = '';
        this.updateDailyTrackLabel('');
    }

    updateDailyTrackLabel(trackName = '') {
        this._dailyTrackName = typeof trackName === 'string' ? trackName.trim() : '';
        this.syncLobbySubheadDetail();
    }

    syncLobbySubheadDetail() {
        const track = document.querySelector('[data-lobby-mode-track]');
        if (!track) return;
        if (this.mode === 'daily' && this._dailyTrackName) {
            track.hidden = false;
            track.textContent = this._dailyTrackName;
            track.classList.remove('lobby-mode-track--challenge');
            return;
        }
        if (this.mode === 'challenge') {
            const opponent = this.challengeState?.opponentLabel?.trim() || '';
            track.hidden = !opponent;
            track.textContent = opponent;
            track.classList.toggle('lobby-mode-track--challenge', Boolean(opponent));
            return;
        }
        track.hidden = true;
        track.textContent = '';
        track.classList.remove('lobby-mode-track--challenge');
    }

    getMode() {
        return this.mode;
    }

    getPaneAriaLabel(mode = this.mode) {
        return {
            home: 'Mini Racer mode selection',
            daily: 'Daily challenge',
            campaign: 'Campaign',
            challenge: 'Player challenge',
        }[mode] || 'Mini Racer lobby';
    }

    getVisibleActions() {
        return collectVisibleActionButtons(this.activePane, '[data-lobby-action]');
    }

    getPreferredIndex(buttons = this.getVisibleActions()) {
        if (this.mode === 'home') return 0;
        const preferred = this.mode === 'daily'
            ? document.getElementById('daily-challenge-start-btn')
            : this.mode === 'campaign'
                ? this.campaignPrimaryBtn
                : this.challengeAcceptBtn;
        const preferredIndex = buttons.indexOf(preferred);
        if (preferredIndex >= 0 && !preferred?.disabled) return preferredIndex;
        return buttons.findIndex((button) => !button.disabled);
    }

    resetKeyboardNav() {
        const buttons = this.getVisibleActions();
        resetMenuKeyboardState(this._menuKeyboardState, buttons, {
            preferredIndex: this.getPreferredIndex(buttons),
            container: this.activePane,
            focusPreferred: false,
        });
    }

    focus() {
        const buttons = this.getVisibleActions();
        const preferredIndex = this.getPreferredIndex(buttons);
        buttons[preferredIndex]?.focus?.();
    }

    isKeyboardNavBlocked() {
        return BLOCKING_OVERLAY_IDS.some((id) => (
            document.getElementById(id)?.classList?.contains('active')
        ));
    }

    handleKeydown(event) {
        if (!this.overlay || this.overlay.style.display === 'none' || this.isKeyboardNavBlocked()) return;
        if (event.key === 'Escape' && this.mode !== 'home') {
            event.preventDefault?.();
            event.stopPropagation?.();
            this.onBack?.(this.mode);
            return;
        }
        handleMenuListKeydown(event, {
            buttons: this.getVisibleActions(),
            state: this._menuKeyboardState,
            container: this.activePane,
        });
    }

    handlePointerMove(event) {
        if (!this._menuKeyboardState.keyboardNavActive) return;
        if (event.pointerType && event.pointerType !== 'mouse') return;
        dismissMenuKeyboardCue(this._menuKeyboardState, this.getVisibleActions(), {
            container: this.activePane,
            preferredIndex: this.getPreferredIndex(),
        });
    }

    renderCampaign() {
        if (this.campaignPrimaryBtn) {
            this.campaignPrimaryBtn.hidden = this.campaignState.complete;
            this.campaignPrimaryBtn.disabled = this.campaignState.complete
                || (!this.campaignState.nextStage && !this._campaignPrimaryLoading);
            setText(
                this.campaignPrimaryBtn.querySelector('.main-menu__label'),
                this.campaignState.primaryLabel || (this._campaignPrimaryLoading ? 'Loading' : ''),
            );
        }
    }

    setCampaignPrimaryLoading(isLoading) {
        this._campaignPrimaryLoading = Boolean(isLoading);
        const btn = this.campaignPrimaryBtn;
        if (!btn) return;
        btn.classList.toggle('is-loading', this._campaignPrimaryLoading);
        btn.toggleAttribute('aria-busy', this._campaignPrimaryLoading);
        let spinner = btn.querySelector('.main-menu__spinner');
        if (this._campaignPrimaryLoading) {
            if (!spinner) {
                spinner = document.createElement('span');
                spinner.className = 'modal-rank-spinner main-menu__spinner';
                spinner.setAttribute('aria-hidden', 'true');
                btn.appendChild(spinner);
            }
            btn.disabled = false;
            if (!this.campaignState.primaryLabel) {
                setText(btn.querySelector('.main-menu__label'), 'Loading');
            }
        } else {
            spinner?.remove();
            this.renderCampaign();
        }
    }

    renderChallenge() {
        setText(document.getElementById('challenge-track-label'), this.challengeState.trackLabel);
        setText(document.getElementById('challenge-target-time'), this.challengeState.targetTimeLabel);
        const medal = document.getElementById('challenge-target-medal');
        if (medal) {
            medal.hidden = !this.challengeState.medal;
            medal.textContent = this.challengeState.medal || '';
            medal.dataset.medal = this.challengeState.medal?.toLowerCase() || '';
        }
        const message = document.getElementById('challenge-sign-in-message');
        if (message) {
            message.hidden = !this.challengeState.statusMessage;
            message.textContent = this.challengeState.statusMessage;
        }
        if (this.challengeAcceptBtn) {
            this.challengeAcceptBtn.disabled = !this.challengeState.canAccept;
            setText(
                this.challengeAcceptBtn.querySelector('.main-menu__label'),
                this.challengeState.signedIn ? 'Accept' : 'Sign in required',
            );
        }
        if (this.mode === 'challenge') this.syncLobbySubheadDetail();
    }
}
