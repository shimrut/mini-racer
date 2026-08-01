import {
    collectVisibleActionButtons,
    createMenuKeyboardState,
    dismissMenuKeyboardCue,
    getMenuNavDirection,
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

/** Fades the label on real text changes only — the button re-renders on every carousel step, and fading identical text would flicker while just browsing. The layout read forces the class off for a frame so the animation can restart. */
function setSwappingText(element, value) {
    if (!element || element.textContent === value) return;
    element.textContent = value;
    element.classList.remove('is-swapping');
    void element.offsetWidth;
    element.classList.add('is-swapping');
}

export class LobbyUi {
    constructor({
        onSelectDaily = null,
        onCarouselNavigate = null,
        onSelectCampaign = null,
        onBack = null,
        onOpenStandings = null,
        onStartDaily = null,
        onStartCampaign = null,
        onAcceptChallenge = null,
    } = {}) {
        this.onSelectDaily = onSelectDaily;
        this.onCarouselNavigate = onCarouselNavigate;
        this.onSelectCampaign = onSelectCampaign;
        this.onBack = onBack;
        this.onOpenStandings = onOpenStandings;
        this.onStartDaily = onStartDaily;
        this.onStartCampaign = onStartCampaign;
        this.onAcceptChallenge = onAcceptChallenge;
        this.mode = 'home';
        this.campaignState = normalizeCampaignLobbyState();
        this.challengeState = normalizeChallengeLobbyState();
        this._campaignPrimaryLoading = false;
        this._campaignSelectedStage = null;
        this._menuKeyboardState = createMenuKeyboardState();
        this._paneTransitionGeneration = 0;
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
        document.querySelectorAll?.('[data-lobby-back]')?.forEach((button) => {
            button.addEventListener('click', () => this.onBack?.(this.mode));
        });
        document.getElementById('lobby-mode-standings-btn')
            ?.addEventListener('click', () => this.onOpenStandings?.(this.mode));
        document.getElementById('lobby-back-btn')
            ?.addEventListener('click', () => this.onBack?.(this.mode));
        document.getElementById('daily-challenge-start-btn')
            ?.addEventListener('click', () => this.onStartDaily?.());
        this.campaignPrimaryBtn?.addEventListener('click', () => {
            // Resolve the stage after bootstrap is ready — do not pass a stale one.
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

    beginPaneTransition() {
        const overlay = this.overlay;
        if (!overlay) return;

        const generation = ++this._paneTransitionGeneration;
        overlay.classList?.add?.('is-lobby-transitioning');
        overlay.setAttribute?.('aria-busy', 'true');

        const schedule = typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame.bind(globalThis)
            : (callback) => setTimeout(callback, 0);
        schedule(() => {
            schedule(() => {
                if (generation !== this._paneTransitionGeneration) return;
                overlay.classList?.remove?.('is-lobby-transitioning');
                overlay.removeAttribute?.('aria-busy');
            });
        });
    }

    showPane(mode) {
        if (!LOBBY_MODES.includes(mode)) return false;
        const previousMode = this.mode;
        if (previousMode !== mode) this.beginPaneTransition();
        this.mode = mode;
        for (const candidate of LOBBY_MODES) {
            const pane = document.getElementById(`lobby-${candidate}-pane`);
            if (!pane) continue;
            const isActive = candidate === mode;
            pane.hidden = !isActive;
            pane.classList.toggle('is-active', isActive);
            pane.setAttribute('aria-hidden', String(!isActive));
        }
        if (document.body?.dataset) {
            document.body.dataset.lobbyMode = mode;
            if (mode === 'home' && previousMode !== 'home') {
                document.body.dataset.lobbyHomeReturned = 'true';
            }
        }
        this.updateModeLabel(mode);
        this.syncModeToolbarState();
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
            this.syncLobbySubheadDetail();
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
        this.syncLobbySubheadDetail();
    }

    /**
     * Only Challenge has a detail line left: it names the opponent, which is
     * nowhere else on the screen. Daily's track name is on the carousel card.
     */
    syncLobbySubheadDetail() {
        const track = document.querySelector('[data-lobby-mode-track]');
        if (!track) return;
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

    syncModeToolbarState() {
        const standings = document.getElementById('lobby-mode-standings-btn');
        if (!standings) return;
        standings.disabled = this.mode === 'campaign'
            && this._campaignSelectedStage?.unlocked === false;
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
        return [
            ...collectVisibleActionButtons(this.activePane, '[data-lobby-action]'),
            ...collectVisibleActionButtons(
                document.querySelector?.('.lobby-header'),
                '[data-lobby-action]',
            ),
        ];
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
        if (this.overlay?.classList?.contains?.('is-race-start-exiting')
            || this.overlay?.classList?.contains?.('is-lobby-transitioning')) {
            return true;
        }
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
        // The picker panes own the horizontal axis: A/D and the arrows drive the
        // track carousel, so they must not be spent on spatial menu navigation.
        if (this.handleCarouselKeydown(event)) return;
        handleMenuListKeydown(event, {
            buttons: this.getVisibleActions(),
            state: this._menuKeyboardState,
            container: this.activePane,
        });
    }

    handleCarouselKeydown(event) {
        if (this.mode !== 'daily' && this.mode !== 'campaign') return false;
        if (!this.onCarouselNavigate) return false;
        if (event.ctrlKey || event.metaKey || event.altKey) return false;
        const tag = event.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;

        const direction = getMenuNavDirection(event.key);
        if (direction !== 'left' && direction !== 'right') return false;
        if (!this.onCarouselNavigate(this.mode, direction)) return false;

        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
    }

    handlePointerMove(event) {
        if (!this._menuKeyboardState.keyboardNavActive) return;
        if (event.pointerType && event.pointerType !== 'mouse') return;
        dismissMenuKeyboardCue(this._menuKeyboardState, this.getVisibleActions(), {
            container: this.activePane,
            preferredIndex: this.getPreferredIndex(),
        });
    }

    /** The carousel drives the primary action, so it has to say which stage. */
    setCampaignSelectedStage(stage = null) {
        this._campaignSelectedStage = stage;
        this.renderCampaign();
        this.syncModeToolbarState();
    }

    /**
     * The button races whatever the carousel has centred, so it says only
     * whether that stage can be raced — never where the campaign as a whole is.
     */
    getCampaignPrimaryLabel() {
        const stage = this._campaignSelectedStage;
        if (stage) return stage.unlocked ? 'Start Race' : 'Locked';
        return this.campaignState.primaryLabel
            || (this._campaignPrimaryLoading ? 'Loading' : '');
    }

    renderCampaign() {
        if (!this.campaignPrimaryBtn) return;
        const stage = this._campaignSelectedStage;
        this.campaignPrimaryBtn.hidden = false;
        this.campaignPrimaryBtn.disabled = this._campaignPrimaryLoading
            ? false
            : (stage
                ? !stage.unlocked
                // No selection yet, so the button can only go on whether the
                // campaign has anything raceable in it at all.
                : !this.campaignState.stages?.some((entry) => entry.unlocked));
        setSwappingText(
            this.campaignPrimaryBtn.querySelector('.main-menu__label'),
            this.getCampaignPrimaryLabel(),
        );
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
                setSwappingText(btn.querySelector('.main-menu__label'), 'Loading');
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
