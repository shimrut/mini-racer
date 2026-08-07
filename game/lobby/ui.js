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
import { AVATAR_PLACEHOLDER_SRC } from '../ui/avatar-placeholder.js';
import { formatLapsLabel } from '../shared/laps-label.js';

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

/**
 * A seat in the duel. An empty seat keeps its place with the default Snoo —
 * the viewer's side is empty for exactly the stranger this screen invites.
 */
function setAvatar(element, url, label) {
    if (!element) return;
    const empty = () => {
        element.src = AVATAR_PLACEHOLDER_SRC;
        element.alt = '';
        element.classList?.add?.('challenge-avatar--empty');
        element.setAttribute?.('aria-hidden', 'true');
    };
    if (!url) {
        element.onerror = null;
        empty();
        return;
    }
    element.onerror = () => {
        element.onerror = null;
        empty();
    };
    element.src = url;
    element.alt = label;
    element.classList?.remove?.('challenge-avatar--empty');
    element.setAttribute?.('aria-hidden', 'false');
}

function setRaceBriefText(element, trackName, laps) {
    if (!element) return;
    const safeTrackName = typeof trackName === 'string' ? trackName.trim() : '';
    const safeLaps = Number.isInteger(laps) && laps > 0 ? laps : null;
    const lapsLabel = safeLaps === null ? '' : formatLapsLabel(safeLaps);

    const trackElement = element.querySelector?.('.main-menu__race-brief-track');
    const separatorElement = element.querySelector?.('.main-menu__race-brief-separator');
    const lapsElement = element.querySelector?.('.main-menu__race-brief-laps');
    if (trackElement && separatorElement && lapsElement) {
        trackElement.hidden = !safeTrackName;
        trackElement.textContent = safeTrackName;
        separatorElement.hidden = !safeTrackName || safeLaps === null;
        lapsElement.hidden = safeLaps === null;
        lapsElement.textContent = lapsLabel;
        if (safeLaps === null) {
            lapsElement.removeAttribute?.('aria-label');
        } else {
            lapsElement.setAttribute?.('aria-label', lapsLabel);
        }
        element.hidden = !safeTrackName && safeLaps === null;
        element.setAttribute?.(
            'aria-label',
            [safeTrackName, lapsLabel].filter(Boolean).join(', '),
        );
        return;
    }

    // Keep a safe fallback for partial/legacy DOM fixtures while the shipped
    // markup uses the styled track and lap elements above.
    const brief = [safeTrackName, lapsLabel].filter(Boolean).join(' · ');
    element.hidden = !brief;
    element.textContent = brief;
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
        onRenderChallengePreview = null,
    } = {}) {
        this.onSelectDaily = onSelectDaily;
        this.onCarouselNavigate = onCarouselNavigate;
        this.onSelectCampaign = onSelectCampaign;
        this.onBack = onBack;
        this.onOpenStandings = onOpenStandings;
        this.onStartDaily = onStartDaily;
        this.onStartCampaign = onStartCampaign;
        this.onAcceptChallenge = onAcceptChallenge;
        this.onRenderChallengePreview = onRenderChallengePreview;
        this.mode = 'home';
        this.campaignState = normalizeCampaignLobbyState();
        this.challengeState = normalizeChallengeLobbyState();
        this._campaignPrimaryLoading = false;
        this._campaignSelectedStage = null;
        this._dailySelectedTrackName = null;
        this._dailySelectedLaps = null;
        this._dailySelectedBillingLabel = null;
        this._campaignSelectedBillingLabel = null;
        this._menuKeyboardState = createMenuKeyboardState();
        this._paneTransitionGeneration = 0;
        this._bound = false;
        this._keydownHandler = (event) => this.handleKeydown(event);
        this._pointerMoveHandler = (event) => this.handlePointerMove(event);
    }

    get overlay() { return document.getElementById('start-overlay'); }
    get activePane() { return document.getElementById(`lobby-${this.mode}-pane`); }
    get dailyPrimaryBtn() { return document.getElementById('daily-challenge-start-btn'); }
    get campaignPrimaryBtn() { return document.getElementById('campaign-primary-btn'); }
    get challengeAcceptBtn() { return document.getElementById('challenge-accept-btn'); }

    bind() {
        if (this._bound || typeof document === 'undefined') return;
        this._bound = true;
        document.getElementById('lobby-home-daily-btn')
            ?.addEventListener('click', () => this.onSelectDaily?.());
        document.getElementById('lobby-switch-daily-btn')
            ?.addEventListener('click', () => this.onSelectDaily?.());
        document.getElementById('lobby-home-campaign-btn')
            ?.addEventListener('click', () => this.onSelectCampaign?.());
        document.getElementById('lobby-switch-campaign-btn')
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
        globalThis.addEventListener?.('resize', () => {
            if (this.mode === 'challenge') this.renderChallengePreview();
        });
    }

    showHome() {
        this.showPane('home');
    }

    showDaily() {
        this.showPane('daily');
        this.renderDaily();
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

        const updateDom = () => {
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
            requestAnimationFrame(() => {
                this.focus();
                // The poster can only be measured once its pane is on screen.
                if (this.mode === 'challenge') this.renderChallengePreview();
            });
        };

        if (document.startViewTransition && previousMode !== mode && previousMode !== 'home') {
            document.documentElement.classList.add('is-lobby-view-transition');
            // Force layout recalculation to ensure the class is applied before capturing the old state
            void document.documentElement.offsetHeight;
            const transition = document.startViewTransition(() => updateDom());
            transition.finished.finally(() => {
                document.documentElement.classList.remove('is-lobby-view-transition');
            });
        } else {
            updateDom();
        }

        return true;
    }

    updateModeLabel(mode = this.mode) {
        const subhead = document.querySelector('[data-lobby-subhead]');
        const label = document.querySelector('[data-lobby-mode-label]');
        const toggle = document.querySelector('[data-lobby-mode-switch]');
        const switchDaily = document.getElementById('lobby-switch-daily-btn');
        const switchCampaign = document.getElementById('lobby-switch-campaign-btn');
        if (!label) return;
        if (mode === 'daily' || mode === 'campaign') {
            if (subhead) subhead.hidden = false;
            label.hidden = true;
            if (toggle) toggle.hidden = false;
            if (switchDaily && switchCampaign) {
                switchDaily.setAttribute('aria-pressed', String(mode === 'daily'));
                switchCampaign.setAttribute('aria-pressed', String(mode === 'campaign'));
            }
            this.syncLobbySubheadDetail();
            return;
        }
        if (mode === 'challenge') {
            if (subhead) subhead.hidden = false;
            if (toggle) toggle.hidden = true;
            label.hidden = false;
            label.textContent = 'Challenge';
            this.syncLobbySubheadDetail();
            return;
        }
        if (subhead) subhead.hidden = true;
        if (toggle) toggle.hidden = true;
        label.hidden = false;
        label.textContent = '';
        this.syncLobbySubheadDetail();
    }

    /**
     * Every mode screen bills itself on one line: what this is on the left, who
     * or when it is for on the right. Challenge names its opponent there, the
     * way Daily names its day and Campaign its stage.
     */
    syncLobbySubheadDetail() {
        const querySelector = document.querySelector?.bind(document);
        const track = querySelector?.('[data-lobby-mode-track]') || null;
        const selection = querySelector?.('[data-lobby-mode-selection]') || null;
        const rule = querySelector?.('[data-lobby-subhead-rule]') || null;
        if (track) {
            track.hidden = true;
            track.textContent = '';
        }
        const billingLabel = this.mode === 'daily'
            ? this._dailySelectedBillingLabel
            : this.mode === 'campaign'
                ? this._campaignSelectedBillingLabel
                : this.mode === 'challenge'
                    ? this.challengeState?.challengerName?.trim() || null
                    : null;
        if (this.mode === 'home') {
            if (rule) rule.hidden = true;
            if (selection) {
                selection.hidden = true;
                selection.textContent = '';
            }
            return;
        }
        if (rule) rule.hidden = false;
        if (selection) {
            selection.hidden = !billingLabel;
            selection.textContent = billingLabel || '';
        }
    }

    getMode() {
        return this.mode;
    }

    syncModeToolbarState() {
        const standings = document.getElementById('lobby-mode-standings-btn');
        if (!standings) return;
        // Standings are readable for every Campaign stage. Unlock state only
        // gates starting/submitting a race, not viewing its leaderboard.
        standings.disabled = false;
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

    /** The Daily carousel drives the lap sublabel on the primary action. */
    setDailySelectedChallenge(challenge = null, card = null) {
        this._dailySelectedTrackName = typeof card?.trackName === 'string'
            ? card.trackName
            : (typeof challenge?.trackName === 'string' ? challenge.trackName : null);
        this._dailySelectedLaps = Number.isInteger(card?.laps)
            ? card.laps
            : (Number.isInteger(challenge?.laps) ? challenge.laps : null);
        this._dailySelectedBillingLabel = typeof card?.billingLabel === 'string'
            ? card.billingLabel.trim() || null
            : null;
        this.syncLobbySubheadDetail();
        this.renderDaily();
    }

    renderDaily() {
        setRaceBriefText(
            this.dailyPrimaryBtn?.querySelector('.main-menu__race-brief'),
            this._dailySelectedTrackName,
            this._dailySelectedLaps,
        );
    }

    setCampaignSelectedStage(stage = null) {
        this._campaignSelectedStage = stage;
        // Keep the header identity on the same selected-stage source as the
        // Start Race brief below it.
        this._campaignSelectedBillingLabel = this.getCampaignPrimaryTrackName();
        this.syncLobbySubheadDetail();
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

    getCampaignPrimaryLaps() {
        const stage = this._campaignSelectedStage || this.campaignState.nextStage;
        return stage?.laps ?? stage?.lapCount ?? null;
    }

    getCampaignPrimaryTrackName() {
        const stage = this._campaignSelectedStage || this.campaignState.nextStage;
        return typeof stage?.trackName === 'string' ? stage.trackName : null;
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
        setRaceBriefText(
            this.campaignPrimaryBtn.querySelector('.main-menu__race-brief'),
            this.getCampaignPrimaryTrackName(),
            this.getCampaignPrimaryLaps(),
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

    /** The duel's poster: the circuit it is raced on, drawn the way every other lobby track is. */
    renderChallengePreview({ force = false } = {}) {
        const canvas = document.getElementById('challenge-track-preview');
        const trackKey = this.challengeState.trackKey;
        if (!canvas || !trackKey) return;
        this.onRenderChallengePreview?.(canvas, { trackKey, skin: null }, { force });
    }

    renderChallenge() {
        setRaceBriefText(
            this.challengeAcceptBtn?.querySelector('.main-menu__race-brief'),
            this.challengeState.trackName,
            this.challengeState.laps,
        );
        setText(document.getElementById('challenge-target-time'), this.challengeState.targetTimeLabel);
        setAvatar(
            document.getElementById('challenge-challenger-avatar'),
            this.challengeState.challengerAvatarUrl,
            `${this.challengeState.challengerName} avatar`,
        );
        setAvatar(
            document.getElementById('challenge-viewer-avatar'),
            this.challengeState.viewerAvatarUrl,
            'Your avatar',
        );
        this.renderChallengePreview();
        const message = document.getElementById('challenge-sign-in-message');
        if (message) {
            message.hidden = !this.challengeState.statusMessage;
            message.textContent = this.challengeState.statusMessage;
        }
        if (this.challengeAcceptBtn) {
            this.challengeAcceptBtn.disabled = !this.challengeState.canAccept;
            setText(
                this.challengeAcceptBtn.querySelector('.main-menu__label'),
                this.challengeState.canRace ? 'Accept' : 'Unavailable',
            );
        }
        if (this.mode === 'challenge') this.syncLobbySubheadDetail();
    }
}
