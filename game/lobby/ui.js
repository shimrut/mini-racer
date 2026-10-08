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
import { getLoadedClientTrack, loadClientTrack } from '../track/client-registry.js';
import { TRACK_GROUNDS, getStoredTrackGroundKey } from '../track/grounds.js';
import { setButtonBlock, setText } from '../ui/dom.js';
import { campaignHasSeriesChoice, getCampaignSeries } from '../campaign/manifest.js';
import { buildCampaignSeriesRows, renderCampaignSeriesList } from './campaign-series-screen.js';
import { COMMUNITY_VISIBLE } from '../community/visibility.js';

const LOBBY_MODES = ['home', 'daily', 'campaign', 'community', 'challenge'];
const TOGGLE_MODES = ['daily', 'campaign'];
const BLOCKING_OVERLAY_IDS = [
    'modal',
    'settings-modal',
    'garage-modal',
    'daily-playlist-modal',
];

function setAvatar(element, url, label) {
    applyAvatar(element, url, { alt: label, genericClass: 'challenge-avatar--generic' });
}

// "2 Laps", or "2 Laps · Dirt" on a track that is not tarmac.
function formatLapsAndGroundLabel(laps, groundLabel, separator = ' · ') {
    return [formatLapsLabel(laps), groundLabel].filter(Boolean).join(separator);
}

function setSubheadSelection(element, trackName, laps, groundLabel = null) {
    if (!element) return;
    const safeTrackName = typeof trackName === 'string' ? trackName.trim() : '';
    const safeLaps = Number.isInteger(laps) && laps > 0 ? laps : null;
    const lapsLabel = safeLaps === null ? '' : formatLapsAndGroundLabel(safeLaps, groundLabel);
    element.hidden = !safeTrackName;

    const trackElement = element.querySelector?.('.lobby-mode-selection__track');
    const lapsElement = element.querySelector?.('.lobby-mode-selection__laps');
    if (!trackElement || !lapsElement) {
        element.textContent = safeTrackName;
        return;
    }
    trackElement.textContent = safeTrackName;
    lapsElement.hidden = !safeTrackName || safeLaps === null;
    lapsElement.textContent = lapsElement.hidden ? '' : lapsLabel;
}

function setRaceBriefText(element, trackName, laps, groundLabel = null) {
    if (!element) return;
    const safeTrackName = typeof trackName === 'string' ? trackName.trim() : '';
    const safeLaps = Number.isInteger(laps) && laps > 0 ? laps : null;
    // En spaces match the gap around the separator after the track name.
    const lapsLabel = safeLaps === null
        ? ''
        : formatLapsAndGroundLabel(safeLaps, groundLabel, '\u2002·\u2002');

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
        onSelectCommunity = null,
        onLoadMoreCommunity = null,
        onRefreshCommunity = null,
        onStartCommunity = null,
        onOpenCampaignSeries = null,
        onBackToCampaignSeries = null,
        onBack = null,
        onOpenStandings = null,
        onOpenTracks = null,
        onStartDaily = null,
        onStartCampaign = null,
        onAcceptChallenge = null,
        onRetryChallenge = null,
        onRenderChallengePreview = null,
    } = {}) {
        this.onSelectDaily = onSelectDaily;
        this.onCarouselNavigate = onCarouselNavigate;
        this.onSelectCampaign = onSelectCampaign;
        this.onSelectCommunity = onSelectCommunity;
        this.onLoadMoreCommunity = onLoadMoreCommunity;
        this.onRefreshCommunity = onRefreshCommunity;
        this.onStartCommunity = onStartCommunity;
        this._openCampaignSeries = (seriesId) => onOpenCampaignSeries?.(seriesId);
        this.onBackToCampaignSeries = onBackToCampaignSeries;
        this.onBack = onBack;
        this.onOpenStandings = onOpenStandings;
        this.onOpenTracks = onOpenTracks;
        this.onStartDaily = onStartDaily;
        this.onStartCampaign = onStartCampaign;
        this.onAcceptChallenge = onAcceptChallenge;
        this.onRetryChallenge = onRetryChallenge;
        this.onRenderChallengePreview = onRenderChallengePreview;
        this.mode = 'home';
        this.campaignState = normalizeCampaignLobbyState();
        this.challengeState = normalizeChallengeLobbyState();
        this.communityMaps = [];
        this.communitySelectedMapId = null;
        this.communityNextCursor = null;
        this.communityLoading = false;
        this.communityStartPending = false;
        this.communityError = null;
        this.communityStartError = null;
        this._campaignPrimaryLoading = false;
        this._campaignSelectedStage = null;
        this._dailySelectedTrackName = null;
        this._dailySelectedLaps = null;
        this._dailySelectedTrackKey = null;
        this._groundLabelLoads = new Set();
        this._campaignSelectedBillingLabel = null;
        this._dailyStartError = null;
        this._campaignStartError = null;
        // null: no selected race. false: its track is not prepared yet, so
        // Start stays disabled. The error state keeps Retry Start enabled.
        this._dailyTrackReady = null;
        this._campaignTrackReady = null;
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
    get communityPrimaryBtn() { return document.getElementById('community-primary-btn'); }
    get campaignSeriesList() { return document.getElementById('campaign-series-list'); }

    // The Campaign screen shows the series list first, then the stages of one series.
    isCampaignSeriesView() {
        return this.mode === 'campaign' && this.campaignState?.view === 'series';
    }
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
        const communityButton = document.getElementById('lobby-home-community-btn');
        if (communityButton) communityButton.hidden = !COMMUNITY_VISIBLE;
        communityButton?.addEventListener('click', () => this.onSelectCommunity?.());
        document.getElementById('community-load-more-btn')
            ?.addEventListener('click', () => this.onLoadMoreCommunity?.());
        document.getElementById('community-retry-btn')
            ?.addEventListener('click', () => this.onRefreshCommunity?.());
        this.communityPrimaryBtn?.addEventListener('click', () => {
            this.communityStartError = null;
            this.renderCommunity();
            this.onStartCommunity?.(this.communitySelectedMapId);
        });
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
        document.getElementById('lobby-mode-tracks-btn')
            ?.addEventListener('click', () => this.onOpenTracks?.(this.mode));
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
        this.renderCampaignView();
    }

    showCommunity() {
        this.renderCommunity();
        this.showPane('community');
    }

    setCommunityMaps({ maps = [], nextCursor = null, loading = false, error = null } = {}) {
        this.communityMaps = maps;
        this.communityNextCursor = nextCursor;
        this.communityLoading = loading;
        this.communityError = error;
        if (!maps.some((map) => map.id === this.communitySelectedMapId)) {
            this.communitySelectedMapId = maps[0]?.id || null;
        }
        this.renderCommunity();
    }

    setCommunityStartPending(pending) {
        this.communityStartPending = Boolean(pending);
        this.renderCommunity();
    }

    setCommunityStartError(message) {
        this.communityStartError = message;
        this.renderCommunity();
    }

    selectCommunityMap(id) {
        if (!this.communityMaps.some((map) => map.id === id)) return;
        this.communitySelectedMapId = id;
        this.communityStartError = null;
        this.renderCommunity();
    }

    renderCommunity() {
        const list = document.getElementById('community-map-list');
        if (list) {
            list.replaceChildren();
            for (const map of this.communityMaps) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'community-map';
                button.dataset.lobbyAction = '';
                button.setAttribute('aria-pressed', String(map.id === this.communitySelectedMapId));
                const title = document.createElement('strong');
                title.textContent = map.name || 'Untitled map';
                const author = document.createElement('span');
                const authorName = typeof map.authorName === 'string' && map.authorName.trim()
                    ? map.authorName.trim().replace(/^u\//, '') : 'a moderator';
                author.textContent = `by u/${authorName}`;
                button.append(title, author);
                button.addEventListener('click', () => this.selectCommunityMap(map.id));
                list.appendChild(button);
            }
        }
        const message = document.getElementById('community-list-message');
        if (message) {
            message.textContent = this.communityError
                || (this.communityLoading ? 'Loading maps…'
                    : this.communityMaps.length ? '' : 'No published maps yet.');
            message.hidden = !message.textContent;
        }
        const retry = document.getElementById('community-retry-btn');
        if (retry) retry.hidden = !this.communityError;
        const more = document.getElementById('community-load-more-btn');
        if (more) {
            more.hidden = !this.communityNextCursor;
            more.disabled = this.communityLoading;
        }
        const selected = this.communityMaps.find((map) => map.id === this.communitySelectedMapId);
        const start = this.communityPrimaryBtn;
        if (start) {
            start.disabled = !selected || this.communityStartPending;
            setSwappingText(start.querySelector('.main-menu__label'),
                this.communityStartPending ? 'Loading map…' : 'Start Race');
            setRaceBriefText(start.querySelector('.main-menu__race-brief'), selected?.name, 1);
        }
        this.renderRaceStartMessage('community-start-message', this.communityStartError);
        if (this.mode === 'community') this.syncLobbySubheadDetail();
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
                if (mode !== 'campaign') delete document.body.dataset.campaignView;
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
        if (mode === 'community') {
            if (subhead) subhead.hidden = false;
            if (toggle) toggle.hidden = true;
            label.hidden = false;
            label.textContent = 'Community';
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
        const campaignButton = document.getElementById('lobby-switch-campaign-btn');
        const selectedSeries = this.campaignState.series?.find(
            (series) => series.id === this.campaignState.seriesId,
        ) ?? getCampaignSeries(this.campaignState.seriesId);
        const campaignLabel = this.mode === 'campaign' && !this.isCampaignSeriesView()
            ? selectedSeries?.name?.trim() || 'Campaign'
            : 'Campaign';
        setText(campaignButton?.querySelector('.lobby-mode-switch__label'), campaignLabel);
        if (campaignButton) campaignButton.title = campaignLabel;
        const querySelector = document.querySelector?.bind(document);
        const track = querySelector?.('[data-lobby-mode-track]') || null;
        const selection = querySelector?.('[data-lobby-mode-selection]') || null;
        const rule = querySelector?.('[data-lobby-subhead-rule]') || null;
        if (track) {
            track.hidden = true;
            track.textContent = '';
        }
        const billingLabel = this.mode === 'daily'
            ? this._dailySelectedTrackName?.trim() || null
            : this.mode === 'campaign'
                ? this._campaignSelectedBillingLabel
                : this.mode === 'challenge'
                    ? this.challengeState?.trackName?.trim() || null
                    : this.mode === 'community'
                        ? this.communityMaps.find((map) => map.id === this.communitySelectedMapId)?.name || null
                    : null;
        const billingLaps = this.mode === 'daily'
            ? this._dailySelectedLaps
            : this.mode === 'campaign'
                ? this.getCampaignPrimaryLaps()
                : this.mode === 'challenge'
                    ? this.challengeState?.laps ?? null
                    : this.mode === 'community'
                        ? 1
                    : null;
        const billingTrackKey = this.mode === 'daily'
            ? this._dailySelectedTrackKey
            : this.mode === 'campaign'
                ? this.getCampaignPrimaryTrackKey()
                : this.mode === 'challenge'
                    ? this.challengeState?.trackKey ?? null
                    : null;
        if (this.mode === 'home') {
            if (rule) rule.hidden = true;
            setSubheadSelection(selection, null, null);
            return;
        }
        if (rule) rule.hidden = false;
        setSubheadSelection(selection, billingLabel, billingLaps, this.getGroundLabel(billingTrackKey));
        if (this.isCampaignSeriesView() && selection) selection.hidden = true;
    }

    // The ground name of a non-tarmac track, or null. The name lives in the
    // track definition, so an unloaded track loads first and then repaints.
    getGroundLabel(trackKey) {
        if (typeof trackKey !== 'string' || !trackKey) return null;
        const track = getLoadedClientTrack(trackKey);
        if (!track) {
            if (!this._groundLabelLoads.has(trackKey)) {
                this._groundLabelLoads.add(trackKey);
                void loadClientTrack(trackKey).then((loaded) => {
                    if (!loaded || getStoredTrackGroundKey(loaded) === null) return;
                    this.syncLobbySubheadDetail();
                    if (this.mode === 'daily') this.renderDaily();
                    if (this.mode === 'campaign') this.renderCampaign();
                    if (this.mode === 'challenge') this.renderChallenge();
                }).catch(() => {});
            }
            return null;
        }
        const groundKey = getStoredTrackGroundKey(track);
        return groundKey === null ? null : TRACK_GROUNDS[groundKey].label;
    }

    getMode() {
        return this.mode;
    }

    syncModeToolbarState() {
        const standings = document.getElementById('lobby-mode-standings-btn');
        if (!standings) return;
        // The placeholder after the last Campaign stage has no standings.
        standings.disabled = this.mode === 'community'
            || (this.mode === 'campaign' && !this.isCampaignSeriesView()
                && this._campaignSelectedStage?.placeholder === true);
    }

    getPaneAriaLabel(mode = this.mode) {
        return {
            home: 'Mini Racer mode selection',
            daily: 'Daily challenge',
            campaign: 'Campaign',
            community: 'Community maps',
            challenge: 'Player challenge',
        }[mode] || 'Mini Racer lobby';
    }

    getPrimaryAction() {
        if (this.isCampaignSeriesView()) return null;
        const button = this.mode === 'daily'
            ? this.dailyPrimaryBtn
            : this.mode === 'campaign'
                ? this.campaignPrimaryBtn
                : this.mode === 'community'
                    ? this.communityPrimaryBtn
                : this.challengeAcceptBtn;
        if (!button || button.hidden) return null;
        return button;
    }

    getCarouselAction() {
        if (this.mode !== 'daily' && this.mode !== 'campaign') return null;
        if (this.isCampaignSeriesView()) return null;
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
        if (this.isCampaignSeriesView()) {
            const seriesRows = collectVisibleActionButtons(this.campaignSeriesList, '[data-lobby-action]')
                .filter((button) => !button.disabled)
                .map((button) => [button]);
            return [toolbar, toggle, ...seriesRows].filter((row) => row.length);
        }
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
        if (this.isCampaignSeriesView()) {
            const list = this.campaignSeriesList;
            const current = list?.querySelector?.('.campaign-series-row.is-current')
                ?? list?.querySelector?.('.campaign-series-row');
            const index = buttons.indexOf(current);
            if (index >= 0) return index;
        }
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
            if (this.mode === 'campaign' && !this.isCampaignSeriesView()
                && campaignHasSeriesChoice() && this.onBackToCampaignSeries) {
                this.onBackToCampaignSeries();
                return;
            }
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
        this._dailySelectedTrackKey = typeof card?.trackKey === 'string'
            ? card.trackKey
            : (typeof challenge?.trackKey === 'string' ? challenge.trackKey : null);
        this.syncLobbySubheadDetail();
        this.renderDaily();
    }

    renderRaceStartMessage(elementId, message) {
        const node = document.getElementById(elementId);
        if (!node) return;
        node.hidden = !message;
        node.textContent = message || '';
    }

    // Start stays disabled until the selected race track is prepared.
    setStartTrackReady(mode, ready) {
        const value = typeof ready === 'boolean' ? ready : null;
        if (mode === 'daily') {
            this._dailyTrackReady = value;
            this.renderDaily();
            return;
        }
        if (mode === 'campaign') {
            this._campaignTrackReady = value;
            this.renderCampaign();
        }
    }

    renderDaily() {
        setButtonBlock(
            this.dailyPrimaryBtn,
            'track',
            this._dailyTrackReady === false && !this._dailyStartError,
        );
        this.renderRaceStartMessage('daily-start-message', this._dailyStartError);
        setSwappingText(
            this.dailyPrimaryBtn?.querySelector('.main-menu__label'),
            this._dailyStartError ? 'Retry Start' : 'Start Race',
        );
        setRaceBriefText(
            this.dailyPrimaryBtn?.querySelector('.main-menu__race-brief'),
            this._dailySelectedTrackName,
            this._dailySelectedLaps,
            this.getGroundLabel(this._dailySelectedTrackKey),
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
        if (stage?.placeholder) return 'Soon';
        if (stage) return stage.unlocked ? 'Start Race' : 'Locked';
        return this.campaignState.primaryLabel
            || (this._campaignPrimaryLoading ? 'Loading' : '');
    }

    getCampaignPrimaryLaps() {
        const stage = this._campaignSelectedStage || this.campaignState.nextStage;
        return stage?.laps ?? stage?.lapCount ?? null;
    }

    getCampaignPrimaryTrackKey() {
        const stage = this._campaignSelectedStage || this.campaignState.nextStage;
        return typeof stage?.trackKey === 'string' ? stage.trackKey : null;
    }

    getCampaignPrimaryTrackName() {
        const stage = this._campaignSelectedStage || this.campaignState.nextStage;
        return typeof stage?.trackName === 'string' ? stage.trackName : null;
    }

    renderCampaignView() {
        const seriesView = this.isCampaignSeriesView();
        if (document.body?.dataset) {
            if (this.mode === 'campaign') document.body.dataset.campaignView = seriesView ? 'series' : 'stages';
            else delete document.body.dataset.campaignView;
        }
        const list = this.campaignSeriesList;
        const carousel = document.getElementById('campaign-carousel');
        const primaryRow = this.campaignPrimaryBtn?.closest?.('.lobby-primary-row') ?? null;
        if (list) list.hidden = !seriesView;
        if (carousel) carousel.hidden = seriesView;
        if (primaryRow) primaryRow.hidden = seriesView;
        if (seriesView) {
            renderCampaignSeriesList(list, buildCampaignSeriesRows(this.campaignState), {
                onChoose: this._openCampaignSeries,
            });
        }
    }

    renderCampaign() {
        this.renderCampaignView();
        this.renderRaceStartMessage('campaign-start-message', this._campaignStartError);
        if (!this.campaignPrimaryBtn) return;
        const stage = this._campaignSelectedStage;
        this.campaignPrimaryBtn.hidden = false;
        this.campaignPrimaryBtn.disabled = this._campaignPrimaryLoading
            ? true
            : (stage
                ? !stage.unlocked
                : !this.campaignState.stages?.some((entry) => entry.unlocked))
                || (this._campaignTrackReady === false && !this._campaignStartError);
        setSwappingText(
            this.campaignPrimaryBtn.querySelector('.main-menu__label'),
            this.getCampaignPrimaryLabel(),
        );
        setRaceBriefText(
            this.campaignPrimaryBtn.querySelector('.main-menu__race-brief'),
            this.getCampaignPrimaryTrackName(),
            this.getCampaignPrimaryLaps(),
            this.getGroundLabel(this.getCampaignPrimaryTrackKey()),
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
            btn.disabled = true;
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
            this.getGroundLabel(this.challengeState.trackKey),
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
        const viewerFigures = document.getElementById('challenge-viewer-figures');
        const viewerBestTime = document.getElementById('challenge-viewer-best-time');
        const hasViewerBest = this.challengeState.viewerBestTimeMs != null;
        if (viewerFigures) viewerFigures.hidden = !hasViewerBest;
        setText(viewerBestTime, this.challengeState.viewerBestTimeLabel || '');
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
