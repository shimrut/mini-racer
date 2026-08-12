import {
    applyMenuSelection,
    collectVisibleActionButtons,
    createMenuKeyboardState,
    dismissMenuKeyboardCue,
    findSpatialMenuIndex,
    getMenuNavDirection,
    handleMenuListKeydown,
    resetMenuKeyboardState,
} from '../ui/menu-keyboard-nav.js';
import {
    normalizeCampaignLobbyState,
    normalizeChallengeLobbyState,
} from './service.js';
import { applyAvatar } from '../ui/avatar.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';
import { formatLapsLabel } from '../shared/laps-label.js';

const LOBBY_MODES = ['home', 'daily', 'campaign', 'challenge'];
// Daily and Campaign share the same header, background track and pane layout, so
// switching between them only needs the mode switch to slide and the pane to
// swap. The full-overlay veil and the document view transition are for hand-offs
// that reload the background track (anything through Home); here they blank or
// cross-fade the whole lobby over content that barely changed.
const TOGGLE_MODES = ['daily', 'campaign'];
const BLOCKING_OVERLAY_IDS = [
    'modal',
    'settings-modal',
    'garage-modal',
    'daily-playlist-modal',
];

function setText(element, value) {
    if (element) element.textContent = value;
}

function setAvatar(element, url, label) {
    applyAvatar(element, url, { alt: label, genericClass: 'challenge-avatar--generic' });
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

    const brief = [safeTrackName, lapsLabel].filter(Boolean).join(' · ');
    element.hidden = !brief;
    element.textContent = brief;
}

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
        onRetryChallenge = null,
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
        this.onRetryChallenge = onRetryChallenge;
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
        this._dailyStartError = null;
        this._campaignStartError = null;
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
        document.getElementById('challenge-won-daily-btn')
            ?.addEventListener('click', () => this.onSelectDaily?.());
        document.getElementById('challenge-won-campaign-btn')
            ?.addEventListener('click', () => this.onSelectCampaign?.());
        document.querySelectorAll?.('[data-lobby-back]')?.forEach((button) => {
            button.addEventListener('click', () => this.onBack?.(this.mode));
        });
        document.getElementById('lobby-mode-standings-btn')
            ?.addEventListener('click', () => this.onOpenStandings?.(this.mode));
        document.getElementById('lobby-back-btn')
            ?.addEventListener('click', () => this.onBack?.(this.mode));
        document.getElementById('daily-challenge-start-btn')
            ?.addEventListener('click', () => {
                this.clearRaceStartError('daily');
                this.onStartDaily?.();
            });
        this.campaignPrimaryBtn?.addEventListener('click', () => {
            this.clearRaceStartError('campaign');
            this.onStartCampaign?.();
        });
        this.challengeAcceptBtn?.addEventListener('click', () => {
            if (this.challengeState.canRetry) {
                if (this.challengeState.challengeLoading) return;
                this.onRetryChallenge?.(this.challengeState);
                return;
            }
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

    isToggleSwap(previousMode, mode) {
        return previousMode !== mode
            && TOGGLE_MODES.includes(previousMode)
            && TOGGLE_MODES.includes(mode);
    }

    showPane(mode) {
        if (!LOBBY_MODES.includes(mode)) return false;
        const previousMode = this.mode;
        const toggleSwap = this.isToggleSwap(previousMode, mode);
        if (previousMode !== mode && !toggleSwap) this.beginPaneTransition();
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
                // Stays on the body until the next swap replaces it — clearing it
                // once the entrance finishes would re-apply the pane animation and
                // replay it. Only a real swap writes one: the value decides whether
                // `.lobby-pane` or `.track-carousel` carries the entrance, so
                // rewriting it to repaint the mode already on screen moves the
                // animation between them and restarts it.
                if (previousMode !== mode) {
                    document.body.dataset.lobbyPaneSwap = toggleSwap ? 'toggle' : 'mode';
                }
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
                if (this.mode === 'challenge') this.renderChallengePreview();
            });
        };

        if (
            document.startViewTransition
            && previousMode !== mode
            && previousMode !== 'home'
            && !toggleSwap
        ) {
            document.documentElement.classList.add('is-lobby-view-transition');
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
        // Home is where the wordmark already leads, so it is inert there rather
        // than a button that tabs to nothing.
        const titleHome = document.getElementById('lobby-title-home-btn');
        if (titleHome) titleHome.disabled = mode === 'home';
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
            label.textContent = this.challengeState?.beaten ? 'Beaten' : 'Challenge';
            this.syncLobbySubheadDetail();
            return;
        }
        if (subhead) subhead.hidden = true;
        if (toggle) toggle.hidden = true;
        label.hidden = false;
        label.textContent = '';
        this.syncLobbySubheadDetail();
    }

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
                    ? this.challengeState?.trackName?.trim() || null
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

    getPrimaryAction() {
        const button = this.mode === 'daily'
            ? this.dailyPrimaryBtn
            : this.mode === 'campaign'
                ? this.campaignPrimaryBtn
                : this.challengeAcceptBtn;
        if (!button || button.hidden) return null;
        return button;
    }

    getCarouselAction() {
        if (this.mode !== 'daily' && this.mode !== 'campaign') return null;
        const carousel = document.getElementById(`${this.mode}-carousel`);
        if (!carousel || carousel.hidden) return null;
        return carousel;
    }

    getNavRows() {
        const toolbar = collectVisibleActionButtons(
            document.querySelector?.('.lobby-mode-toolbar'),
            '[data-lobby-action]',
        );
        const toggle = collectVisibleActionButtons(
            document.querySelector?.('[data-lobby-mode-switch]'),
            '[data-lobby-action]',
        );
        const carousel = this.getCarouselAction();
        const start = this.getPrimaryAction();
        return [
            toolbar,
            toggle,
            carousel ? [carousel] : [],
            start ? [start] : [],
        ].filter((row) => row.length);
    }

    getVisibleActions() {
        if (this.mode === 'daily' || this.mode === 'campaign') {
            return this.getNavRows().flat();
        }
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
        const preferredIndex = buttons.indexOf(this.getPrimaryAction());
        if (preferredIndex >= 0) return preferredIndex;
        return buttons.findIndex((button) => !button.disabled);
    }

    getSelectedNavAction(buttons) {
        const index = this._menuKeyboardState.selectedIndex;
        if (typeof index === 'number' && index >= 0 && index < buttons.length) {
            return buttons[index];
        }
        return this.getPrimaryAction();
    }

    shouldNavigateCarousel(buttons) {
        if (!this._menuKeyboardState.keyboardNavActive) return true;
        const selected = this.getSelectedNavAction(buttons);
        return selected === this.getPrimaryAction() || selected === this.getCarouselAction();
    }

    selectNavAction(buttons, target) {
        const nextIndex = buttons.indexOf(target);
        if (nextIndex < 0) return;
        this._menuKeyboardState.selectedIndex = nextIndex;
        this._menuKeyboardState.keyboardNavActive = true;
        applyMenuSelection(buttons, nextIndex, { container: this.overlay });
    }

    moveWithinPickerRow(event, rows, buttons, direction) {
        const selected = this.getSelectedNavAction(buttons);
        const row = rows.find((candidate) => candidate.includes(selected)) || [];
        const currentIndex = row.indexOf(selected);
        const nextIndex = findSpatialMenuIndex(row, currentIndex, direction);
        if (nextIndex < 0) {
            if (!this._menuKeyboardState.keyboardNavActive && selected) {
                event.preventDefault?.();
                event.stopPropagation?.();
                this.selectNavAction(buttons, selected);
            }
            return;
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        this.selectNavAction(buttons, row[nextIndex]);
    }

    movePickerRow(event, rows, buttons, direction) {
        const selected = this.getSelectedNavAction(buttons);
        const rowIndex = rows.findIndex((row) => row.includes(selected));
        const nextRowIndex = rowIndex + (direction === 'down' ? 1 : -1);
        if (rowIndex < 0 || nextRowIndex < 0 || nextRowIndex >= rows.length) {
            if (!this._menuKeyboardState.keyboardNavActive && selected) {
                event.preventDefault?.();
                event.stopPropagation?.();
                this.selectNavAction(buttons, selected);
            }
            return;
        }
        const nextRow = rows[nextRowIndex];
        const subset = selected ? [selected, ...nextRow] : nextRow;
        const subsetIndex = selected ? findSpatialMenuIndex(subset, 0, direction) : -1;
        event.preventDefault?.();
        event.stopPropagation?.();
        this.selectNavAction(buttons, subsetIndex > 0 ? subset[subsetIndex] : nextRow[0]);
    }

    handlePickerKeydown(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const direction = getMenuNavDirection(event.key);
        const rows = this.getNavRows();
        const buttons = rows.flat();
        if (!buttons.length) return;

        if (direction === 'left' || direction === 'right') {
            if (this.shouldNavigateCarousel(buttons) && this.handleCarouselKeydown(event)) {
                return;
            }
            this.moveWithinPickerRow(event, rows, buttons, direction);
            return;
        }

        if (direction === 'up' || direction === 'down') {
            this.movePickerRow(event, rows, buttons, direction);
            return;
        }

        handleMenuListKeydown(event, {
            buttons,
            state: this._menuKeyboardState,
            container: this.overlay,
        });
    }

    resetKeyboardNav() {
        const buttons = this.getVisibleActions();
        resetMenuKeyboardState(this._menuKeyboardState, buttons, {
            preferredIndex: this.getPreferredIndex(buttons),
            container: this.overlay,
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
        if (this.mode === 'daily' || this.mode === 'campaign') {
            this.handlePickerKeydown(event);
            return;
        }
        handleMenuListKeydown(event, {
            buttons: this.getVisibleActions(),
            state: this._menuKeyboardState,
            container: this.overlay,
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
            container: this.overlay,
            preferredIndex: this.getPreferredIndex(),
        });
    }

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
        setSwappingText(
            this.dailyPrimaryBtn?.querySelector('.main-menu__label'),
            this._dailyStartError ? 'Retry Start' : 'Start Race',
        );
        setRaceBriefText(
            this.dailyPrimaryBtn?.querySelector('.main-menu__race-brief'),
            this._dailySelectedTrackName,
            this._dailySelectedLaps,
        );
    }

    setCampaignSelectedStage(stage = null) {
        this._campaignSelectedStage = stage;
        this._campaignSelectedBillingLabel = this.getCampaignPrimaryTrackName();
        this.syncLobbySubheadDetail();
        this.renderCampaign();
        this.syncModeToolbarState();
    }

    getCampaignPrimaryLabel() {
        if (this._campaignStartError) return 'Retry Start';
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

    setRaceStartError(mode, message = 'Track failed to load. Try again.') {
        const error = typeof message === 'string' && message.trim()
            ? message.trim()
            : 'Track failed to load. Try again.';
        if (mode === 'daily') {
            this._dailyStartError = error;
            this.renderDaily();
            return;
        }
        if (mode === 'campaign') {
            this._campaignStartError = error;
            this.renderCampaign();
        }
    }

    clearRaceStartError(mode) {
        if (mode === 'daily' && this._dailyStartError) {
            this._dailyStartError = null;
            this.renderDaily();
        }
        if (mode === 'campaign' && this._campaignStartError) {
            this._campaignStartError = null;
            this.renderCampaign();
        }
    }

    renderChallengePreview({ force = false } = {}) {
        const canvas = document.getElementById('challenge-track-preview');
        const trackKey = this.challengeState.trackKey;
        if (!canvas || !trackKey) return;
        this.onRenderChallengePreview?.(canvas, { trackKey, skin: null }, { force });
    }

    renderChallengeWin(beaten) {
        const hero = document.getElementById('challenge-won-hero');
        if (!hero) return;
        hero.hidden = !beaten;
        if (!beaten) return;

        setAvatar(
            document.getElementById('challenge-won-avatar'),
            this.challengeState.viewerAvatarUrl,
            'Your avatar',
        );
        const medal = document.getElementById('challenge-won-medal');
        if (medal && !medal.firstChild) {
            medal.appendChild(createMedalIconSvg('challenge', { className: 'medal-svg--hero' }));
        }
        const margin = this.challengeState.winMarginLabel;
        setText(
            document.getElementById('challenge-won-summary'),
            margin
                ? `You beat ${this.challengeState.challengerName} by ${margin}s.`
                : `You beat ${this.challengeState.challengerName}.`,
        );
    }

    renderChallenge() {
        setRaceBriefText(
            this.challengeAcceptBtn?.querySelector('.main-menu__race-brief'),
            this.challengeState.trackName,
            this.challengeState.laps,
        );
        setText(document.getElementById('challenge-target-time'), this.challengeState.targetTimeLabel);
        setText(
            document.getElementById('challenge-challenger-name'),
            this.challengeState.challengerName,
        );
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
        const beaten = Boolean(this.challengeState.beaten);
        const poster = document.getElementById('challenge-poster');
        if (poster) poster.hidden = beaten;
        if (!beaten) this.renderChallengePreview();
        this.renderChallengeWin(beaten);
        const wonCta = document.getElementById('challenge-won-cta');
        if (wonCta) wonCta.hidden = !beaten;
        const message = document.getElementById('challenge-sign-in-message');
        if (message) {
            message.hidden = beaten || !this.challengeState.statusMessage;
            message.textContent = this.challengeState.statusMessage;
        }
        if (this.challengeAcceptBtn) {
            this.challengeAcceptBtn.hidden = beaten;
            this.challengeAcceptBtn.disabled = (
                !this.challengeState.canAccept
                && !this.challengeState.canRetry
            ) || this.challengeState.challengeLoading;
            setText(
                this.challengeAcceptBtn.querySelector('.main-menu__label'),
                this.challengeState.challengeLoading
                    ? 'Loading…'
                    : this.challengeState.startError
                        ? 'Retry Start'
                    : this.challengeState.canRetry
                        ? 'Retry'
                        : this.challengeState.canRace
                            ? 'Start Challenge'
                            : 'Unavailable',
            );
        }
        if (this.mode === 'challenge') this.syncLobbySubheadDetail();
    }
}
