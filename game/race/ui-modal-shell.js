import { TRACK_MODE_DAILY_GP } from '../config.js';
import { getTrackName } from '../track/catalog.js';
import {
    buildModalRunsPayload,
    applyCombinedRankValue,
    buildScoreboardRankDisplay
} from './result-flow.js';
import { bindCombinedStatButton } from './ui-modal-content.js';
import {
    scheduleCombinedMedalEntranceAfterModal,
    shouldCelebrateMedalTier,
    renderChallengeFinishHero,
} from '../medals/medals.js';
import { closeModalElement, openModalElement, runModalHandoff } from '../ui/modal-handoff.js';
import { configureReusableModal } from '../ui/reusable-modal.js';
import {
    applyMenuSelection,
    collectVisibleActionButtons,
    createMenuKeyboardState,
    dismissMenuKeyboardCue,
    filterVisibleMenuItems,
    handleMenuListKeydown,
    resetMenuKeyboardState,
} from '../ui/menu-keyboard-nav.js';
import { scheduleAfterModalPaint } from '../ui/dom.js';

function isButtonElement(node) {
    return typeof HTMLButtonElement !== 'undefined' && node instanceof HTMLButtonElement;
}

const LEADERBOARD_SWIPE_MIN_DISTANCE_PX = 56;
const LEADERBOARD_SWIPE_AXIS_RATIO = 1.25;

function getSingleTouchPoint(touches) {
    if (!touches || touches.length !== 1) return null;
    const touch = touches[0];
    const x = Number(touch?.clientX);
    const y = Number(touch?.clientY);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function isLeaderboardSwipeControl(target) {
    return Boolean(target?.closest?.(
        '.leaderboard-day-rail, button, a, input, select, textarea, [role="button"], .leaderboard-row.is-shareable, .leaderboard-row.is-raceable'
    ));
}

function buildLeaderboardDayRailOptionsKey(payload) {
    const options = Array.isArray(payload?.leaderboardDayOptions)
        ? payload.leaderboardDayOptions
        : [];
    return JSON.stringify(options.map((option) => ({
        id: option?.challengeId ?? null,
        day: option?.dayLabel ?? null,
        month: option?.monthLabel ?? null,
        num: option?.dayNumberLabel ?? null,
    })));
}

function buildLeaderboardDayRailKey(payload) {
    return JSON.stringify({
        selectedId: payload?.selectedLeaderboardDayId ?? null,
        label: payload?.leaderboardRailLabel ?? null,
        options: JSON.parse(buildLeaderboardDayRailOptionsKey(payload)),
    });
}

function shouldRenderLeaderboardStandaloneIntro(payload) {
    const hasPersonalBestList = Array.isArray(payload?.lapTimesArray);
    const isLeaderboardOnly = Boolean(payload?.showGlobalLeaderboard) && !hasPersonalBestList;
    const isDailyChallengeLeaderboard = Boolean(payload?.scoreboardChallengeId)
        || Array.isArray(payload?.leaderboardDayOptions);
    return isLeaderboardOnly && isDailyChallengeLeaderboard;
}

export class ModalShell {
    constructor({
        content,
        getLeaderboards = () => null,
        getCurrentTrackKey = () => null,
        getDefaultPrimaryAction = () => null,
        cancelLeaderboardRequests = null,
        playUnlockSound = () => null,
        getGarageUi = null,
        getRedditUsername = () => null,
        previewShare = null,
        confirmShare = null,
        getNextChallenge = null,
        openChallengePost = null,
    } = {}) {
        this.content = content;
        this.getLeaderboards = getLeaderboards;
        this.getCurrentTrackKey = getCurrentTrackKey;
        this.getDefaultPrimaryAction = getDefaultPrimaryAction;
        this.cancelLeaderboardRequests = cancelLeaderboardRequests;
        this.playUnlockSound = playUnlockSound;
        this.getGarageUi = getGarageUi;
        this.getRedditUsername = getRedditUsername;
        this.previewShare = previewShare;
        this.confirmShare = confirmShare;
        this.getNextChallenge = getNextChallenge;
        this.openChallengePost = openChallengePost;
        this._modalCloseFallbackTimer = null;
        this._modalCloseTransitionEndHandler = null;
        this._modalKind = null;
        this._modalPrimaryAction = null;
        this._modalSecondaryAction = null;
        this._modalRunsPayload = null;
        this._onRaceOpponent = null;
        this._runsViewMode = 'close';
        this._runsCloseAction = null;
        this._savedModalState = null;
        this._focusBeforeModal = null;
        this._activeTrapModal = null;
        this._modalTrapKeydown = null;
        this._leaderboardScrollHandler = null;
        this._leaderboardPageLoading = false;
        this._leaderboardSwipeStart = null;
        this._leaderboardTouchStartHandler = null;
        this._leaderboardTouchEndHandler = null;
        this._leaderboardTouchCancelHandler = null;
        this._menuKeyboardState = createMenuKeyboardState();
        this._shareMenuKeyboardState = createMenuKeyboardState();
        this._garageMenuKeyboardState = createMenuKeyboardState();
        this._settingsMenuKeyboardState = createMenuKeyboardState();
        this._tracksMenuKeyboardState = createMenuKeyboardState();
        this._standingsMenuKeyboardState = createMenuKeyboardState();
        this._modalTrapPointerMove = null;
    }

    isSharePanelOpen() {
        return Boolean(this.modal?.querySelector?.('.result-share-panel'));
    }

    getSharePanelRoot() {
        return this.modal?.querySelector?.('.result-share-panel') || null;
    }

    getSharePanelButtons() {
        return collectVisibleActionButtons(this.getSharePanelRoot(), 'button', {
            requireLaidOut: false,
        });
    }

    getSharePanelActionsContainer() {
        const root = this.getSharePanelRoot();
        return root?.querySelector?.('.result-share-panel__actions') || root;
    }

    getGarageMenuContainer() {
        const unlockPanel = document.querySelector?.('#garage-modal .garage-unlock-panel');
        if (unlockPanel) return unlockPanel;
        return document.getElementById('garage-panel')
            || document.getElementById('garage-modal');
    }

    getGarageMenuItems() {
        const unlockPanel = document.querySelector?.('#garage-modal .garage-unlock-panel');
        if (unlockPanel) {
            return collectVisibleActionButtons(unlockPanel, 'button', {
                requireLaidOut: false,
            });
        }
        const tabSkin = document.getElementById('garage-tab-skin');
        const tabTrails = document.getElementById('garage-tab-trails');
        const skinPanel = document.getElementById('garage-panel-skin');
        const trailsPanel = document.getElementById('garage-panel-trails');
        const activePanel = skinPanel && !skinPanel.hidden
            ? skinPanel
            : trailsPanel;
        const options = activePanel
            ? collectVisibleActionButtons(
                activePanel,
                '.garage-skin-option, .garage-trail-option',
                { requireLaidOut: false },
            )
            : [];
        return filterVisibleMenuItems(
            [tabSkin, tabTrails, ...options],
            { requireLaidOut: false },
        );
    }

    resetGarageMenuKeyboardNav({ keepCue = false, preferredElement = null } = {}) {
        const items = this.getGarageMenuItems();
        const container = this.getGarageMenuContainer();
        const firstOptionIndex = items.findIndex((item) => (
            item.classList?.contains?.('garage-skin-option')
            || item.classList?.contains?.('garage-trail-option')
        ));
        const preferredElementIndex = preferredElement
            ? items.indexOf(preferredElement)
            : -1;

        if (keepCue && this._garageMenuKeyboardState?.keyboardNavActive) {
            const index = firstOptionIndex >= 0 ? firstOptionIndex : 0;
            this._garageMenuKeyboardState.selectedIndex = index;
            this._garageMenuKeyboardState.keyboardNavActive = true;
            applyMenuSelection(items, index, { container });
            return index;
        }

        return resetMenuKeyboardState(this._garageMenuKeyboardState, items, {
            preferredIndex: preferredElementIndex >= 0 ? preferredElementIndex : 0,
            container,
            focusPreferred: true,
        });
    }

    onGarageTabChangedForKeyboardNav() {
        this.resetGarageMenuKeyboardNav({
            keepCue: Boolean(this._garageMenuKeyboardState?.keyboardNavActive),
        });
    }

    getSettingsMenuContainer() {
        return document.getElementById('modal-settings-view')
            || document.getElementById('settings-modal');
    }

    getSettingsMenuItems() {
        return filterVisibleMenuItems([
            document.getElementById('settings-reddit-identity-switch'),
            document.getElementById('settings-car-audio-switch'),
            document.getElementById('settings-music-switch'),
            document.getElementById('settings-pause-placement-separate'),
            document.getElementById('settings-pause-placement-timer'),
            document.getElementById('settings-pause-placement-speedo'),
            document.getElementById('settings-hide-hud-switch'),
            document.getElementById('settings-pb-ghost-switch'),
            document.getElementById('settings-collision-auto-restart-switch'),
            document.getElementById('settings-collision-restart-delay-minus'),
            document.getElementById('settings-collision-restart-delay-plus'),
        ], { requireLaidOut: false });
    }

    resetSettingsMenuKeyboardNav() {
        const items = this.getSettingsMenuItems();
        return resetMenuKeyboardState(this._settingsMenuKeyboardState, items, {
            preferredIndex: 0,
            container: this.getSettingsMenuContainer(),
            focusPreferred: true,
        });
    }

    getTracksMenuContainer() {
        const dailyPanel = document.getElementById('daily-playlist-list');
        const campaignPanel = document.getElementById('campaign-playlist-list');
        return campaignPanel && !campaignPanel.hidden
            ? campaignPanel
            : dailyPanel
            || document.getElementById('daily-playlist-modal');
    }

    getTracksMenuItems() {
        const activePanel = this.getTracksMenuContainer();
        const trackItems = collectVisibleActionButtons(
            activePanel,
            '.daily-playlist-entry--hero',
            { requireLaidOut: false },
        );
        return filterVisibleMenuItems([
            document.getElementById('tracks-tab-daily'),
            document.getElementById('tracks-tab-campaign'),
            ...trackItems,
        ], { requireLaidOut: false });
    }

    getTracksPreferredTabIndex(items) {
        const activeTabId = document.getElementById('campaign-playlist-list')?.hidden === false
            ? 'tracks-tab-campaign'
            : 'tracks-tab-daily';
        const activeTabIndex = items.findIndex((item) => item?.id === activeTabId);
        return activeTabIndex >= 0 ? activeTabIndex : 0;
    }

    resetTracksMenuKeyboardNav({ keepCue = false } = {}) {
        const items = this.getTracksMenuItems();
        const preferredIndex = this.getTracksPreferredTabIndex(items);
        if (keepCue && this._tracksMenuKeyboardState?.keyboardNavActive && items.length) {
            this._tracksMenuKeyboardState.selectedIndex = preferredIndex;
            applyMenuSelection(items, preferredIndex, {
                container: this.getTracksMenuContainer(),
            });
            return preferredIndex;
        }
        return resetMenuKeyboardState(this._tracksMenuKeyboardState, items, {
            preferredIndex,
            container: this.getTracksMenuContainer(),
            focusPreferred: true,
        });
    }

    onTracksTabChangedForKeyboardNav() {
        this.resetTracksMenuKeyboardNav({
            keepCue: Boolean(this._tracksMenuKeyboardState?.keyboardNavActive),
        });
    }

    getStandingsMenuContainer() {
        return this.modalLapTimes || this.modalRunsView;
    }

    getStandingsMenuItems() {
        return filterVisibleMenuItems([
            ...Array.from(this.modalRunsView?.querySelectorAll?.('.leaderboard-day-chip') || []),
            ...Array.from(this.modalRunsView?.querySelectorAll?.(
                '.leaderboard-row.is-shareable, .leaderboard-row.is-raceable'
            ) || []),
        ], { requireLaidOut: false });
    }

    resetStandingsMenuKeyboardNav({ keepCue = false } = {}) {
        const items = this.getStandingsMenuItems();
        const container = this.getStandingsMenuContainer();
        const selectedDayIndex = items.findIndex((item) => (
            item.classList?.contains?.('leaderboard-day-chip')
            && item.classList?.contains?.('is-selected')
        ));
        const preferredIndex = selectedDayIndex >= 0 ? selectedDayIndex : 0;

        if (keepCue && this._standingsMenuKeyboardState?.keyboardNavActive && items.length) {
            this._standingsMenuKeyboardState.selectedIndex = preferredIndex;
            applyMenuSelection(items, preferredIndex, { container });
            return preferredIndex;
        }

        return resetMenuKeyboardState(this._standingsMenuKeyboardState, items, {
            preferredIndex,
            container,
            focusPreferred: true,
        });
    }

    clearFinishMenuKeyboardCue() {
        const root = this.getActiveMenuActionsRoot();
        const buttons = collectVisibleActionButtons(root, ':scope > button', {
            requireLaidOut: false,
        });
        if (this._menuKeyboardState?.keyboardNavActive) {
            dismissMenuKeyboardCue(this._menuKeyboardState, buttons, {
                container: root,
                preferredIndex: this.getMenuPreferredIndex(buttons),
            });
            return;
        }
        resetMenuKeyboardState(this._menuKeyboardState, buttons, {
            preferredIndex: this.getMenuPreferredIndex(buttons),
            container: root,
            focusPreferred: false,
        });
    }

    getActiveMenuActionsRoot() {
        if (this._modalKind === 'pause' && this.modalPauseView?.classList.contains('active-view')) {
            return this.modalPauseView.querySelector('.combined-actions');
        }
        if (this._modalKind === 'win' && this.modalCombinedView?.classList.contains('active-view')) {
            return this.modalCombinedView.querySelector('.combined-actions');
        }
        return null;
    }

    resetMenuKeyboardNav() {
        const root = this.getActiveMenuActionsRoot();
        const buttons = collectVisibleActionButtons(root, ':scope > button', {
            requireLaidOut: false,
        });
        resetMenuKeyboardState(this._menuKeyboardState, buttons, {
            preferredIndex: this.getMenuPreferredIndex(buttons),
            container: root,
            focusPreferred: true,
        });
    }

    getMenuPreferredIndex(buttons) {
        const winPreferred = this.combinedRestartBtn?.hidden
            ? this.combinedPlaylistBtn
            : this.combinedRestartBtn;
        const preferred = this._modalKind === 'pause'
            ? this.modalResumeBtn
            : this._modalKind === 'win'
                ? winPreferred
                : null;
        if (!preferred || !buttons?.length) return null;
        const preferredIndex = buttons.indexOf(preferred);
        return preferredIndex >= 0 ? preferredIndex : null;
    }

    dismissMenuKeyboardCueFromPointer(event) {
        if (event?.pointerType && event.pointerType !== 'mouse') return;
        const trapId = this._activeTrapModal?.id;

        if (trapId === 'garage-modal') {
            dismissMenuKeyboardCue(this._garageMenuKeyboardState, this.getGarageMenuItems(), {
                container: this.getGarageMenuContainer(),
                preferredIndex: 0,
            });
            return;
        }

        if (trapId === 'settings-modal') {
            dismissMenuKeyboardCue(this._settingsMenuKeyboardState, this.getSettingsMenuItems(), {
                container: this.getSettingsMenuContainer(),
                preferredIndex: 0,
            });
            return;
        }

        if (trapId === 'daily-playlist-modal') {
            dismissMenuKeyboardCue(this._tracksMenuKeyboardState, this.getTracksMenuItems(), {
                container: this.getTracksMenuContainer(),
                preferredIndex: this.getTracksPreferredTabIndex(this.getTracksMenuItems()),
            });
            return;
        }

        if (trapId !== 'modal') return;

        if (this.isSharePanelOpen()) {
            const shareButtons = this.getSharePanelButtons();
            dismissMenuKeyboardCue(this._shareMenuKeyboardState, shareButtons, {
                container: this.getSharePanelActionsContainer(),
                preferredIndex: shareButtons.length ? shareButtons.length - 1 : null,
            });
            return;
        }

        if (this.modalRunsView?.classList.contains('active-view')) {
            dismissMenuKeyboardCue(
                this._standingsMenuKeyboardState,
                this.getStandingsMenuItems(),
                {
                    container: this.getStandingsMenuContainer(),
                    preferredIndex: 0,
                },
            );
            return;
        }

        if (!this._menuKeyboardState?.keyboardNavActive) return;

        const root = this.getActiveMenuActionsRoot();
        if (!root) return;
        const buttons = collectVisibleActionButtons(root);
        dismissMenuKeyboardCue(this._menuKeyboardState, buttons, {
            container: root,
            preferredIndex: this.getMenuPreferredIndex(buttons),
        });
    }

    _setActiveView(view) {
        for (const v of [this.modalMainView, this.modalRunsView, this.modalCombinedView, this.modalPauseView]) {
            v?.classList.remove('active-view');
        }
        view?.classList.add('active-view');
    }

    _syncGarageButtonToPanelState() {
        const garageOpen = Boolean(this.getGarageUi?.()?.isGarageOpen?.());
        const buttons = [this.combinedGarageBtn].filter(Boolean);
        if (!buttons.length) return;
        for (const btn of buttons) {
            btn.classList.toggle('combined-action-btn--active', garageOpen);
            btn.setAttribute('aria-expanded', garageOpen ? 'true' : 'false');
        }
    }

    _openGarageModal() {
        const garageUi = this.getGarageUi?.();
        garageUi?.setPanelVisible?.(true);
        this._syncGarageButtonToPanelState();
    }

    _bindCombinedGarageBtn(btn) {
        if (!btn) return;
        btn.onclick = (event) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            this._openGarageModal();
        };
    }

    _hidePauseTrackPreview() {
        const nameEl = document.getElementById('modal-pause-track-name');
        if (nameEl) {
            nameEl.textContent = '';
        }
    }

    _syncPauseTrackPreview(payload) {
        const nameEl = document.getElementById('modal-pause-track-name');

        if (!payload?.trackKey) {
            this._hidePauseTrackPreview();
            return;
        }
        const labelName = (typeof payload.trackName === 'string' && payload.trackName.trim())
            ? payload.trackName.trim()
            : getTrackName(payload.trackKey, payload.trackKey);

        if (nameEl) {
            nameEl.textContent = labelName;
        }
    }

    get modal() { return document.getElementById('modal'); }
    get modalTitle() { return document.getElementById('modal-title'); }
    get modalMsg() { return document.getElementById('modal-msg'); }
    get modalLapTimes() { return document.getElementById('modal-lap-times'); }
    get backToMainBtn() { return document.getElementById('back-to-main-btn'); }
    get modalMainView() { return document.getElementById('modal-main-view'); }
    get modalPrimaryBtn() { return document.getElementById('modal-primary-btn'); }
    get modalSecondaryBtn() { return document.getElementById('modal-secondary-btn'); }
    get modalPlaylistBtn() { return document.getElementById('modal-playlist-btn'); }
    get modalRunsView() { return document.getElementById('modal-runs-view'); }
    get modalResumeBtn() { return document.getElementById('modal-resume-btn'); }
    get modalRestartBtn() { return document.getElementById('modal-restart-btn'); }
    get modalMenuBtn() { return document.getElementById('modal-menu-btn'); }
    get modalCombinedView() { return document.getElementById('modal-combined-view'); }
    get modalPauseView() { return document.getElementById('modal-pause-view'); }
    get combinedMenuBtn() { return document.getElementById('combined-menu-btn'); }
    get combinedNextBtn() { return document.getElementById('combined-next-btn'); }
    get combinedSettingsBtn() { return document.getElementById('combined-settings-btn'); }
    get combinedGarageBtn() { return document.getElementById('combined-garage-btn'); }
    get combinedPlaylistBtn() { return document.getElementById('combined-playlist-btn'); }
    get combinedRestartBtn() { return document.getElementById('combined-restart-btn'); }
    get combinedMoreBtn() { return document.getElementById('combined-more-btn'); }
    get combinedModeShortcutsLabel() {
        return document.getElementById('combined-mode-shortcuts-label');
    }
    cancelPendingModalClose() {
        if (!this.modal) return;

        if (this._modalCloseFallbackTimer != null) {
            clearTimeout(this._modalCloseFallbackTimer);
            this._modalCloseFallbackTimer = null;
        }

        if (this._modalCloseTransitionEndHandler) {
            this.modal.removeEventListener('transitionend', this._modalCloseTransitionEndHandler);
            this._modalCloseTransitionEndHandler = null;
        }
    }

    _bindClickAction(btn, action) {
        if (!btn) return;
        btn.onclick = typeof action === 'function' ? action : null;
    }

    _challengeCommentButtonText(phase, spent = null) {
        if (spent && phase === 'lost') {
            return { label: 'Change Track', aria: 'Open a different challenge' };
        }
        if (spent) {
            return { label: 'Brag', aria: 'Brag available after beating this challenge' };
        }
        return phase === 'tie'
            ? { label: 'A tie?', aria: 'Comment that you tied this challenge' }
            : { label: 'Concede', aria: 'Concede this challenge' };
    }

    _isPostedConcede() {
        return Boolean(
            this._challengeFinishCommentSpent
            && this._challengeFinishShareRequest?.kind === 'challenge-comment'
            && (
                this._challengeFinishPhase === 'lost'
                || this._challengeFinishShareRequest?.outcome === 'lost'
            ),
        );
    }

    _bindNextChallengeButton(button, postUrl) {
        if (!button) return;
        button.style.display = '';
        button.disabled = false;
        this._setShareButtonLabel(button, 'Change Track');
        button.setAttribute('aria-label', 'Open a different challenge');
        this._bindClickAction(button, () => void this._openNextChallengePost(postUrl));
    }

    _showLockedBragButton(button) {
        if (!button) return;
        button.style.display = '';
        button.disabled = true;
        this._setShareButtonLabel(button, 'Brag');
        button.setAttribute('aria-label', 'Brag available after beating this challenge');
        this._bindClickAction(button, null);
    }

    async _openNextChallengePost(postUrl) {
        try {
            if (typeof this.openChallengePost === 'function') {
                await this.openChallengePost(postUrl);
                return;
            }
            const { navigateTo } = await import('@devvit/web/client');
            navigateTo(postUrl);
        } catch (error) {
            console.error('Could not open the next challenge:', error);
        }
    }

    async _offerPostedConcedeNextChallenge(button) {
        if (!button) return;
        if (typeof this._nextChallengePostUrl === 'string') {
            this._bindNextChallengeButton(button, this._nextChallengePostUrl);
            return;
        }
        if (this._nextChallengePostUrl === false) {
            this._showLockedBragButton(button);
            return;
        }
        if (this._nextChallengeLookup) return this._nextChallengeLookup;
        this._setShareButtonLabel(button, 'Change Track');
        button.setAttribute('aria-label', 'Open a different challenge');
        button.disabled = true;
        this._nextChallengeLookup = (async () => {
            try {
                const challengeId = this._challengeFinishShareRequest?.challengeId;
                const response = typeof this.getNextChallenge === 'function'
                    ? await this.getNextChallenge({ challengeId })
                    : null;
                const postUrl = response?.ok && typeof response.body?.postUrl === 'string'
                    ? response.body.postUrl
                    : null;
                if (!postUrl) {
                    this._nextChallengePostUrl = false;
                    this._showLockedBragButton(button);
                    return;
                }
                this._nextChallengePostUrl = postUrl;
                this._bindNextChallengeButton(button, postUrl);
            } catch (error) {
                console.error('Could not find another challenge:', error);
                this._nextChallengePostUrl = false;
                this._showLockedBragButton(button);
            }
        })();
        return this._nextChallengeLookup;
    }

    _setShareButtonLabel(button, label) {
        const labelNode = button?.querySelector?.('.combined-action-btn-label');
        if (labelNode) labelNode.textContent = label.toUpperCase();
        else if (button) button.textContent = label;
    }

    _syncCombinedNextRace(nextRace = null) {
        this._combinedNextRace = nextRace;
        const button = this.combinedNextBtn;
        if (!button) return;
        const actions = this.modalCombinedView?.querySelector?.('.combined-actions');
        const visible = Boolean(nextRace);
        const enabled = visible
            && nextRace.enabled !== false
            && typeof nextRace.action === 'function';
        button.hidden = !visible;
        button.style.display = visible ? '' : 'none';
        actions?.classList?.toggle?.('combined-actions--with-next', visible);
        button.classList?.toggle?.('combined-action-btn--primary', enabled);
        this.combinedRestartBtn?.classList?.toggle?.(
            'combined-action-btn--primary',
            !enabled,
        );
        if (!visible) {
            this._bindClickAction(button, null);
            return;
        }
        const label = nextRace.label || 'Next';
        this._setShareButtonLabel(button, label);
        button.setAttribute('aria-label', nextRace.ariaLabel || label);
        button.disabled = !enabled;
        this._bindClickAction(button, enabled ? () => nextRace.action() : null);
    }

    setCombinedNextRaceEnabled(enabled) {
        const button = this.combinedNextBtn;
        if (!button || button.hidden) return false;
        button.disabled = !enabled;
        button.classList?.toggle?.('combined-action-btn--primary', Boolean(enabled));
        this.combinedRestartBtn?.classList?.toggle?.(
            'combined-action-btn--primary',
            !enabled,
        );
        const action = this._combinedNextRace?.action;
        this._bindClickAction(
            button,
            enabled && typeof action === 'function' ? () => action() : null,
        );
        return true;
    }

    _hideCombinedModeShortcuts() {
        const label = this.combinedModeShortcutsLabel;
        if (label) label.hidden = true;
        const menu = this.combinedMenuBtn;
        if (menu) {
            this._setShareButtonLabel(menu, 'Home');
            menu.setAttribute('aria-label', 'Home');
            menu.disabled = false;
            this._bindClickAction(menu, this._combinedMenuAction);
        }
        const button = this.combinedMoreBtn;
        if (!button) return;
        button.hidden = true;
        button.style.display = 'none';
        this._bindClickAction(button, null);
    }

    setChallengeWinActions({
        dailyAction = null,
        campaignAction = null,
    } = {}) {
        if (!this.modalCombinedView?.classList.contains('active-view')) return false;

        const improve = this.combinedRestartBtn;
        if (improve) {
            improve.hidden = true;
            improve.style.display = 'none';
            improve.classList?.remove?.('combined-action-btn--primary');
            this._bindClickAction(improve, null);
        }
        this.combinedPlaylistBtn?.classList?.add?.('combined-action-btn--primary');

        const label = this.combinedModeShortcutsLabel;
        if (label) label.hidden = false;

        const bindModeShortcut = (button, { label: buttonLabel, ariaLabel, action }) => {
            if (!button) return;
            this._setShareButtonLabel(button, buttonLabel);
            button.setAttribute('aria-label', ariaLabel);
            button.disabled = typeof action !== 'function';
            this._bindClickAction(
                button,
                typeof action === 'function'
                    ? () => this._confirmInSheet({
                        title: buttonLabel,
                        message: 'This will leave the head to head.',
                        confirmLabel: 'OK',
                        triggerButton: button,
                        onConfirm: () => action(),
                    })
                    : null,
            );
        };

        const daily = this.combinedMoreBtn;
        if (daily) {
            daily.hidden = false;
            daily.style.display = '';
        }
        bindModeShortcut(daily, {
            label: 'The Daily',
            ariaLabel: 'Leave this head to head for the Daily',
            action: dailyAction,
        });
        bindModeShortcut(this.combinedMenuBtn, {
            label: 'Campaign',
            ariaLabel: 'Leave this head to head for the Campaign',
            action: campaignAction,
        });

        this.resetMenuKeyboardNav?.();
        return true;
    }

    _confirmInSheet({
        title = '',
        message = '',
        confirmLabel = 'OK',
        onConfirm = null,
        triggerButton = null,
    } = {}) {
        const hostView = this.modalCombinedView;
        if (!hostView || typeof onConfirm !== 'function') return false;

        this._closeSharePanel?.({ restoreScroll: false });
        const scrim = document.createElement('section');
        scrim.className = 'result-share-panel';
        scrim.setAttribute('role', 'dialog');
        scrim.setAttribute('aria-label', title || 'Confirm');
        scrim.dataset.savedScrollTop = String(this.modalLapTimes?.scrollTop || 0);

        const panel = document.createElement('div');
        panel.className = 'result-share-panel__card';
        scrim.appendChild(panel);

        const titleEl = document.createElement('h3');
        titleEl.className = 'result-share-panel__title';
        titleEl.textContent = title;

        const messageEl = document.createElement('p');
        messageEl.className = 'result-share-panel__status';
        messageEl.textContent = message;

        const actions = document.createElement('div');
        actions.className = 'result-share-panel__actions';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'result-share-panel__button';
        cancel.textContent = 'Cancel';
        cancel.onclick = () => {
            if (triggerButton) triggerButton.disabled = false;
            this._closeSharePanel();
        };

        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'result-share-panel__button result-share-panel__button--primary';
        confirm.textContent = confirmLabel;
        confirm.onclick = () => {
            this._closeSharePanel({ restoreScroll: false });
            onConfirm();
        };

        actions.append(confirm, cancel);
        panel.append(titleEl, messageEl, actions);
        hostView.appendChild(scrim);
        if (triggerButton) triggerButton.disabled = true;
        this.clearFinishMenuKeyboardCue();
        resetMenuKeyboardState(this._shareMenuKeyboardState, [confirm, cancel], {
            preferredIndex: 0,
            container: actions,
            focusPreferred: true,
        });
        return true;
    }

    clearChallengeWinActions({ restartAction = null } = {}) {
        if (!this.modalCombinedView?.classList.contains('active-view')) return false;

        this._hideCombinedModeShortcuts();
        this.combinedPlaylistBtn?.classList?.remove?.('combined-action-btn--primary');

        const improve = this.combinedRestartBtn;
        if (improve && typeof restartAction === 'function') {
            improve.hidden = false;
            improve.style.display = '';
            improve.classList?.add?.('combined-action-btn--primary');
            this.setCombinedPrimaryAction({
                label: 'IMPROVE',
                ariaLabel: 'Improve time',
                action: () => restartAction(),
            });
        }

        this.resetMenuKeyboardNav?.();
        return true;
    }

    setCombinedPrimaryAction({
        label = 'Improve',
        ariaLabel = label,
        action = null,
        disabled = false,
    } = {}) {
        const button = this.combinedRestartBtn;
        if (!button || !this.modalCombinedView?.classList.contains('active-view')) return false;
        this._setShareButtonLabel(button, label);
        button.setAttribute('aria-label', ariaLabel);
        button.disabled = Boolean(disabled);
        this._bindClickAction(button, action);
        return true;
    }

    _closeSharePanel({ restoreScroll = true } = {}) {
        const panel = this.modal?.querySelector?.('.result-share-panel');
        const scrollTop = Number(panel?.dataset?.savedScrollTop);
        const restoreFocusElement = panel?._restoreFocusElement || null;
        resetMenuKeyboardState(this._shareMenuKeyboardState, this.getSharePanelButtons(), {
            container: this.getSharePanelActionsContainer(),
            focusPreferred: false,
        });
        panel?.remove();
        if (restoreScroll && Number.isFinite(scrollTop) && this.modalLapTimes) {
            this.modalLapTimes.scrollTop = scrollTop;
        }
        if (restoreScroll && typeof restoreFocusElement?.focus === 'function') {
            restoreFocusElement.focus();
        }
    }

    _showShareOutcome(panel, triggerButton, result, {
        bragged = false,
        commented = false,
        keepShareAvailable = false,
        noteText = '',
    } = {}) {
        const isChallengeCreate = Boolean(result?.postUrl) && !result?.commentText;
        const isChallengeRepeat = (isChallengeCreate && result?.status === 'already_created')
            || result?.status === 'already_commented';
        panel.replaceChildren();
        const title = document.createElement('h3');
        title.className = 'result-share-panel__title';
        title.textContent = isChallengeRepeat
            ? 'Already posted'
            : isChallengeCreate ? 'Challenge created' : commented ? 'Comment posted' : 'Shared';
        const copy = document.createElement('blockquote');
        copy.className = 'result-share-panel__copy';
        copy.textContent = noteText
            || result?.commentText
            || (isChallengeRepeat
                ? 'This time is already up.'
                : isChallengeCreate
                    ? 'Your verified challenge post is ready.'
                    : 'Your result is already in the score thread.');
        const actions = document.createElement('div');
        actions.className = 'result-share-panel__actions';
        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'result-share-panel__button';
        done.textContent = 'Done';
        done.onclick = () => this._closeSharePanel();
        actions.appendChild(done);
        panel.append(title, copy, actions);
        triggerButton.disabled = !keepShareAvailable;
        if (this._isPostedConcede()) {
            void this._offerPostedConcedeNextChallenge(triggerButton);
            resetMenuKeyboardState(this._shareMenuKeyboardState, [done], {
                preferredIndex: 0,
                container: actions,
                focusPreferred: true,
            });
            return;
        }
        const spentCommentText = !keepShareAvailable && commented
            ? this._challengeCommentButtonText(this._challengeFinishPhase, 'posted')
            : null;
        this._setShareButtonLabel(
            triggerButton,
            spentCommentText
                ? spentCommentText.label
                : keepShareAvailable ? 'Share' : bragged ? 'Bragged' : 'Shared',
        );
        if (spentCommentText) {
            triggerButton.setAttribute('aria-label', spentCommentText.aria);
        }
        resetMenuKeyboardState(this._shareMenuKeyboardState, [done], {
            preferredIndex: 0,
            container: actions,
            focusPreferred: true,
        });
    }

    _startShareChooser(request, triggerButton, hostView) {
        if (!triggerButton || !hostView) return;
        this._closeSharePanel?.({ restoreScroll: false });
        const scrim = document.createElement('section');
        scrim.className = 'result-share-panel';
        scrim.setAttribute('role', 'dialog');
        scrim.setAttribute('aria-label', 'Share race result');
        scrim.dataset.savedScrollTop = String(this.modalLapTimes?.scrollTop || 0);
        const panel = document.createElement('div');
        panel.className = 'result-share-panel__card';
        scrim.appendChild(panel);

        const title = document.createElement('h3');
        title.className = 'result-share-panel__title';
        title.textContent = 'Share';
        const description = document.createElement('p');
        description.className = 'result-share-panel__status';
        description.textContent = 'Choose how to share this finish.';
        const actions = document.createElement('div');
        actions.className = 'result-share-panel__actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'result-share-panel__button';
        cancel.textContent = 'Cancel';
        cancel.onclick = () => {
            triggerButton.disabled = false;
            this._closeSharePanel();
        };
        const comment = document.createElement('button');
        comment.type = 'button';
        comment.className = 'result-share-panel__button';
        comment.textContent = 'Comment Time';
        comment.onclick = () => this._startShare(request, triggerButton, hostView);
        const challenge = document.createElement('button');
        challenge.type = 'button';
        challenge.className = 'result-share-panel__button result-share-panel__button--primary';
        challenge.textContent = 'Issue Challenge';
        challenge.onclick = () => this._startShare({
            ...request,
            kind: 'head-to-head',
            source: 'daily',
        }, triggerButton, hostView);
        actions.append(comment, challenge, cancel);
        panel.append(title, description, actions);
        hostView.appendChild(scrim);
        triggerButton.disabled = true;
        this.clearFinishMenuKeyboardCue();
        resetMenuKeyboardState(this._shareMenuKeyboardState, [comment, challenge, cancel], {
            preferredIndex: 0,
            container: actions,
            focusPreferred: true,
        });
    }

    async _startShare(request, triggerButton, hostView) {
        if (!triggerButton || !hostView) return;
        const isChallenge = request?.kind === 'head-to-head';
        const isBrag = request?.kind === 'challenge-brag';
        const isChallengeComment = request?.kind === 'challenge-comment';
        const isDailyShare = isChallenge
            ? request?.source === 'daily'
            : request?.source === 'finish';
        if (isBrag || isChallengeComment) {
            this._challengeFinishShareRequest = request;
        }
        this._closeSharePanel?.({ restoreScroll: false });
        const scrim = document.createElement('section');
        scrim.className = 'result-share-panel';
        scrim.setAttribute('role', 'dialog');
        scrim.setAttribute(
            'aria-label',
            isChallenge
                ? 'Create player challenge'
                : isBrag
                    ? 'Brag about this win'
                    : isChallengeComment ? 'Comment on this challenge' : 'Share race result',
        );
        scrim.dataset.savedScrollTop = String(this.modalLapTimes?.scrollTop || 0);
        const panel = document.createElement('div');
        panel.className = 'result-share-panel__card';
        scrim.appendChild(panel);
        const title = document.createElement('h3');
        title.className = 'result-share-panel__title';
        title.textContent = isChallenge
            ? 'Challenge other racers'
            : isBrag
                ? 'Brag about your win'
                : isChallengeComment ? 'Comment on this challenge'
                : 'Share your time';
        const status = document.createElement('p');
        status.className = 'result-share-panel__status';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'result-share-panel__button';
        cancel.textContent = 'Cancel';
        cancel.onclick = () => {
            triggerButton.disabled = false;
            this._closeSharePanel();
        };
        panel.append(title, status, cancel);
        hostView.appendChild(scrim);
        this.clearFinishMenuKeyboardCue();
        resetMenuKeyboardState(this._shareMenuKeyboardState, [cancel], {
            preferredIndex: 0,
            container: this.getSharePanelActionsContainer(),
            focusPreferred: true,
        });

        const markCommentSpent = (reason) => {
            if (isBrag || isChallengeComment) this._challengeFinishCommentSpent = reason;
        };

        const username = this.getRedditUsername?.();
        if (!username) {
            status.textContent = isChallenge
                ? 'Sign in to Reddit to challenge other racers.'
                : isBrag
                    ? 'Sign in to Reddit to brag about this win.'
                    : isChallengeComment
                        ? 'Sign in to Reddit to comment on this challenge.'
                    : 'Sign in to Reddit to share your time.';
            cancel.textContent = 'Close';
            cancel.focus();
            return;
        }
        if (typeof this.previewShare !== 'function' || typeof this.confirmShare !== 'function') {
            status.textContent = 'Sharing is unavailable right now.';
            return;
        }
        triggerButton.disabled = true;
        status.textContent = isChallengeComment
            ? 'Preparing your comment…'
            : 'Preparing your verified result…';
        try {
            const response = await this.previewShare(request);
            const body = response?.body || {};
            if (
                body.status === 'already_shared'
                || body.status === 'already_created'
                || body.status === 'already_commented'
            ) {
                markCommentSpent('posted');
                this._showShareOutcome(panel, triggerButton, body, {
                    bragged: isBrag,
                    commented: isChallengeComment,
                    keepShareAvailable: isDailyShare,
                });
                return;
            }
            if (!response?.ok || body.status !== 'ready') {
                throw new Error(body.error || 'Could not prepare this result for sharing.');
            }
            panel.replaceChildren();
            const disclosure = document.createElement('p');
            disclosure.className = 'result-share-panel__status';
            const disclosureUser = document.createElement('span');
            disclosureUser.className = 'result-share-panel__accent';
            disclosureUser.textContent = `u/${body.username}`;
            disclosure.append(
                isChallenge
                    ? 'Create this challenge post as '
                    : 'Post this comment as ',
                disclosureUser,
                '?',
            );
            const copy = document.createElement('blockquote');
            copy.className = 'result-share-panel__copy';
            copy.textContent = isChallenge
                ? (body.title || 'Create a verified Head to Head.')
                : body.commentText;
            const actions = document.createElement('div');
            actions.className = 'result-share-panel__actions';
            const cancelReady = cancel.cloneNode(true);
            cancelReady.onclick = () => {
                triggerButton.disabled = false;
                this._closeSharePanel();
            };
            const confirm = document.createElement('button');
            confirm.type = 'button';
            confirm.className = 'result-share-panel__button result-share-panel__button--primary';
            confirm.textContent = isChallenge ? 'Create Challenge' : 'Post Comment';
            confirm.onclick = async () => {
                confirm.disabled = true;
                cancelReady.disabled = true;
                confirm.textContent = 'Posting…';
                try {
                    const shareToken = isChallenge ? body.challengeToken : body.shareToken;
                    const confirmed = await this.confirmShare(shareToken, request);
                    if (confirmed?.body?.status === 'comment_unconfirmed') {
                        markCommentSpent('unconfirmed');
                        confirm.remove();
                        cancelReady.disabled = false;
                        cancelReady.textContent = 'Close';
                        cancelReady.onclick = () => this._closeSharePanel();
                        disclosure.textContent = confirmed.body.error;
                        disclosure.classList.add('is-error');
                        resetMenuKeyboardState(this._shareMenuKeyboardState, [cancelReady], {
                            preferredIndex: 0,
                            container: actions,
                            focusPreferred: true,
                        });
                        return;
                    }
                    const publishedNote = confirmed?.body?.status === 'posted_without_link'
                        ? 'Your comment is up. Reddit did not return a link to it.'
                        : '';
                    if (publishedNote) {
                        markCommentSpent('posted');
                        this._showShareOutcome(panel, triggerButton, confirmed.body, {
                            bragged: isBrag,
                            commented: isChallengeComment,
                            keepShareAvailable: isDailyShare,
                            noteText: publishedNote,
                        });
                        return;
                    }
                    const successfulStatuses = isChallenge
                        ? ['created', 'already_created']
                        : isChallengeComment ? ['commented'] : ['shared', 'already_shared'];
                    if (!confirmed?.ok || !successfulStatuses.includes(confirmed?.body?.status)) {
                        throw new Error(confirmed?.body?.error || 'Could not share this result.');
                    }
                    markCommentSpent('posted');
                    this._showShareOutcome(panel, triggerButton, confirmed.body, {
                        bragged: isBrag,
                        commented: isChallengeComment,
                        keepShareAvailable: isDailyShare,
                    });
                } catch (error) {
                    confirm.disabled = false;
                    cancelReady.disabled = false;
                    confirm.textContent = 'Try Again';
                    disclosure.textContent = error?.message || 'Could not share this result.';
                    disclosure.classList.add('is-error');
                }
            };
            actions.append(cancelReady, confirm);
            panel.append(title, disclosure, copy, actions);
            resetMenuKeyboardState(this._shareMenuKeyboardState, [cancelReady, confirm], {
                preferredIndex: 1,
                container: actions,
                focusPreferred: true,
            });
        } catch (error) {
            triggerButton.disabled = false;
            status.textContent = error?.message || 'Could not prepare this result for sharing.';
            status.classList.add('is-error');
        }
    }

    showModal(title, msg, lapData, options = {}) {
        if (!this.modal || !this.modalTitle) return;

        this.cancelPendingModalClose();
        this._closeSharePanel?.({ restoreScroll: false });
        const modalKind = options.modalKind || null;
        if (modalKind !== 'pause') {
            this._hidePauseTrackPreview();
        }
        this.modalTitle.textContent = title;
        this._modalKind = modalKind;
        this.modal.classList.toggle('modal--win', this._modalKind === 'win');
        this.modal.classList.toggle('modal--pause', this._modalKind === 'pause');
        this._modalPrimaryAction = options.primaryAction || this.getDefaultPrimaryAction();
        this._modalSecondaryAction = options.secondaryAction || null;
        this._modalRunsPayload = buildModalRunsPayload(lapData, {
            currentTrackKey: this.getCurrentTrackKey()
        });
        if (lapData) {
            if (this.modalMsg) this.modalMsg.style.display = 'none';
        } else {
            if (this.modalMsg) {
                this.modalMsg.style.display = '';
                this.modalMsg.textContent = msg || '';
            }
        }

        if (lapData?.listData !== undefined && this.modalLapTimes) {
            this.modalLapTimes.replaceChildren();
            this.content.renderLapTimesList(this.modalLapTimes, lapData.listData, lapData.lapTime);
        } else if (lapData?.lapTimesArray !== undefined && this.modalLapTimes) {
            this.modalLapTimes.replaceChildren();
            this.content.renderLapTimesList(this.modalLapTimes, lapData.lapTimesArray, lapData.lapTime);
        } else if (lapData && this.modalLapTimes) {
            this.modalLapTimes.replaceChildren();
        }

        if (this._modalKind === 'win') {
            this.showCombinedResults(lapData, options);
            return;
        }

        if (this._modalKind === 'pause') {
            this.showPauseResults(options);
            return;
        }

        this.showMainResults(options);
    }

    showPauseResults(options = {}) {
        if (!this.modal || !this.modalPauseView) return;

        this.cancelPendingModalClose();
        this._bindClickAction(this.modalMenuBtn, options.secondaryAction);
        this._bindClickAction(this.modalRestartBtn, options.restartAction);
        this._bindClickAction(this.modalResumeBtn, options.primaryAction);
        this._syncGarageButtonToPanelState();

        this._setActiveView(this.modalPauseView);

        openModalElement(this.modal, () => this.modal.classList.add('active'));
        scheduleAfterModalPaint(() => {
            this._syncPauseTrackPreview(options.pauseTrackPreview);
            this.resetMenuKeyboardNav?.();
            this.activateModalFocusTrap(this.modal);
        });
    }

    showMainResults(options = {}) {
        if (!this.modal || !this.modalMainView) return;

        this.cancelPendingModalClose();
        this._bindClickAction(this.modalPrimaryBtn, options.restartAction || options.primaryAction);
        this._bindClickAction(this.modalSecondaryBtn, options.secondaryAction);
        this._bindClickAction(this.modalPlaylistBtn, options.playlistAction);
        const syncAction = (button, label, action) => {
            if (!button) return;
            button.hidden = typeof action !== 'function';
            if (typeof action === 'function') {
                button.removeAttribute('hidden');
                this._setShareButtonLabel(button, label);
                button.setAttribute('aria-label', label);
            }
        };
        syncAction(this.modalPrimaryBtn, options.primaryActionLabel || 'Continue', options.restartAction || options.primaryAction);
        syncAction(this.modalSecondaryBtn, options.secondaryActionLabel || 'Back', options.secondaryAction);
        syncAction(this.modalPlaylistBtn, 'Tracks', options.playlistAction);

        this._setActiveView(this.modalMainView);

        openModalElement(this.modal, () => this.modal.classList.add('active'));
        scheduleAfterModalPaint(() => this.activateModalFocusTrap(this.modal));
    }

    showCombinedResults(lapData, options = {}) {
        if (!this.modal || !this.modalCombinedView) return;

        this.cancelPendingModalClose();
        this._combinedResultsLapData = lapData;

        this.content.renderCombinedResults(this.modalCombinedView, {
            time: lapData.lapTime,
            bestLap: lapData.bestTime,
            scoreboardSnapshot: lapData.scoreboardSnapshot,
            lapMedal: lapData.lapMedal ?? null,
            challengeFinish: Boolean(lapData.challengeFinish),
            challengeConfirmPhase: lapData.challengeConfirmPhase ?? null,
            challengeConfirmStatus: lapData.challengeConfirmStatus ?? null,
            challengeConfirmError: lapData.challengeConfirmError ?? null,
            challengeViewerAvatarUrl: lapData.challengeViewerAvatarUrl ?? null,
            challengeVerdict: lapData.challengeVerdict ?? null,
            challengeBestUpdate: lapData.challengeBestUpdate ?? null,
            challengeViewerBest: lapData.challengeViewerBest ?? null,
            previousPersonalBestSec: lapData.previousPersonalBestSec,
            deltaToPersonalBest: lapData.deltaToPersonalBest,
            previousTrackMedal: lapData.previousTrackMedal ?? null,
            trackKey: lapData.trackKey || this.getCurrentTrackKey(),
            lapCount: lapData.requiredLaps ?? lapData.completedLaps ?? 1,
            lapCheckpointTimes: lapData.lapCheckpointTimes,
            pbCheckpointTimes: lapData.pbCheckpointTimes,
            pbFinishSec: lapData.pbFinishSec,
            raceComparisonTarget: lapData.raceComparisonTarget,
            comparisonOutcome: lapData.comparisonOutcome,
            deltaToComparison: lapData.deltaToComparison,
        });

        if (lapData.challengeFinish || lapData.challengeConfirmPhase) {
            this._challengeFinishShareRequest = options.shareRequest || null;
            this._challengeFinishCommentSpent = null;
            this._nextChallengePostUrl = null;
            this._nextChallengeLookup = null;
            this._challengeFinishPhase = lapData.challengeConfirmPhase
                ?? (lapData.lapMedal === 'challenge' ? 'won' : 'pending');
        } else {
            this._challengeFinishPhase = null;
        }

        const finishResultModal = (fn) => {
            if (!fn) return null;
            return () => fn();
        };

        const shareKind = options.shareRequest?.kind;
        const isChallengeShare = shareKind === 'head-to-head';
        const isChallengeBrag = shareKind === 'challenge-brag';
        const isChallengeComment = shareKind === 'challenge-comment';
        const isDailyShare = !shareKind && options.shareRequest?.source === 'finish';

        this._hideCombinedModeShortcuts();
        this.combinedPlaylistBtn?.classList?.remove?.('combined-action-btn--primary');

        if (this.combinedRestartBtn) {
            const canImprove = typeof (options.restartAction || options.primaryAction) === 'function';
            this.combinedRestartBtn.style.display = canImprove ? '' : 'none';
            this.combinedRestartBtn.hidden = !canImprove;
            this.combinedRestartBtn.classList?.toggle?.('combined-action-btn--primary', canImprove);
            const labelSpan = this.combinedRestartBtn.querySelector('.combined-action-btn-label');
            if (labelSpan) labelSpan.textContent = 'IMPROVE';
            this.combinedRestartBtn.setAttribute(
                'aria-label',
                'Improve time'
            );
        }
        if (this.combinedPlaylistBtn) {
            const hasAuxiliaryAction = Boolean(options.shareRequest || options.playlistAction);
            this.combinedPlaylistBtn.style.display = hasAuxiliaryAction ? '' : 'none';
            const shareEnabled = options.shareEnabled !== false;
            const commentText = isChallengeComment
                ? this._challengeCommentButtonText(lapData.challengeConfirmPhase)
                : null;
            const shareLabel = isChallengeBrag
                ? 'Brag'
                : commentText
                    ? commentText.label
                : isChallengeShare
                    ? 'Challenge'
                    : isDailyShare ? 'Share' : 'Share Time';
            const shareAria = isChallengeBrag
                ? (shareEnabled
                    ? 'Brag that you beat this challenge'
                    : 'Brag available after beating this challenge')
                : commentText
                    ? commentText.aria
                : isChallengeShare
                    ? 'Challenge other racers'
                    : isDailyShare ? 'Share result options' : 'Share time';
            this._setShareButtonLabel(this.combinedPlaylistBtn, shareLabel);
            this.combinedPlaylistBtn.setAttribute('aria-label', shareAria);
            this.combinedPlaylistBtn.disabled = Boolean(options.shareRequest) && !shareEnabled;
        }

        this._syncCombinedNextRace(options.nextRace || null);

        this._combinedMenuAction = finishResultModal(options.secondaryAction);
        this._bindClickAction(this.combinedMenuBtn, this._combinedMenuAction);
        this._bindClickAction(this.combinedSettingsBtn, options.settingsAction);
        this._bindCombinedGarageBtn(this.combinedGarageBtn);
        this._bindClickAction(
            this.combinedPlaylistBtn,
            options.shareRequest && options.shareEnabled !== false
                ? isDailyShare
                    ? () => void this._startShareChooser(
                        options.shareRequest,
                        this.combinedPlaylistBtn,
                        this.modalCombinedView,
                    )
                    : () => void this._startShare(options.shareRequest, this.combinedPlaylistBtn, this.modalCombinedView)
                : (!options.shareRequest ? options.playlistAction : null),
        );
        this._bindClickAction(
            this.combinedRestartBtn,
            typeof (options.restartAction || options.primaryAction) === 'function'
                ? finishResultModal(options.restartAction || options.primaryAction)
                : null,
        );
        this._syncGarageButtonToPanelState();

        const rightGroupEl = this.modalCombinedView?.querySelector('#combined-stats-right-group');
        if (rightGroupEl) {
            const canOpenLeaderboard = Boolean(
                this._modalRunsPayload?.scoreboardTrackKey
                && this._modalRunsPayload?.allowLeaderboardOpen !== false
            );
            const trackLocked = Boolean(lapData.challengeViewerBest?.trackLocked);
            if (canOpenLeaderboard) {
                bindCombinedStatButton(rightGroupEl, {
                    interactiveClass: 'combined-stats-right-group--interactive',
                    onActivate: () => this.showModalLeaderboardPayload(),
                });
            } else if (trackLocked) {
                bindCombinedStatButton(rightGroupEl, {
                    interactiveClass: 'combined-stats-right-group--interactive',
                    ariaLabel: 'Track locked. Open explanation.',
                    onActivate: () => this.content.openChallengeTrackLockedPopover(this.modalCombinedView),
                });
            } else {
                bindCombinedStatButton(rightGroupEl, {
                    interactiveClass: 'combined-stats-right-group--interactive',
                });
            }
        }

        this._setActiveView(this.modalCombinedView);

        openModalElement(this.modal, () => this.modal.classList.add('active'));

        const previousTrackMedal = lapData.previousTrackMedal ?? null;
        const trackKey = lapData.trackKey || this.getCurrentTrackKey();
        const shouldCelebrateTier = (tier) => shouldCelebrateMedalTier(tier, previousTrackMedal, {
            trackKey,
            lapTimeSec: lapData.lapTime,
            previousPersonalBestSec: lapData.previousPersonalBestSec,
        });
        const playUnlockSound = (tier) => {
            if (!shouldCelebrateTier(tier)) return;
            this.playUnlockSound(tier);
        };
        const challengePending = lapData.challengeConfirmPhase === 'pending'
            || (lapData.challengeFinish && lapData.challengeConfirmPhase !== 'won'
                && lapData.lapMedal !== 'challenge');
        if (!challengePending) {
            const combinedView = this.modalCombinedView;
            const medalHostEl = combinedView?.classList.contains('is-challenge-finish')
                ? combinedView.querySelector('#combined-hero-medal')
                : combinedView?.querySelector('#combined-medals-row');
            scheduleCombinedMedalEntranceAfterModal(this.modal, combinedView, {
                heroMedalEl: medalHostEl,
                stackEl: null
            }, {
                stackAfterHeroMs: 0,
                shouldCelebrateTier,
                playUnlockSound
            });
        }

        scheduleAfterModalPaint(() => {
            this.resetMenuKeyboardNav?.();
            this.activateModalFocusTrap(this.modal);
        });
    }

    setCombinedWinMedal(lapMedal) {
        if (!this.modalCombinedView?.classList.contains('active-view')) return;
        const lapData = this._combinedResultsLapData;
        if (!lapData || (lapData.lapMedal ?? null) === (lapMedal ?? null)) return;
        lapData.lapMedal = lapMedal ?? null;
        this.content.renderCombinedFinishMedals(
            this.modalCombinedView,
            {
                trackKey: lapData.trackKey || this.getCurrentTrackKey(),
                lapTimeSec: lapData.lapTime,
                lapMedal: lapData.lapMedal,
                challengeFinish: Boolean(lapData.challengeFinish),
                challengeConfirmPhase: lapData.challengeConfirmPhase ?? null,
                challengeConfirmStatus: lapData.challengeConfirmStatus ?? null,
                challengeConfirmError: lapData.challengeConfirmError ?? null,
                previousPersonalBestSec: lapData.previousPersonalBestSec,
                previousTrackMedal: lapData.previousTrackMedal ?? null,
                deltaToPersonalBest: lapData.deltaToPersonalBest,
                lapCount: lapData.requiredLaps ?? lapData.completedLaps ?? 1,
            },
        );
    }

    updateChallengeFinishHero({
        phase,
        statusText = null,
        error = null,
        shareRequest = undefined,
        verdict = undefined,
        bestUpdate = undefined,
    } = {}) {
        if (!this.modalCombinedView?.classList.contains('active-view')) return;

        const heroMedalEl = this.modalCombinedView.querySelector('#combined-hero-medal');
        const lapData = this._combinedResultsLapData;
        const phaseUnchanged = phase === undefined || phase === this._challengeFinishPhase;
        const marginUnchanged = verdict === undefined
            || verdict?.deltaSec === lapData?.challengeVerdict?.deltaSec;
        const bestUnchanged = bestUpdate === undefined
            || (bestUpdate?.bestTimeMs === lapData?.challengeBestUpdate?.bestTimeMs
                && bestUpdate?.rank === lapData?.challengeBestUpdate?.rank);
        if (!phaseUnchanged || !marginUnchanged) {
            const nextPhase = phase ?? this._challengeFinishPhase;
            const nextVerdict = verdict === undefined
                ? (lapData?.challengeVerdict ?? null)
                : verdict;
            renderChallengeFinishHero(heroMedalEl, {
                phase: nextPhase,
                statusText,
                error,
                avatarUrl: lapData?.challengeViewerAvatarUrl ?? null,
                verdict: nextVerdict,
            });
            this._challengeFinishPhase = nextPhase;
            if (lapData) {
                lapData.challengeConfirmPhase = nextPhase;
                lapData.challengeVerdict = nextVerdict;
            }
            this.content.applyChallengeOpponentStat(this.modalCombinedView, nextVerdict);
        }
        if (!bestUnchanged) {
            const nextBestUpdate = bestUpdate ?? null;
            this.content.applyChallengeRankStat(
                this.modalCombinedView,
                nextBestUpdate,
                lapData?.challengeViewerBest,
            );
            if (lapData) lapData.challengeBestUpdate = nextBestUpdate;
            const heldBestSec = nextBestUpdate?.improved === true
                ? null
                : Number(nextBestUpdate?.bestTimeMs) / 1000;
            const alreadyHasPb = Number(lapData?.previousPersonalBestSec) > 0;
            if (Number.isFinite(heldBestSec) && heldBestSec > 0 && !alreadyHasPb) {
                this.content.applyChallengePersonalBestStat?.(
                    this.modalCombinedView,
                    lapData?.lapTime,
                    heldBestSec,
                );
                if (lapData) {
                    lapData.previousPersonalBestSec = heldBestSec;
                    lapData.challengeViewerBest = {
                        ...(lapData.challengeViewerBest || {}),
                        bestTimeMs: nextBestUpdate.bestTimeMs,
                        rank: nextBestUpdate.rank ?? lapData.challengeViewerBest?.rank ?? null,
                    };
                }
            }
        }

        if (shareRequest !== undefined) {
            this._challengeFinishShareRequest = shareRequest;
        }
        const challengeShareRequest = this._challengeFinishShareRequest;
        const isChallengeBrag = challengeShareRequest?.kind === 'challenge-brag';
        const isChallengeComment = challengeShareRequest?.kind === 'challenge-comment';
        const finishPhase = phase ?? this._challengeFinishPhase;
        const spent = this._challengeFinishCommentSpent;
        const shareEnabled = !spent && Boolean(challengeShareRequest) && (
            isChallengeBrag
                ? finishPhase === 'won'
                : isChallengeComment && (finishPhase === 'tie' || finishPhase === 'lost')
        );

        if (this.combinedPlaylistBtn && challengeShareRequest) {
            if (spent && isChallengeComment && finishPhase === 'lost') {
                void this._offerPostedConcedeNextChallenge(this.combinedPlaylistBtn);
            } else {
                const commentText = isChallengeComment
                    ? this._challengeCommentButtonText(finishPhase, spent)
                    : null;
                this.combinedPlaylistBtn.style.display = '';
                this._setShareButtonLabel(
                    this.combinedPlaylistBtn,
                    commentText
                        ? commentText.label
                        : (spent === 'posted' ? 'Bragged' : 'Brag'),
                );
                this.combinedPlaylistBtn.setAttribute(
                    'aria-label',
                    commentText
                        ? commentText.aria
                        : shareEnabled
                            ? 'Brag that you beat this challenge'
                            : 'Brag available after beating this challenge',
                );
                this.combinedPlaylistBtn.disabled = !shareEnabled;
                this._bindClickAction(
                    this.combinedPlaylistBtn,
                    shareEnabled
                        ? () => void this._startShare(
                            challengeShareRequest,
                            this.combinedPlaylistBtn,
                            this.modalCombinedView,
                        )
                        : null,
                );
            }
        }

        if (phase === 'won' && !phaseUnchanged) {
            const shouldCelebrateTier = (tier) => tier === 'challenge';
            const playUnlockSound = (tier) => {
                if (tier !== 'challenge') return;
                this.playUnlockSound(tier);
            };
            scheduleCombinedMedalEntranceAfterModal(this.modal, this.modalCombinedView, {
                heroMedalEl,
                stackEl: null,
            }, {
                stackAfterHeroMs: 0,
                shouldCelebrateTier,
                playUnlockSound,
            });
        }
    }

    showRunsModal(lapTimesArray, bestTime, currentTime = null, returnMode = 'close', {
        scoreboardSnapshot = null,
        scoreboardMode = TRACK_MODE_DAILY_GP,
        scoreboardChallengeId = null,
        scoreboardTrackKey = null,
        scoreboardTitle = null,
        scoreboardSubhead = null,
        leaderboardDayOptions = null,
        leaderboardRailLabel = null,
        selectedLeaderboardDayId = null,
        onSelectLeaderboardDay = null,
        onLoadMoreLeaderboard = null,
        onOpenStandings = null,
        onRaceOpponent = null,
        showGlobalLeaderboard = true,
        allowLeaderboardOpen = true,
        onClose = null
    } = {}) {
        if (!this.modal || !this.modalTitle || !this.modalLapTimes || !this.modalRunsView || !this.modalMainView) return;

        this.cancelPendingModalClose();
        this._closeSharePanel?.({ restoreScroll: false });
        const wasActive = this.isModalActive();

        const wasCombinedActive = this.modalCombinedView?.classList.contains('active-view');
        const wasMainActive = this.modalMainView?.classList.contains('active-view');
        if (wasCombinedActive) {
            this._runsReturnView = 'combined';
            this._savedModalState = { kind: this._modalKind };
        } else if (wasMainActive) {
            this._runsReturnView = 'main';
            this._savedModalState = null;
        } else if (!this._runsReturnView) {
            this._runsReturnView = 'main';
            this._savedModalState = null;
        }

        this.modal.classList.remove('modal--win', 'modal--pause');
        this._modalKind = null;
        this._hidePauseTrackPreview();
        this.modalLapTimes.replaceChildren();
        this._leaderboardDayRailOptionsKey = null;
        this._leaderboardDayRailKey = null;
        const hasPersonalBestList = Array.isArray(lapTimesArray);
        this.content.renderLapTimesList(this.modalLapTimes, lapTimesArray, currentTime);
        this._modalRunsPayload = buildModalRunsPayload({
            lapTimesArray,
            bestTime,
            currentTime,
            scoreboardChallengeId,
            scoreboardTrackKey,
            scoreboardSnapshot,
            scoreboardMode,
            scoreboardTitle,
            scoreboardSubhead,
            leaderboardDayOptions,
            leaderboardRailLabel,
            selectedLeaderboardDayId,
            onSelectLeaderboardDay,
            onLoadMoreLeaderboard,
            onOpenStandings,
            onRaceOpponent,
            showGlobalLeaderboard,
            allowLeaderboardOpen
        }, {
            currentTrackKey: this.getCurrentTrackKey()
        });
        this._onRaceOpponent = typeof onRaceOpponent === 'function'
            ? onRaceOpponent
            : null;
        this._runsViewMode = returnMode === 'back' ? 'back' : 'close';
        this._runsCloseAction = typeof onClose === 'function' ? onClose : null;
        this.configureRunsModalHeader?.();
        this.renderLeaderboardStandaloneIntro?.();
        if (this._modalRunsPayload.showGlobalLeaderboard) {
            const shareBest = this._leaderboardShareBestOption();
            this.content.renderScoreboardList(
                this.modalLapTimes,
                this._modalRunsPayload.scoreboardSnapshot,
                this._modalRunsPayload.scoreboardTrackKey,
                {
                    showHeader: hasPersonalBestList,
                    shareBest,
                    raceOpponentEnabled: typeof this._onRaceOpponent === 'function',
                }
            );
        }
        this.bindLeaderboardPagination?.();
        this.bindLeaderboardDaySwipe?.();
        this._wireLeaderboardRowShare?.();
        this._wireLeaderboardOpponentRace?.();

        if (this.backToMainBtn) {
            this.backToMainBtn.setAttribute('aria-label', 'Back');
        }
        this._setActiveView(this.modalRunsView);
        openModalElement(this.modal, () => this.modal.classList.add('active'));
        if (wasActive) {
            scheduleAfterModalPaint(() => {
                this.content.centerLeaderboardCurrentRow();
                this.resetStandingsMenuKeyboardNav?.({
                    keepCue: Boolean(this._standingsMenuKeyboardState?.keyboardNavActive),
                });
            });
            return;
        }
        scheduleAfterModalPaint(() => {
            this.content.centerLeaderboardCurrentRow();
            this.activateModalFocusTrap(this.modal);
            this.resetStandingsMenuKeyboardNav?.();
        });
    }

    closeModal() {
        if (!this.modal) return;

        this._closeSharePanel({ restoreScroll: false });
        this._leaderboardRailScrollLeft = null;
        this._leaderboardDayRailOptionsKey = null;
        this._leaderboardDayRailKey = null;
        this.unbindLeaderboardPagination?.();
        this.unbindLeaderboardDaySwipe?.();
        const modal = this.modal;
        closeModalElement(modal, () => modal.classList.remove('active'));
        this.cancelLeaderboardRequests?.();

        this.cancelPendingModalClose();

        const cleanupAfterClose = () => {
            this._modalCloseTransitionEndHandler = null;
            modal.classList.remove('modal--pause');
            modal.classList.remove('modal--win');
            this._hidePauseTrackPreview();
            this._setActiveView(null);
            this._modalKind = null;
            this._modalPrimaryAction = this.getDefaultPrimaryAction();
            this._modalSecondaryAction = null;
            this._modalRunsPayload = null;
            this._onRaceOpponent = null;
            this._runsReturnView = null;
            this._runsCloseAction = null;
            this._savedModalState = null;
            this.releaseModalFocusTrap(modal);
        };

        const onTransitionEnd = (event) => {
            if (event.target !== modal || event.propertyName !== 'opacity') return;
            modal.removeEventListener('transitionend', onTransitionEnd);
            this._modalCloseTransitionEndHandler = null;
            if (this._modalCloseFallbackTimer != null) {
                clearTimeout(this._modalCloseFallbackTimer);
                this._modalCloseFallbackTimer = null;
            }
            cleanupAfterClose();
        };

        this._modalCloseTransitionEndHandler = onTransitionEnd;
        modal.addEventListener('transitionend', onTransitionEnd);
        this._modalCloseFallbackTimer = setTimeout(() => {
            this._modalCloseFallbackTimer = null;
            modal.removeEventListener('transitionend', onTransitionEnd);
            cleanupAfterClose();
        }, 350);
    }

    dismissRunsView() {
        if (this._runsViewMode === 'close' && this._runsReturnView !== 'combined') {
            const closeAction = this._runsCloseAction;
            runModalHandoff(() => {
                this.closeModal();
                closeAction?.();
            });
            return;
        }

        this.showMainModalView();
        requestAnimationFrame(() => this.activateModalFocusTrap(this.modal));
    }

    showMainModalView() {
        this._runsViewMode = 'back';
        if (this.backToMainBtn) {
            this.backToMainBtn.setAttribute('aria-label', 'Back');
        }
        this.configureRunsModalHeader?.();

        const isCombinedViewReturn = this._runsReturnView === 'combined'
            || this._savedModalState?.kind === 'win'
            || this._modalKind === 'win';

        if (isCombinedViewReturn) {
            this._modalKind = this._savedModalState?.kind || this._modalKind || 'win';
            if (this.modal) {
                this.modal.classList.toggle('modal--win', this._modalKind === 'win');
                this.modal.classList.toggle('modal--pause', this._modalKind === 'pause');
            }
            this._setActiveView(this.modalCombinedView);
        } else {
            this._setActiveView(this.modalMainView);
        }
    }

    isStandaloneRunsViewActive() {
        return this.isModalActive() && this._runsViewMode === 'close' && Boolean(this.modalRunsView?.classList.contains('active-view'));
    }

    isPauseModalActive() {
        return this.isModalActive() && this._modalKind === 'pause';
    }

    isCombinedResultsModalActive() {
        return this.isModalActive() && this._modalKind === 'win';
    }

    isPauseEscapeTarget(trapRoot) {
        return trapRoot?.id === 'modal' && this._modalKind === 'pause' && this.isModalActive();
    }

    resumePauseFromKeyboard() {
        if (!this.isPauseModalActive()) return false;
        const resume = this._modalPrimaryAction;
        if (typeof resume === 'function') {
            resume();
            return true;
        }
        this.modalResumeBtn?.click();
        return true;
    }

    getFocusables(root) {
        const selector = 'button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex^="-"])';
        return Array.from(root.querySelectorAll(selector)).filter((el) => el.offsetParent !== null);
    }

    getModalPreferredFocusTarget() {
        if (this._modalKind === 'pause' && this.modalResumeBtn?.offsetParent !== null) {
            return this.modalResumeBtn;
        }
        if (this._modalKind === 'win') {
            const winFocusCandidates = [
                this.combinedRestartBtn,
                this.combinedPlaylistBtn,
                this.combinedMoreBtn,
                this.combinedMenuBtn,
            ];
            return winFocusCandidates.find((button) => (
                button
                && !button.disabled
                && !button.hidden
                && button.offsetParent !== null
            )) || null;
        }
        return null;
    }

    activateModalFocusTrap(modalEl) {
        if (!modalEl) return;

        if (this._modalTrapKeydown) {
            document.removeEventListener('keydown', this._modalTrapKeydown, true);
            this._modalTrapKeydown = null;
        }
        if (this._modalTrapPointerMove) {
            document.removeEventListener('pointermove', this._modalTrapPointerMove, true);
            this._modalTrapPointerMove = null;
        }

        this._focusBeforeModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this._activeTrapModal = modalEl;
        const focusables = this.getFocusables(modalEl);
        const preferredFocus = modalEl === this.modal
            ? this.getModalPreferredFocusTarget()
            : null;
        if (preferredFocus) preferredFocus.focus();
        else if (focusables.length) focusables[0].focus();
        this._modalTrapKeydown = (event) => this.handleModalTrapKeydown(event);
        this._modalTrapPointerMove = (event) => this.dismissMenuKeyboardCueFromPointer(event);
        document.addEventListener('keydown', this._modalTrapKeydown, true);
        document.addEventListener('pointermove', this._modalTrapPointerMove, true);
    }

    releaseModalFocusTrap(modalEl) {
        if (this._activeTrapModal !== modalEl) return;
        document.removeEventListener('keydown', this._modalTrapKeydown, true);
        if (this._modalTrapPointerMove) {
            document.removeEventListener('pointermove', this._modalTrapPointerMove, true);
        }
        this._activeTrapModal = null;
        this._modalTrapKeydown = null;
        this._modalTrapPointerMove = null;
        const activeElement = document.activeElement;
        if (
            activeElement
            && activeElement !== document.body
            && (
                modalEl?.contains?.(activeElement)
                || activeElement.offsetParent === null
            )
            && typeof activeElement.blur === 'function'
        ) {
            activeElement.blur();
        }
        const restoredActiveElement = document.activeElement;
        const focusAlreadyMoved = Boolean(
            restoredActiveElement
            && restoredActiveElement !== document.body
            && restoredActiveElement !== this._focusBeforeModal
            && document.contains(restoredActiveElement)
            && restoredActiveElement.offsetParent !== null
            && !modalEl?.contains?.(restoredActiveElement)
        );
        if (
            !focusAlreadyMoved
            && this._focusBeforeModal
            && this._focusBeforeModal !== document.body
            && document.contains(this._focusBeforeModal)
            && this._focusBeforeModal.offsetParent !== null
        ) {
            this._focusBeforeModal.focus();
        }
        this._focusBeforeModal = null;
    }

    handleModalTrapKeydown(event) {
        if (!this._activeTrapModal) return;

        const isEscape = event.key === 'Escape' || event.code === 'Escape';
        if (isEscape && this.isSharePanelOpen?.()) {
            event.preventDefault();
            event.stopPropagation();
            this._closeSharePanel();
            return;
        }
        if (isEscape) {
            const trapRoot = this._activeTrapModal;
            if (this.isPauseEscapeTarget(trapRoot)) {
                event.preventDefault();
                event.stopPropagation();
                this.resumePauseFromKeyboard();
                return;
            }
            if (trapRoot.id === 'settings-modal') {
                event.preventDefault();
                document.getElementById('settings-back-btn')?.click();
                return;
            }
            if (trapRoot.id === 'garage-modal') {
                event.preventDefault();
                const unlockPanel = document.querySelector?.('#garage-modal .garage-unlock-panel');
                const closeButton = unlockPanel?.querySelector?.('.result-share-panel__button');
                if (closeButton) closeButton.click();
                else document.getElementById('garage-close-btn')?.click();
                return;
            }
            if (
                trapRoot?.id === 'modal'
                && this.modalRunsView?.classList.contains('active-view')
            ) {
                event.preventDefault();
                this.dismissRunsView();
                return;
            }
        }

        if (this.isSharePanelOpen?.() && this._activeTrapModal?.id === 'modal') {
            const sharePanel = this.getSharePanelRoot();
            const shareButtons = this.getSharePanelButtons();
            if (handleMenuListKeydown(event, {
                buttons: shareButtons,
                state: this._shareMenuKeyboardState,
                container: this.getSharePanelActionsContainer(),
            })) {
                return;
            }
            if (event.key === 'Tab' && sharePanel) {
                const focusables = this.getFocusables(sharePanel);
                if (focusables.length === 0) return;
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (event.shiftKey) {
                    if (document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    }
                    return;
                }
                if (document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
            return;
        }

        if (this._activeTrapModal?.id === 'garage-modal') {
            const unlockPanel = document.querySelector?.('#garage-modal .garage-unlock-panel');
            if (handleMenuListKeydown(event, {
                buttons: this.getGarageMenuItems(),
                state: this._garageMenuKeyboardState,
                container: this.getGarageMenuContainer(),
            })) {
                return;
            }
            if (unlockPanel) {
                if (event.key === 'Tab') {
                    const focusables = this.getFocusables(unlockPanel);
                    if (focusables.length > 0) {
                        event.preventDefault();
                        focusables[0].focus();
                    }
                }
                return;
            }
        }

        if (this._activeTrapModal?.id === 'settings-modal') {
            if (handleMenuListKeydown(event, {
                buttons: this.getSettingsMenuItems(),
                state: this._settingsMenuKeyboardState,
                container: this.getSettingsMenuContainer(),
            })) {
                return;
            }
        }

        if (this._activeTrapModal?.id === 'daily-playlist-modal') {
            if (handleMenuListKeydown(event, {
                buttons: this.getTracksMenuItems(),
                state: this._tracksMenuKeyboardState,
                container: this.getTracksMenuContainer(),
            })) {
                return;
            }
        }

        if (
            this._activeTrapModal?.id === 'modal'
            && this.modalRunsView?.classList.contains('active-view')
        ) {
            if (handleMenuListKeydown(event, {
                buttons: this.getStandingsMenuItems(),
                state: this._standingsMenuKeyboardState,
                container: this.getStandingsMenuContainer(),
            })) {
                return;
            }
        }

        const menuActionsRoot = this.getActiveMenuActionsRoot();
        if (menuActionsRoot && this._activeTrapModal?.id === 'modal') {
            const menuButtons = collectVisibleActionButtons(menuActionsRoot);
            if (handleMenuListKeydown(event, {
                buttons: menuButtons,
                state: this._menuKeyboardState,
                container: menuActionsRoot,
            })) {
                return;
            }
        }

        if (event.key === 'Enter' || event.code === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (event.key !== 'Tab') return;
        const focusables = this.getFocusables(this._activeTrapModal);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey) {
            if (document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
            return;
        }
        if (document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    applyRankModalStatContent(rankStat, scoreboardSnapshot) {
        if (!rankStat) return;

        const value = rankStat.querySelector?.('[data-modal-rank-value]');
        if (!value) return;

        const rankDisplay = buildScoreboardRankDisplay(scoreboardSnapshot);
        const label = rankStat.querySelector?.('.modal-stat-label');
        const status = rankStat.querySelector?.('[data-modal-rank-status]');
        if (label) {
            label.textContent = rankDisplay.labelText;
        }

        const shouldShowStatusText = Boolean(rankDisplay.statusText)
            && (
                rankDisplay.isLoading
                || !rankDisplay.text
                || rankDisplay.text === 'N/A'
                || scoreboardSnapshot?.verificationState === 'error'
                || scoreboardSnapshot?.verificationState === 'rejected'
            );

        value.replaceChildren();
        value.toggleAttribute('aria-busy', rankDisplay.isLoading);
        value.textContent = shouldShowStatusText
            ? rankDisplay.statusText || ''
            : rankDisplay.text || (rankDisplay.isLoading ? rankDisplay.statusText || '' : '');
        if (rankDisplay.isLoading) {
            const spinner = document.createElement('span');
            spinner.className = 'modal-rank-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            value.appendChild(spinner);
        }

        status?.remove();

        if (isButtonElement(rankStat)) {
            rankStat.disabled = rankDisplay.isLoading;
        }
    }

    createRankModalStat(scoreboardSnapshot) {
        const hasRank = Boolean(scoreboardSnapshot?.playerRankLabel);
        const canOpenLeaderboard = Boolean(
            this._modalRunsPayload?.scoreboardTrackKey
            && this._modalRunsPayload?.allowLeaderboardOpen !== false
        );
        const stat = this.content.createModalStat(
            'Rank',
            hasRank ? scoreboardSnapshot.playerRankLabel : '',
            'modal-stat-value--rank',
            canOpenLeaderboard ? () => this.showModalLeaderboardPayload() : null
        );
        stat.dataset.modalRankStat = '';
        const value = stat.querySelector('.modal-stat-value');
        if (value) {
            value.dataset.modalRankValue = '';
        }
        this.applyRankModalStatContent(stat, scoreboardSnapshot);
        return stat;
    }

    updateModalScoreboardSnapshot(scoreboardSnapshot) {
        if (!this._modalRunsPayload) return;
        this._modalRunsPayload = buildModalRunsPayload(this._modalRunsPayload, {
            updates: { scoreboardSnapshot }
        });

        if (this.modalRunsView?.classList.contains('active-view') && this.modalLapTimes) {
            const scrollTop = this.modalLapTimes.scrollTop;
            const hadRows = Boolean(this.modalLapTimes.querySelector('.leaderboard-row'));
            const hasPersonalBestList = Array.isArray(this._modalRunsPayload.lapTimesArray);
            this.renderLeaderboardDayRail();
            this.renderLeaderboardHeaderSummary();
            if (this._modalRunsPayload.showGlobalLeaderboard) {
                const shareBest = this._leaderboardShareBestOption();
                this.content.renderScoreboardList(
                    this.modalLapTimes,
                    this._modalRunsPayload.scoreboardSnapshot,
                    this._modalRunsPayload.scoreboardTrackKey,
                    {
                        showHeader: hasPersonalBestList,
                        shareBest,
                        raceOpponentEnabled: typeof this._onRaceOpponent === 'function',
                    }
                );
            } else {
                this.modalLapTimes.querySelector('.leaderboard-section')?.remove();
            }
            this.bindLeaderboardPagination?.();
            this._wireLeaderboardRowShare?.();
            this._wireLeaderboardOpponentRace?.();
            if (hadRows) {
                this.modalLapTimes.scrollTop = scrollTop;
            } else {
                this.content.centerLeaderboardCurrentRow?.();
            }
            return;
        }

        if (this.modalCombinedView?.classList.contains('active-view')) {
            applyCombinedRankValue({
                rankValueEl: this.modalCombinedView.querySelector('#combined-rank-value'),
                rankTotalEl: this.modalCombinedView.querySelector('#combined-rank-total'),
                rightGroupEl: this.modalCombinedView.querySelector('#combined-stats-right-group'),
                scoreboardSnapshot,
            });
            return;
        }

        const rankStat = this.modalStatsRow?.querySelector('[data-modal-rank-stat]');
        const rankValue = this.modalStatsRow?.querySelector('[data-modal-rank-value]');
        if (!rankStat || !rankValue) return;

        if (!isButtonElement(rankStat)) {
            const nextRankStat = this.createRankModalStat(scoreboardSnapshot);
            rankStat.replaceWith(nextRankStat);
            return;
        }

        this.applyRankModalStatContent(rankStat, scoreboardSnapshot);
    }

    updateModalLeaderboardDayOptions({
        leaderboardDayOptions = null,
        onSelectLeaderboardDay = null,
    } = {}) {
        if (!this._modalRunsPayload) return;

        const updates = {};
        if (Array.isArray(leaderboardDayOptions)) {
            updates.leaderboardDayOptions = leaderboardDayOptions;
        }
        if (typeof onSelectLeaderboardDay === 'function') {
            updates.onSelectLeaderboardDay = onSelectLeaderboardDay;
        }

        this._modalRunsPayload = buildModalRunsPayload(this._modalRunsPayload, { updates });
        this.renderLeaderboardDayRail({ force: true });
        this.bindLeaderboardDaySwipe?.();
    }

    showModalLeaderboardPayload() {
        if (typeof this._modalRunsPayload?.onOpenStandings === 'function') {
            this._modalRunsPayload.onOpenStandings();
            return;
        }

        if (this._modalRunsPayload?.scoreboardChallengeId) {
            void this.getLeaderboards()?.openDailyChallengeLeaderboardForChallenge?.({
                id: this._modalRunsPayload.scoreboardChallengeId,
                trackKey: this._modalRunsPayload.scoreboardTrackKey,
                scoreboardSnapshot: this._modalRunsPayload.scoreboardSnapshot,
            }, 'back');
            return;
        }

        if (!this._modalRunsPayload?.scoreboardTrackKey) return;

        this.getLeaderboards()?.showTrackLeaderboardModal(
            this._modalRunsPayload.scoreboardTrackKey,
            'back'
        );
    }

    renderLeaderboardStandaloneIntro() {
        if (!shouldRenderLeaderboardStandaloneIntro(this._modalRunsPayload)) return;
        this.renderLeaderboardDayRail();
        this.renderLeaderboardHeaderSummary();
    }

    renderLeaderboardDayRail({ force = false } = {}) {
        if (!this.modalLapTimes) return;

        const payload = this._modalRunsPayload;
        if (!shouldRenderLeaderboardStandaloneIntro(payload)) return;

        const optionsKey = buildLeaderboardDayRailOptionsKey(payload);
        const railKey = buildLeaderboardDayRailKey(payload);

        const existingRail = this.modalLapTimes.querySelector('.leaderboard-day-rail');
        if (!force && railKey === this._leaderboardDayRailKey && existingRail) {
            return;
        }

        if (
            !force
            && optionsKey === this._leaderboardDayRailOptionsKey
            && this._syncLeaderboardDayRailSelection(payload)
        ) {
            this._leaderboardDayRailKey = railKey;
            return;
        }

        this.modalLapTimes.querySelector('.leaderboard-day-rail')?.remove();
        this._leaderboardDayRailOptionsKey = null;
        this._leaderboardDayRailKey = null;

        if (
            Array.isArray(payload?.leaderboardDayOptions)
            && payload.leaderboardDayOptions.length > 1
        ) {
            const rail = document.createElement('div');
            rail.className = 'leaderboard-day-rail';
            rail.setAttribute('role', 'tablist');
            rail.setAttribute(
                'aria-label',
                payload?.leaderboardRailLabel || 'Leaderboard days',
            );

            for (const option of payload.leaderboardDayOptions) {
                const button = document.createElement('button');
                const hasChallengeId = Boolean(option?.challengeId);
                const isSelected = hasChallengeId
                    && option.challengeId === payload?.selectedLeaderboardDayId;
                button.className = `leaderboard-day-chip${isSelected ? ' is-selected' : ''}`;
                button.type = 'button';
                button.dataset.challengeId = option?.challengeId || '';
                button.setAttribute('role', 'tab');
                button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
                if (!hasChallengeId) {
                    button.disabled = true;
                    button.setAttribute('aria-disabled', 'true');
                } else {
                    button.setAttribute('aria-disabled', isSelected ? 'true' : 'false');
                }
                button.setAttribute(
                    'aria-label',
                    option?.ariaLabel
                        || `View leaderboard for ${option?.dayLabel || 'Day'} ${option?.dateLabel || ''}`.trim()
                );
                if (hasChallengeId) {
                    button.addEventListener('click', () => {
                        this._leaderboardRailScrollLeft = rail.scrollLeft;
                        payload?.onSelectLeaderboardDay?.(option.challengeId);
                    });
                }

                const stack = document.createElement('span');
                stack.className = 'leaderboard-day-chip__stack';

                if (option?.dayLabel === 'Today') {
                    button.classList.add('leaderboard-day-chip--today');
                    const dayLabel = document.createElement('span');
                    dayLabel.className = 'leaderboard-day-chip__day';
                    dayLabel.textContent = 'Today';
                    stack.append(dayLabel);
                } else {
                    const monthLabel = document.createElement('span');
                    monthLabel.className = 'leaderboard-day-chip__month';
                    monthLabel.textContent = option?.monthLabel || '';

                    const dayLabel = document.createElement('span');
                    dayLabel.className = 'leaderboard-day-chip__day';
                    dayLabel.textContent = option?.dayNumberLabel || option?.dateLabel || '--';

                    stack.append(monthLabel, dayLabel);
                }

                button.append(stack);
                rail.appendChild(button);
            }

            this.modalLapTimes.insertBefore(rail, this.modalLapTimes.firstChild);
            if (typeof this._leaderboardRailScrollLeft === 'number') {
                rail.scrollLeft = this._leaderboardRailScrollLeft;
            }
        }

        this._leaderboardDayRailOptionsKey = optionsKey;
        this._leaderboardDayRailKey = railKey;
    }

    _syncLeaderboardDayRailSelection(payload) {
        const rail = this.modalLapTimes?.querySelector('.leaderboard-day-rail');
        const options = payload?.leaderboardDayOptions;
        const selectedId = payload?.selectedLeaderboardDayId;
        if (!rail || !Array.isArray(options) || options.length < 2) return false;

        for (const option of options) {
            const challengeId = option?.challengeId;
            if (!challengeId) continue;
            const button = rail.querySelector(`[data-challenge-id="${challengeId}"]`);
            if (!button) return false;

            const isSelected = challengeId === selectedId;
            button.classList.toggle('is-selected', isSelected);
            button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            button.setAttribute('aria-disabled', isSelected ? 'true' : 'false');
        }

        return true;
    }

    renderLeaderboardHeaderSummary() {
        if (!this.modalLapTimes) return;

        const payload = this._modalRunsPayload;
        if (!shouldRenderLeaderboardStandaloneIntro(payload)) return;

        const rankDisplay = buildScoreboardRankDisplay(
            payload?.scoreboardSnapshot,
            { fallbackText: '—' }
        );
        const isRefreshing = Boolean(payload?.scoreboardSnapshot?.isRefreshing)
            && !rankDisplay.isLoading;

        const rawEntryCount = payload?.scoreboardSnapshot?.leaderboardEntryCount;
        const submittedRacerCount = rawEntryCount != null && Number.isFinite(Number(rawEntryCount))
            ? Math.max(0, Math.trunc(Number(rawEntryCount)))
            : Math.max(0, Math.trunc(Number(payload?.scoreboardSnapshot?.totalCount)));

        const header = this.modalRunsView?.querySelector('.reusable-modal-header');
        if (header) {
            header.querySelector('.leaderboard-summary')?.remove();
        }

        const summary = document.createElement('section');
        summary.className = 'leaderboard-summary leaderboard-summary--header';
        summary.setAttribute('aria-label', 'Your leaderboard standing');

        const summaryValue = document.createElement('span');
        summaryValue.className = 'leaderboard-summary__value';
        summaryValue.toggleAttribute('aria-busy', rankDisplay.isLoading || isRefreshing);
        if (rankDisplay.isLoading) {
            summaryValue.classList.add('is-loading');
            summaryValue.setAttribute('aria-label', 'Loading your rank');
            const loadingLabel = document.createElement('span');
            loadingLabel.textContent = 'Rank';
            const spinner = document.createElement('span');
            spinner.className = 'modal-rank-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            summaryValue.append(loadingLabel, spinner);
        } else if (rankDisplay.text && rankDisplay.text !== 'N/A') {
            summaryValue.textContent = rankDisplay.text;
        } else {
            summaryValue.textContent = 'No time yet';
        }
        if (isRefreshing) {
            summaryValue.classList.add('is-refreshing');
            summaryValue.setAttribute(
                'aria-label',
                `${summaryValue.textContent}; refreshing standings`
            );
            const refreshSpinner = document.createElement('span');
            refreshSpinner.className = 'modal-rank-spinner leaderboard-refresh-spinner';
            refreshSpinner.setAttribute('aria-hidden', 'true');
            summaryValue.prepend(refreshSpinner);
        }

        const summaryMeta = document.createElement('span');
        summaryMeta.className = 'leaderboard-summary__meta';
        if (submittedRacerCount > 0) {
            const racerCountText = submittedRacerCount.toLocaleString();
            summaryMeta.setAttribute(
                'aria-label',
                `${racerCountText} racer${submittedRacerCount === 1 ? '' : 's'}`
            );
            const racerCount = document.createElement('span');
            racerCount.textContent = racerCountText;

            const racerIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            racerIcon.classList.add('leaderboard-summary__racer-icon');
            racerIcon.setAttribute('viewBox', '0 0 640 512');
            racerIcon.setAttribute('fill', 'currentColor');
            racerIcon.setAttribute('aria-hidden', 'true');
            racerIcon.setAttribute('focusable', 'false');
            const racerIconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            racerIconPath.setAttribute('d', 'M320 16a104 104 0 1 1 0 208 104 104 0 1 1 0-208zM96 88a72 72 0 1 1 0 144 72 72 0 1 1 0-144zM0 416c0-70.7 57.3-128 128-128 12.8 0 25.2 1.9 36.9 5.4-32.9 36.8-52.9 85.4-52.9 138.6l0 16c0 11.4 2.4 22.2 6.7 32L32 480c-17.7 0-32-14.3-32-32l0-32zm521.3 64c4.3-9.8 6.7-20.6 6.7-32l0-16c0-53.2-20-101.8-52.9-138.6 11.7-3.5 24.1-5.4 36.9-5.4 70.7 0 128 57.3 128 128l0 32c0 17.7-14.3 32-32 32l-86.7 0zM472 160a72 72 0 1 1 144 0 72 72 0 1 1 -144 0zM160 432c0-88.4 71.6-160 160-160s160 71.6 160 160l0 16c0 17.7-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32l0-16z');
            racerIcon.appendChild(racerIconPath);
            summaryMeta.append(racerCount, racerIcon);
        } else {
            summaryMeta.textContent = 'No racers yet';
        }
        if (rankDisplay.isLoading) {
            summaryMeta.hidden = true;
            summaryMeta.setAttribute('aria-hidden', 'true');
        }

        summary.append(summaryValue, summaryMeta);
        header?.appendChild(summary);
        this.configureRunsModalHeader?.();
    }

    _wireLeaderboardRowShare() {
        const payload = this._modalRunsPayload;
        const challengeId = payload?.scoreboardChallengeId;
        const playerBestTime = Number(payload?.scoreboardSnapshot?.currentPlayerRow?.bestTime);
        if (!Number.isFinite(playerBestTime) || !challengeId) return;
        const row = this.modalLapTimes?.querySelector?.('.leaderboard-row.is-shareable');
        const shareBtn = row?.querySelector?.('.leaderboard-row__share');
        if (!row || !shareBtn) return;

        const trigger = () => {
            if (shareBtn.disabled) return;
            void this._startShare(
                { source: 'standings', challengeId },
                shareBtn,
                this.modalRunsView,
            );
        };
        row.onclick = trigger;
        row.onkeydown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                trigger();
            }
        };
    }

    _showLeaderboardOpponentConfirmation(entry, triggerRow) {
        if (!entry || typeof this._onRaceOpponent !== 'function' || !this.modalRunsView) return;

        this._closeSharePanel?.({ restoreScroll: false });
        const scrim = document.createElement('section');
        scrim.className = 'result-share-panel leaderboard-race-panel';
        scrim.setAttribute('role', 'dialog');
        scrim.setAttribute('aria-modal', 'true');
        scrim.setAttribute('aria-label', 'Confirm ghost opponent');
        scrim.dataset.savedScrollTop = String(this.modalLapTimes?.scrollTop || 0);
        scrim._restoreFocusElement = triggerRow;

        const panel = document.createElement('div');
        panel.className = 'result-share-panel__card leaderboard-race-panel__card';

        const opponentName = typeof entry.displayName === 'string' && entry.displayName.trim()
            ? entry.displayName.trim()
            : 'Anonymous Racer';
        const title = document.createElement('h3');
        title.className = 'result-share-panel__title';
        title.textContent = `Race ${opponentName}?`;

        const payload = this._modalRunsPayload;
        const trackName = payload?.scoreboardTrackKey
            ? getTrackName(payload.scoreboardTrackKey, payload?.scoreboardTitle || 'This track')
            : (payload?.scoreboardTitle || 'This track');
        const selectedContext = payload?.leaderboardDayOptions?.find?.(
            (option) => option?.challengeId === payload?.selectedLeaderboardDayId
        );
        const selectedLabel = payload?.scoreboardMode === 'campaign'
            ? [selectedContext?.monthLabel, selectedContext?.dayNumberLabel].filter(Boolean).join(' ')
            : selectedContext?.dateLabel;
        const context = document.createElement('p');
        context.className = 'result-share-panel__status';
        context.textContent = [trackName, selectedLabel || payload?.scoreboardSubhead]
            .filter(Boolean)
            .join(' · ');

        const target = document.createElement('p');
        target.className = 'result-share-panel__copy leaderboard-race-panel__target';
        const rank = Number.isFinite(Number(entry.rank))
            ? `#${Math.trunc(Number(entry.rank))}`
            : (entry.rankLabel || 'Unranked');
        target.textContent = `${rank} · ${this.content.formatLeaderboardTime(Number(entry.bestTime))}`;

        const actions = document.createElement('div');
        actions.className = 'result-share-panel__actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'result-share-panel__button';
        cancel.textContent = 'Cancel';
        cancel.onclick = () => this._closeSharePanel();

        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'result-share-panel__button result-share-panel__button--primary';
        confirm.textContent = 'Race Ghost';
        confirm.onclick = () => {
            const onRaceOpponent = this._onRaceOpponent;
            confirm.disabled = true;
            cancel.disabled = true;
            confirm.textContent = 'Preparing…';
            context.textContent = 'Loading the verified ghost and split times…';
            const handleResult = (result) => {
                if (result?.ok === false) {
                    throw new Error(result.body?.error || 'This ghost is no longer available.');
                }
                this._closeSharePanel({ restoreScroll: false });
            };
            const handleError = (error) => {
                confirm.disabled = false;
                cancel.disabled = false;
                confirm.textContent = 'Race Ghost';
                context.textContent = error?.message || 'This ghost could not be prepared.';
                context.classList.add('is-error');
            };
            try {
                const result = onRaceOpponent?.(entry);
                if (result && typeof result.then === 'function') {
                    void result.then(handleResult).catch(handleError);
                } else {
                    handleResult(result);
                }
            } catch (error) {
                handleError(error);
            }
        };

        actions.append(cancel, confirm);
        panel.append(title, context, target, actions);
        scrim.appendChild(panel);
        this.modalRunsView.appendChild(scrim);
        this.clearFinishMenuKeyboardCue();
        resetMenuKeyboardState(this._shareMenuKeyboardState, [cancel, confirm], {
            preferredIndex: 1,
            container: actions,
            focusPreferred: true,
        });
    }

    _wireLeaderboardOpponentRace() {
        if (typeof this._onRaceOpponent !== 'function') return;
        const rows = this.modalLapTimes?.querySelectorAll?.('.leaderboard-row.is-raceable') || [];
        rows.forEach((row) => {
            const entry = row._opponentRaceEntry;
            if (!entry) return;
            const trigger = () => this._showLeaderboardOpponentConfirmation(entry, row);
            row.onclick = trigger;
            row.onkeydown = (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    trigger();
                }
            };
        });
    }

    _leaderboardShareBestOption() {
        const payload = this._modalRunsPayload;
        if (payload?.scoreboardMode !== TRACK_MODE_DAILY_GP) return null;
        const challengeId = payload?.scoreboardChallengeId;
        const playerBestTime = Number(payload?.scoreboardSnapshot?.currentPlayerRow?.bestTime);
        if (!Number.isFinite(playerBestTime) || !challengeId) return null;
        return { challengeId, bestTime: playerBestTime };
    }

    unbindLeaderboardPagination() {
        if (this.modalLapTimes && this._leaderboardScrollHandler) {
            this.modalLapTimes.removeEventListener('scroll', this._leaderboardScrollHandler);
        }
        this._leaderboardScrollHandler = null;
        this._leaderboardPageLoading = false;
    }

    bindLeaderboardPagination() {
        this.unbindLeaderboardPagination();
        const onLoadMore = this._modalRunsPayload?.onLoadMoreLeaderboard;
        if (!this.modalLapTimes || typeof onLoadMore !== 'function') return;

        this._leaderboardScrollHandler = async () => {
            if (this._leaderboardPageLoading) return;
            if (!this._modalRunsPayload?.scoreboardSnapshot?.hasMore) return;
            const remaining = this.modalLapTimes.scrollHeight
                - this.modalLapTimes.scrollTop
                - this.modalLapTimes.clientHeight;
            if (remaining > 240) return;

            this._leaderboardPageLoading = true;
            const state = this.modalLapTimes.querySelector('.leaderboard-pagination-state');
            state?.classList.add('is-loading');
            if (state) state.textContent = 'Loading more racers…';
            try {
                await onLoadMore();
            } catch (error) {
                console.error('Error loading more leaderboard rows:', error);
                if (state) state.textContent = 'Could not load more. Scroll to retry.';
            } finally {
                this._leaderboardPageLoading = false;
            }
        };
        this.modalLapTimes.addEventListener('scroll', this._leaderboardScrollHandler, { passive: true });
    }

    unbindLeaderboardDaySwipe() {
        if (this.modalLapTimes) {
            this.modalLapTimes.classList?.remove('leaderboard-day-swipe-enabled');
            if (this._leaderboardTouchStartHandler) {
                this.modalLapTimes.removeEventListener('touchstart', this._leaderboardTouchStartHandler);
            }
            if (this._leaderboardTouchEndHandler) {
                this.modalLapTimes.removeEventListener('touchend', this._leaderboardTouchEndHandler);
            }
            if (this._leaderboardTouchCancelHandler) {
                this.modalLapTimes.removeEventListener('touchcancel', this._leaderboardTouchCancelHandler);
            }
        }
        this._leaderboardSwipeStart = null;
        this._leaderboardTouchStartHandler = null;
        this._leaderboardTouchEndHandler = null;
        this._leaderboardTouchCancelHandler = null;
    }

    bindLeaderboardDaySwipe() {
        this.unbindLeaderboardDaySwipe();
        const options = this._modalRunsPayload?.leaderboardDayOptions;
        const onSelectDay = this._modalRunsPayload?.onSelectLeaderboardDay;
        if (
            !this.modalLapTimes
            || !Array.isArray(options)
            || options.length < 2
            || typeof onSelectDay !== 'function'
        ) {
            return;
        }

        this._leaderboardTouchStartHandler = (event) => {
            this._leaderboardSwipeStart = null;
            if (isLeaderboardSwipeControl(event.target)) return;
            const point = getSingleTouchPoint(event.touches);
            this._leaderboardSwipeStart = point;
        };
        this._leaderboardTouchEndHandler = (event) => {
            const start = this._leaderboardSwipeStart;
            this._leaderboardSwipeStart = null;
            if (!start) return;

            const end = getSingleTouchPoint(event.changedTouches);
            if (!end) return;
            const deltaX = end.x - start.x;
            const deltaY = end.y - start.y;
            if (
                Math.abs(deltaX) < LEADERBOARD_SWIPE_MIN_DISTANCE_PX
                || Math.abs(deltaX) < Math.abs(deltaY) * LEADERBOARD_SWIPE_AXIS_RATIO
            ) {
                return;
            }

            const payload = this._modalRunsPayload;
            const currentOptions = payload?.leaderboardDayOptions;
            if (!Array.isArray(currentOptions)) return;
            const selectedIndex = currentOptions.findIndex(
                (option) => option?.challengeId === payload?.selectedLeaderboardDayId
            );
            if (selectedIndex < 0) return;

            const direction = deltaX < 0 ? 1 : -1;
            let nextIndex = selectedIndex;
            while (true) {
                nextIndex += direction;
                if (nextIndex < 0 || nextIndex >= currentOptions.length) return;
                const nextChallengeId = currentOptions[nextIndex]?.challengeId;
                if (nextChallengeId) {
                    payload?.onSelectLeaderboardDay?.(nextChallengeId);
                    return;
                }
            }
        };
        this._leaderboardTouchCancelHandler = () => {
            this._leaderboardSwipeStart = null;
        };

        this.modalLapTimes.classList?.add('leaderboard-day-swipe-enabled');
        this.modalLapTimes.addEventListener('touchstart', this._leaderboardTouchStartHandler, { passive: true });
        this.modalLapTimes.addEventListener('touchend', this._leaderboardTouchEndHandler, { passive: true });
        this.modalLapTimes.addEventListener('touchcancel', this._leaderboardTouchCancelHandler, { passive: true });
    }

    configureRunsModalHeader() {
        if (!this.modalRunsView) return;

        const payload = this._modalRunsPayload;
        const hasPersonalBestList = Array.isArray(payload?.lapTimesArray);
        const isLeaderboardOnly = Boolean(payload?.showGlobalLeaderboard) && !hasPersonalBestList;
        const trackName = payload?.scoreboardTrackKey
            ? getTrackName(payload.scoreboardTrackKey, null)
            : null;
        const playerBestTime = Number(payload?.scoreboardSnapshot?.currentPlayerRow?.bestTime);
        const playerTimeLabel = Number.isFinite(playerBestTime)
            ? this.content.formatLeaderboardTime(playerBestTime)
            : '';

        configureReusableModal(this.modalRunsView, {
            title: isLeaderboardOnly
                ? (trackName || payload?.scoreboardTitle || 'Standings')
                : 'Your 5 PBs',
            subtitle: isLeaderboardOnly
                ? playerTimeLabel
                : 'Personal Bests',
            closeLabel: this._runsViewMode === 'back' ? 'Back' : 'Close',
        });
    }

    matchesModalScoreboardContext({ challengeId = null, trackKey = null } = {}) {
        if (!this.isModalActive() || !this._modalRunsPayload) return false;

        if (challengeId) {
            return this._modalRunsPayload.scoreboardChallengeId === challengeId;
        }

        if (!trackKey) return false;

        return this._modalRunsPayload.scoreboardTrackKey === trackKey
            && this._modalRunsPayload.scoreboardMode === TRACK_MODE_DAILY_GP;
    }

    isModalActive() {
        return Boolean(this.modal?.classList.contains('active'));
    }

    isRunsViewActive() {
        return this.isModalActive() && Boolean(this.modalRunsView?.classList.contains('active-view'));
    }
}
