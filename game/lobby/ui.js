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

function appendStageText(parent, className, value) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = value;
    parent.appendChild(span);
    return span;
}

export class LobbyUi {
    constructor({
        onSelectDaily = null,
        onSelectCampaign = null,
        onBack = null,
        onStartDaily = null,
        onStartCampaign = null,
        onSelectCampaignStage = null,
        onOpenCampaignStandings = null,
        onAcceptChallenge = null,
    } = {}) {
        this.onSelectDaily = onSelectDaily;
        this.onSelectCampaign = onSelectCampaign;
        this.onBack = onBack;
        this.onStartDaily = onStartDaily;
        this.onStartCampaign = onStartCampaign;
        this.onSelectCampaignStage = onSelectCampaignStage;
        this.onOpenCampaignStandings = onOpenCampaignStandings;
        this.onAcceptChallenge = onAcceptChallenge;
        this.mode = 'home';
        this.campaignState = normalizeCampaignLobbyState();
        this.challengeState = normalizeChallengeLobbyState();
        this._menuKeyboardState = createMenuKeyboardState();
        this._bound = false;
        this._keydownHandler = (event) => this.handleKeydown(event);
        this._pointerMoveHandler = (event) => this.handlePointerMove(event);
    }

    get overlay() { return document.getElementById('start-overlay'); }
    get activePane() { return document.getElementById(`lobby-${this.mode}-pane`); }
    get campaignStageList() { return document.getElementById('campaign-stage-list'); }
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
        this.campaignPrimaryBtn?.addEventListener('click', () => {
            if (this.campaignState.complete || !this.campaignState.nextStage) return;
            this.onStartCampaign?.(this.campaignState.nextStage);
        });
        this.challengeAcceptBtn?.addEventListener('click', () => {
            if (!this.challengeState.canAccept) return;
            this.onAcceptChallenge?.(this.challengeState);
        });
        this.campaignStageList?.addEventListener('click', (event) => {
            const action = event.target?.closest?.('[data-campaign-stage-action]');
            if (!action || action.disabled) return;
            const stage = this.campaignState.stages.find((candidate) => candidate.id === action.dataset.stageId);
            if (!stage) return;
            if (action.dataset.campaignStageAction === 'standings') {
                this.onOpenCampaignStandings?.(stage);
            } else {
                this.onSelectCampaignStage?.(stage);
            }
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
        this.overlay?.setAttribute('aria-label', this.getPaneAriaLabel(mode));
        this.resetKeyboardNav();
        requestAnimationFrame(() => this.focus());
        return true;
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
        setText(document.getElementById('campaign-progress-label'), this.campaignState.progressLabel);
        const completeLabel = document.getElementById('campaign-complete-label');
        if (completeLabel) completeLabel.hidden = !this.campaignState.complete;
        if (this.campaignPrimaryBtn) {
            this.campaignPrimaryBtn.hidden = this.campaignState.complete;
            this.campaignPrimaryBtn.disabled = this.campaignState.complete || !this.campaignState.nextStage;
            setText(
                this.campaignPrimaryBtn.querySelector('.main-menu__label'),
                this.campaignState.primaryLabel || '',
            );
        }
        if (!this.campaignStageList) return;

        const fragment = document.createDocumentFragment();
        for (const stage of this.campaignState.stages) {
            const row = document.createElement('div');
            row.className = 'campaign-stage';
            row.classList.toggle('is-locked', !stage.unlocked);
            row.classList.toggle('is-selected', stage.selected);
            row.setAttribute('role', 'listitem');

            const stageButton = document.createElement('button');
            stageButton.type = 'button';
            stageButton.className = 'campaign-stage__race';
            stageButton.dataset.lobbyAction = '';
            stageButton.dataset.campaignStageAction = 'race';
            stageButton.dataset.stageId = stage.id;
            stageButton.disabled = !stage.unlocked;
            stageButton.setAttribute(
                'aria-label',
                `${stage.trackName}, ${stage.laps} ${stage.laps === 1 ? 'lap' : 'laps'}, ${stage.unlocked ? stage.bestTimeLabel : 'locked'}`,
            );
            appendStageText(stageButton, 'campaign-stage__number', stage.numberLabel);
            appendStageText(stageButton, 'campaign-stage__name', stage.trackName);
            appendStageText(
                stageButton,
                'campaign-stage__laps',
                `${stage.laps} ${stage.laps === 1 ? 'lap' : 'laps'}`,
            );
            appendStageText(
                stageButton,
                'campaign-stage__best',
                stage.unlocked ? stage.bestTimeLabel : 'Locked',
            );
            if (stage.medal) {
                const safeMedalClass = stage.medal.toLowerCase().replace(/[^a-z0-9_-]/g, '');
                appendStageText(
                    stageButton,
                    `campaign-stage__medal campaign-stage__medal--${safeMedalClass}`,
                    stage.medal,
                );
            }

            const standingsButton = document.createElement('button');
            standingsButton.type = 'button';
            standingsButton.className = 'campaign-stage__standings';
            standingsButton.dataset.lobbyAction = '';
            standingsButton.dataset.campaignStageAction = 'standings';
            standingsButton.dataset.stageId = stage.id;
            standingsButton.disabled = !stage.unlocked || !stage.standingsAvailable;
            standingsButton.setAttribute('aria-label', `${stage.trackName} standings`);
            standingsButton.textContent = 'Rank';

            row.append(stageButton, standingsButton);
            fragment.appendChild(row);
        }
        this.campaignStageList.replaceChildren(fragment);
    }

    renderChallenge() {
        setText(document.getElementById('challenge-opponent-name'), this.challengeState.opponentLabel);
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
                this.challengeState.signedIn ? 'Accept Challenge' : 'Sign in required',
            );
        }
    }
}
