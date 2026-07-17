import { TRACK_MODE_DAILY_GP } from '../config.js';
import { renderCachedTrackPreviewCanvas } from '../track/preview-renderer.js';
import { TRACKS } from '../track/tracks.js';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from '../track/presentation.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';
import {
    getMedalRowSlots,
} from '../medals/medals.js';
import { readTrackLastLapMedal } from '../medals/last-lap-medal-storage.js';
import {
    buildModalRunsPayload,
    buildModalStatsPlan,
    buildModalRunsViewOptions,
    buildScoreboardRankDisplay
} from './result-flow.js';
import {
    scheduleCombinedMedalEntranceAfterModal,
    shouldCelebrateMedalTier
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

function isButtonElement(node) {
    return typeof HTMLButtonElement !== 'undefined' && node instanceof HTMLButtonElement;
}

function scheduleAfterModalPaint(callback) {
    requestAnimationFrame(() => {
        requestAnimationFrame(callback);
    });
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
        '.leaderboard-day-rail, button, a, input, select, textarea, [role="button"], .leaderboard-row.is-shareable'
    ));
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
        this._modalCloseFallbackTimer = null;
        this._modalCloseTransitionEndHandler = null;
        this._modalKind = null;
        this._modalPrimaryAction = null;
        this._modalSecondaryAction = null;
        this._modalRunsPayload = null;
        this._runsViewMode = 'close';
        this._runsCloseAction = null;
        this._savedModalState = null;
        this._focusBeforeModal = null;
        this._activeTrapModal = null;
        this._modalTrapKeydown = null;
        this._lastPauseTrackPreviewKey = '';
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
        return document.getElementById('garage-panel')
            || document.getElementById('garage-modal');
    }

    getGarageMenuItems() {
        const tabSkin = document.getElementById('garage-tab-skin');
        const tabTrails = document.getElementById('garage-tab-trails');
        const closeBtn = document.getElementById('garage-close-btn');
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
            [tabSkin, tabTrails, ...options, closeBtn],
            { requireLaidOut: false },
        );
    }

    resetGarageMenuKeyboardNav({ keepCue = false } = {}) {
        const items = this.getGarageMenuItems();
        const container = this.getGarageMenuContainer();
        const firstOptionIndex = items.findIndex((item) => (
            item.classList?.contains?.('garage-skin-option')
            || item.classList?.contains?.('garage-trail-option')
        ));

        if (keepCue && this._garageMenuKeyboardState?.keyboardNavActive) {
            const index = firstOptionIndex >= 0 ? firstOptionIndex : 0;
            this._garageMenuKeyboardState.selectedIndex = index;
            this._garageMenuKeyboardState.keyboardNavActive = true;
            applyMenuSelection(items, index, { showCue: true, container });
            return index;
        }

        return resetMenuKeyboardState(this._garageMenuKeyboardState, items, {
            preferredIndex: 0,
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
            document.getElementById('settings-pb-ghost-switch'),
            document.getElementById('settings-collision-auto-restart-switch'),
            document.getElementById('settings-collision-restart-delay-minus'),
            document.getElementById('settings-collision-restart-delay-meter'),
            document.getElementById('settings-collision-restart-delay-plus'),
            document.getElementById('settings-back-btn'),
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
        const preferred = this._modalKind === 'pause'
            ? this.modalResumeBtn
            : this._modalKind === 'win'
                ? this.combinedRestartBtn
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

        if (trapId !== 'modal') return;

        if (this.isSharePanelOpen()) {
            const shareButtons = this.getSharePanelButtons();
            dismissMenuKeyboardCue(this._shareMenuKeyboardState, shareButtons, {
                container: this.getSharePanelActionsContainer(),
                preferredIndex: shareButtons.length ? shareButtons.length - 1 : null,
            });
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
        const buttons = [this.combinedGarageBtn, this.pauseGarageBtn].filter(Boolean);
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
        this._lastPauseTrackPreviewKey = '';
        const wrap = document.getElementById('modal-pause-track-preview-wrap');
        const canvas = document.getElementById('modal-pause-track-preview');
        const nameEl = document.getElementById('modal-pause-track-name');
        const raceStatsEl = document.getElementById('modal-pause-race-stats');
        if (wrap) {
            wrap.hidden = true;
            wrap.setAttribute('aria-hidden', 'true');
        }
        if (nameEl) {
            nameEl.textContent = '';
        }
        if (raceStatsEl) {
            raceStatsEl.replaceChildren();
            raceStatsEl.hidden = true;
            raceStatsEl.setAttribute('aria-hidden', 'true');
        }
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx?.clearRect(0, 0, canvas.width, canvas.height);
            canvas.setAttribute('aria-label', 'Track layout');
        }
    }

    _renderPauseTrackProgress(container, payload) {
        if (!container) return;

        container.replaceChildren();
        const trackKey = typeof payload?.trackKey === 'string' ? payload.trackKey : null;
        if (!trackKey) {
            container.hidden = true;
            container.setAttribute('aria-hidden', 'true');
            return;
        }

        const medals = document.createElement('div');
        medals.className = 'pause-race-progress__medals';
        medals.setAttribute('aria-label', 'Track medals');

        const bestStoredMedal = readTrackLastLapMedal(trackKey);
        const medalSlots = getMedalRowSlots(trackKey, bestStoredMedal);
        if (medalSlots.length) {
            for (const { tier, filled } of medalSlots) {
                const slot = document.createElement('span');
                slot.className = 'pause-race-progress__medal-slot';
                if (!filled) slot.classList.add('pause-race-progress__medal-slot--locked');
                slot.appendChild(createMedalIconSvg(tier, {
                    className: 'medal-svg--pause',
                    outline: !filled,
                    showEmblem: filled,
                    rowPlaceholder: !filled,
                }));
                medals.appendChild(slot);
            }
        } else {
            medals.appendChild(createMedalIconSvg('white', { className: 'medal-svg--pause medal-svg--row-placeholder' }));
        }

        container.append(medals);
        container.hidden = false;
        container.setAttribute('aria-hidden', 'false');
        container.setAttribute('aria-label', 'Unlocked medals for this track');
    }

    _syncPauseTrackPreview(payload) {
        const wrap = document.getElementById('modal-pause-track-preview-wrap');
        const canvas = document.getElementById('modal-pause-track-preview');
        const nameEl = document.getElementById('modal-pause-track-name');

        if (!payload?.trackKey) {
            this._hidePauseTrackPreview();
            return;
        }
        const track = TRACKS[payload.trackKey];
        if (!track) {
            this._hidePauseTrackPreview();
            return;
        }

        const labelName = (typeof payload.trackName === 'string' && payload.trackName.trim())
            ? payload.trackName.trim()
            : (track.name || payload.trackKey);

        if (nameEl) {
            nameEl.textContent = labelName;
        }

        this._renderPauseTrackProgress(
            document.getElementById('modal-pause-race-stats'),
            payload,
        );

        if (!wrap || !canvas) return;

        const presentation = payload.skin
            ? resolveTrackPresentation(payload.trackKey, {
                surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
                event: {
                    key: 'daily-challenge',
                    trackKey: payload.trackKey,
                    skin: payload.skin,
                },
            })
            : resolveTrackPresentation(payload.trackKey, {
                surface: TRACK_PRESENTATION_SURFACES.RACE,
            });

        wrap.hidden = false;
        wrap.setAttribute('aria-hidden', 'false');

        canvas.setAttribute('aria-label', `Track layout: ${labelName}`);

        const previewKey = `${payload.trackKey}:${payload.skin || 'default'}:${canvas.width}x${canvas.height}`;
        if (this._lastPauseTrackPreviewKey === previewKey) return;
        this._lastPauseTrackPreviewKey = previewKey;

        renderCachedTrackPreviewCanvas(canvas, {
            cacheKey: `pause:${payload.trackKey}:${payload.skin || 'default'}`,
            trackGeometry: { outer: track.outer, inner: track.inner },
            presentation,
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle,
            transparentBackground: true,
            previewRenderMode: 'schematic',
        });
    }

    get modal() { return document.getElementById('modal'); }
    get modalTitle() { return document.getElementById('modal-title'); }
    get modalMsg() { return document.getElementById('modal-msg'); }
    get modalLapTimes() { return document.getElementById('modal-lap-times'); }
    get modalStatsRow() { return document.getElementById('modal-stats-row'); }
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
    get pauseSettingsBtn() { return document.getElementById('pause-settings-btn'); }
    get pauseGarageBtn() { return document.getElementById('pause-garage-btn'); }
    get pausePlaylistBtn() { return document.getElementById('modal-pause-playlist-btn'); }
    get combinedMenuBtn() { return document.getElementById('combined-menu-btn'); }
    get combinedSettingsBtn() { return document.getElementById('combined-settings-btn'); }
    get combinedGarageBtn() { return document.getElementById('combined-garage-btn'); }
    get combinedPlaylistBtn() { return document.getElementById('combined-playlist-btn'); }
    get combinedRestartBtn() { return document.getElementById('combined-restart-btn'); }
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

    _setShareButtonLabel(button, label) {
        const labelNode = button?.querySelector?.('.combined-action-btn-label');
        if (labelNode) labelNode.textContent = label.toUpperCase();
        else if (button) button.textContent = label;
    }

    _closeSharePanel({ restoreScroll = true } = {}) {
        const panel = this.modal?.querySelector?.('.result-share-panel');
        const scrollTop = Number(panel?.dataset?.savedScrollTop);
        resetMenuKeyboardState(this._shareMenuKeyboardState, this.getSharePanelButtons(), {
            container: this.getSharePanelActionsContainer(),
            focusPreferred: false,
        });
        panel?.remove();
        if (restoreScroll && Number.isFinite(scrollTop) && this.modalLapTimes) {
            this.modalLapTimes.scrollTop = scrollTop;
        }
    }

    _showShareOutcome(panel, triggerButton, result) {
        panel.replaceChildren();
        const title = document.createElement('h3');
        title.className = 'result-share-panel__title';
        title.textContent = 'Shared';
        const copy = document.createElement('blockquote');
        copy.className = 'result-share-panel__copy';
        copy.textContent = result?.commentText || 'Your result is already in the score thread.';
        const actions = document.createElement('div');
        actions.className = 'result-share-panel__actions';
        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'result-share-panel__button';
        done.textContent = 'Done';
        done.onclick = () => this._closeSharePanel();
        actions.appendChild(done);
        panel.append(title, copy, actions);
        triggerButton.disabled = true;
        this._setShareButtonLabel(triggerButton, 'Shared');
        resetMenuKeyboardState(this._shareMenuKeyboardState, [done], {
            preferredIndex: 0,
            container: actions,
            focusPreferred: true,
        });
    }

    async _startShare(request, triggerButton, hostView) {
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
        title.textContent = 'Share your time';
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

        const username = this.getRedditUsername?.();
        if (!username) {
            status.textContent = 'Sign in to Reddit to share your time.';
            cancel.textContent = 'Close';
            cancel.focus();
            return;
        }
        if (typeof this.previewShare !== 'function' || typeof this.confirmShare !== 'function') {
            status.textContent = 'Sharing is unavailable right now.';
            return;
        }
        triggerButton.disabled = true;
        status.textContent = 'Preparing your verified result…';
        try {
            const response = await this.previewShare(request);
            const body = response?.body || {};
            if (body.status === 'already_shared') {
                this._showShareOutcome(panel, triggerButton, body);
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
            disclosure.append('Post this comment as ', disclosureUser, '?');
            const copy = document.createElement('blockquote');
            copy.className = 'result-share-panel__copy';
            copy.textContent = body.commentText;
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
            confirm.textContent = 'Post Comment';
            confirm.onclick = async () => {
                confirm.disabled = true;
                cancelReady.disabled = true;
                confirm.textContent = 'Posting…';
                try {
                    const confirmed = await this.confirmShare(body.shareToken);
                    if (!confirmed?.ok || !['shared', 'already_shared'].includes(confirmed?.body?.status)) {
                        throw new Error(confirmed?.body?.error || 'Could not share this result.');
                    }
                    this._showShareOutcome(panel, triggerButton, confirmed.body);
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
        const usesCombinedResults = modalKind === 'win';
        if (lapData) {
            if (this.modalMsg) this.modalMsg.style.display = 'none';
            if (this.modalStatsRow && usesCombinedResults) {
                this.modalStatsRow.replaceChildren();
                this.modalStatsRow.style.display = 'none';
            } else if (this.modalStatsRow) {
                const statsPlan = buildModalStatsPlan(lapData);
                if (statsPlan) {
                    if (statsPlan.kind === 'pause-progress') {
                        this.content.setPauseProgressStats(...statsPlan.args);
                    } else if (statsPlan.kind === 'left-right') {
                        this.content.setModalStatLeftRight(...statsPlan.args);
                    } else if (statsPlan.kind === 'hide') {
                        this.modalStatsRow.replaceChildren();
                    } else if (statsPlan.kind === 'win') {
                        this.content.setWinStats(...statsPlan.args, {
                            showDelta: statsPlan.showDelta !== false,
                            lapMedal: statsPlan.lapMedal ?? null
                        });
                    }

                    if (statsPlan.rankSnapshot) {
                        this.modalStatsRow.appendChild(
                            this.createRankModalStat(statsPlan.rankSnapshot)
                        );
                    }

                    if (statsPlan.hasRuns === null) {
                        delete this.modalStatsRow.dataset.hasRuns;
                    } else {
                        this.modalStatsRow.dataset.hasRuns = statsPlan.hasRuns;
                    }
                    this.modalStatsRow.style.display = statsPlan.display;
                }
            }
        } else {
            if (this.modalMsg) {
                this.modalMsg.style.display = '';
                this.modalMsg.textContent = msg || '';
            }
            if (this.modalStatsRow) this.modalStatsRow.style.display = 'none';
        }

        if (lapData?.listData !== undefined && this.modalLapTimes) {
            this.modalLapTimes.replaceChildren();
            this.content.renderLapTimesList(this.modalLapTimes, lapData.listData, lapData.bestTime, lapData.lapTime);
        } else if (lapData?.lapTimesArray !== undefined && this.modalLapTimes) {
            this.modalLapTimes.replaceChildren();
            this.content.renderLapTimesList(this.modalLapTimes, lapData.lapTimesArray, lapData.bestTime, lapData.lapTime);
        } else if (lapData && this.modalLapTimes) {
            this.modalLapTimes.replaceChildren();
        }

        if (this._modalKind === 'win') {
            this.showCombinedResults(lapData, options);
            return;
        }

        if (this._modalKind === 'pause') {
            this.showPauseResults(lapData, options);
            return;
        }

        this.showMainResults(options);
    }

    showPauseResults(lapData, options = {}) {
        if (!this.modal || !this.modalPauseView) return;

        this.cancelPendingModalClose();
        this._bindClickAction(this.modalMenuBtn, options.secondaryAction);
        this._bindClickAction(this.pauseSettingsBtn, options.settingsAction);
        this._bindCombinedGarageBtn(this.pauseGarageBtn);
        this._bindClickAction(this.pausePlaylistBtn, options.playlistAction);
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

        this.content.renderCombinedResults(this.modalCombinedView, {
            time: lapData.lapTime,
            bestLap: lapData.bestTime,
            scoreboardSnapshot: lapData.scoreboardSnapshot,
            title: 'RACE COMPLETE',
            statLabels: ['THIS LAP'],
            lapMedal: lapData.lapMedal ?? null,
            previousPersonalBestSec: lapData.previousPersonalBestSec,
            deltaToPersonalBest: lapData.deltaToPersonalBest,
            previousTrackMedal: lapData.previousTrackMedal ?? null,
            trackKey: lapData.trackKey || this.getCurrentTrackKey(),
            lapCheckpointTimes: lapData.lapCheckpointTimes,
            pbCheckpointTimes: lapData.pbCheckpointTimes,
            pbFinishSec: lapData.pbFinishSec,
        });

        const finishResultModal = (fn) => {
            if (!fn) return null;
            return () => fn();
        };

        if (this.combinedRestartBtn) {
            const labelSpan = this.combinedRestartBtn.querySelector('.combined-action-btn-label');
            if (labelSpan) labelSpan.textContent = 'IMPROVE';
            this.combinedRestartBtn.setAttribute(
                'aria-label',
                'Improve time'
            );
        }
        if (this.combinedPlaylistBtn) {
            this._setShareButtonLabel(this.combinedPlaylistBtn, 'Share Time');
            this.combinedPlaylistBtn.setAttribute('aria-label', 'Share time');
            this.combinedPlaylistBtn.disabled = false;
        }

        this._bindClickAction(this.combinedMenuBtn, finishResultModal(options.secondaryAction));
        this._bindClickAction(this.combinedSettingsBtn, options.settingsAction);
        this._bindCombinedGarageBtn(this.combinedGarageBtn);
        this._bindClickAction(
            this.combinedPlaylistBtn,
            options.shareRequest
                ? () => void this._startShare(options.shareRequest, this.combinedPlaylistBtn, this.modalCombinedView)
                : options.playlistAction,
        );
        this._bindClickAction(this.combinedRestartBtn, finishResultModal(options.restartAction || options.primaryAction));
        this._syncGarageButtonToPanelState();

        // Bind click/tap interaction for global leaderboard modal on rank tap
        const rightGroupEl = this.modalCombinedView?.querySelector('#combined-stats-right-group');
        if (rightGroupEl) {
            const canOpenLeaderboard = Boolean(
                this._modalRunsPayload?.scoreboardTrackKey
                && this._modalRunsPayload?.allowLeaderboardOpen !== false
            );
            if (canOpenLeaderboard) {
                rightGroupEl.classList.add('combined-stats-right-group--interactive');
                rightGroupEl.onclick = () => {
                    this.showModalLeaderboardPayload();
                };
            } else {
                rightGroupEl.classList.remove('combined-stats-right-group--interactive');
                rightGroupEl.onclick = null;
            }
        }

        this._setActiveView(this.modalCombinedView);

        openModalElement(this.modal, () => this.modal.classList.add('active'));

        const heroMedalEl = this.modalCombinedView?.querySelector('#combined-hero-medal');
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
        scheduleCombinedMedalEntranceAfterModal(this.modal, this.modalCombinedView, {
            heroMedalEl,
            stackEl: null
        }, {
            staggerMs: 85,
            stackAfterHeroMs: 0,
            shouldCelebrateTier,
            playUnlockSound
        });

        scheduleAfterModalPaint(() => {
            this.resetMenuKeyboardNav?.();
            this.activateModalFocusTrap(this.modal);
        });
    }

    showRunsModal(lapTimesArray, bestTime, currentTime = null, returnMode = 'close', {
        scoreboardSnapshot = null,
        scoreboardChallengeId = null,
        scoreboardTrackKey = null,
        scoreboardTitle = null,
        scoreboardSubhead = null,
        leaderboardDayOptions = null,
        selectedLeaderboardDayId = null,
        onSelectLeaderboardDay = null,
        onLoadMoreLeaderboard = null,
        showGlobalLeaderboard = true,
        allowLeaderboardOpen = true,
        onClose = null
    } = {}) {
        if (!this.modal || !this.modalTitle || !this.modalLapTimes || !this.modalRunsView || !this.modalMainView) return;

        this.cancelPendingModalClose();
        this._closeSharePanel?.({ restoreScroll: false });
        const wasActive = this.isModalActive();

        // Save previous view state before clearing
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
        const hasPersonalBestList = Array.isArray(lapTimesArray);
        this.content.renderLapTimesList(this.modalLapTimes, lapTimesArray, bestTime, currentTime);
        this._modalRunsPayload = buildModalRunsPayload({
            lapTimesArray,
            bestTime,
            currentTime,
            scoreboardChallengeId,
            scoreboardTrackKey,
            scoreboardSnapshot,
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTitle,
            scoreboardSubhead,
            leaderboardDayOptions,
            selectedLeaderboardDayId,
            onSelectLeaderboardDay,
            onLoadMoreLeaderboard,
            showGlobalLeaderboard,
            allowLeaderboardOpen
        }, {
            currentTrackKey: this.getCurrentTrackKey()
        });
        this._runsViewMode = returnMode === 'back' ? 'back' : 'close';
        this._runsCloseAction = typeof onClose === 'function' ? onClose : null;
        this.configureRunsModalHeader?.();
        this.renderLeaderboardStandaloneIntro?.();
        if (this._modalRunsPayload.showGlobalLeaderboard) {
            const shareBest = this._leaderboardShareBestOption();
            this.content.renderScoreboardList(
                this.modalLapTimes,
                this._modalRunsPayload.scoreboardSnapshot,
                TRACK_MODE_DAILY_GP,
                this._modalRunsPayload.scoreboardTrackKey,
                this._modalRunsPayload.scoreboardSubhead,
                { showHeader: hasPersonalBestList, shareBest }
            );
        }
        this.bindLeaderboardPagination?.();
        this.bindLeaderboardDaySwipe?.();
        this._wireLeaderboardRowShare?.();

        if (this.backToMainBtn) {
            this.backToMainBtn.setAttribute('aria-label', 'Back');
        }
        this._setActiveView(this.modalRunsView);
        openModalElement(this.modal, () => this.modal.classList.add('active'));
        if (wasActive) {
            scheduleAfterModalPaint(() => {
                this.content.centerLeaderboardCurrentRow();
                if (this.backToMainBtn) {
                    this.backToMainBtn.focus();
                }
            });
            return;
        }
        scheduleAfterModalPaint(() => {
            this.content.centerLeaderboardCurrentRow();
            this.activateModalFocusTrap(this.modal);
        });
    }

    closeModal() {
        if (!this.modal) return;

        this._closeSharePanel({ restoreScroll: false });
        this._leaderboardRailScrollLeft = null;
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
        if (this._runsViewMode === 'close') {
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
        if (
            this._modalKind === 'win'
            && this.combinedRestartBtn?.offsetParent !== null
        ) {
            return this.combinedRestartBtn;
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
                document.getElementById('garage-close-btn')?.click();
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
            if (handleMenuListKeydown(event, {
                buttons: this.getGarageMenuItems(),
                state: this._garageMenuKeyboardState,
                container: this.getGarageMenuContainer(),
            })) {
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

    getModalScoreboardStatusText(scoreboardSnapshot) {
        return buildScoreboardRankDisplay(scoreboardSnapshot).statusText;
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
            const hasPersonalBestList = Array.isArray(this._modalRunsPayload.lapTimesArray);
            this.modalLapTimes.querySelector('.leaderboard-section')?.remove();
            this.renderLeaderboardStandaloneIntro();
            if (this._modalRunsPayload.showGlobalLeaderboard) {
                const shareBest = this._leaderboardShareBestOption();
                this.content.renderScoreboardList(
                    this.modalLapTimes,
                    this._modalRunsPayload.scoreboardSnapshot,
                    TRACK_MODE_DAILY_GP,
                    this._modalRunsPayload.scoreboardTrackKey,
                    this._modalRunsPayload.scoreboardSubhead,
                    { showHeader: hasPersonalBestList, shareBest }
                );
            }
            this.bindLeaderboardPagination?.();
            this._wireLeaderboardRowShare?.();
            this.modalLapTimes.scrollTop = scrollTop;
            return;
        }

        if (this.modalCombinedView?.classList.contains('active-view')) {
            const rightGroupEl = this.modalCombinedView.querySelector('#combined-stats-right-group');
            const rankValueEl = this.modalCombinedView.querySelector('#combined-rank-value');
            const rankTotalEl = this.modalCombinedView.querySelector('#combined-rank-total');
            if (!rankValueEl) {
                if (rightGroupEl) {
                    rightGroupEl.hidden = true;
                    rightGroupEl.setAttribute('hidden', '');
                    rightGroupEl.setAttribute('aria-hidden', 'true');
                }
                if (rankValueEl) rankValueEl.textContent = '';
                if (rankTotalEl) rankTotalEl.textContent = '';
                return;
            }

            const rankDisplay = buildScoreboardRankDisplay(scoreboardSnapshot);
            const shouldShowStatusText = Boolean(rankDisplay.statusText)
                && (
                    rankDisplay.isLoading
                    || !rankDisplay.text
                    || rankDisplay.text === 'N/A'
                    || scoreboardSnapshot?.verificationState === 'error'
                    || scoreboardSnapshot?.verificationState === 'rejected'
                );
            rankValueEl.classList.toggle('combined-rank-value--status', shouldShowStatusText);
            if (rankDisplay.isLoading) {
                if (rightGroupEl) {
                    rightGroupEl.hidden = false;
                    rightGroupEl.removeAttribute('hidden');
                    rightGroupEl.removeAttribute('aria-hidden');
                }
                rankValueEl.textContent = rankDisplay.statusText || '--';
                if (rankTotalEl) {
                    rankTotalEl.textContent = '';
                    rankTotalEl.hidden = true;
                    rankTotalEl.setAttribute('hidden', '');
                }
            } else if (shouldShowStatusText) {
                if (rightGroupEl) {
                    rightGroupEl.hidden = false;
                    rightGroupEl.removeAttribute('hidden');
                    rightGroupEl.removeAttribute('aria-hidden');
                }
                rankValueEl.textContent = rankDisplay.statusText || '';
                if (rankTotalEl) {
                    rankTotalEl.textContent = '';
                    rankTotalEl.hidden = true;
                    rankTotalEl.setAttribute('hidden', '');
                }
            } else if (!rankDisplay.text || rankDisplay.text === 'N/A') {
                if (rightGroupEl) {
                    rightGroupEl.hidden = true;
                    rightGroupEl.setAttribute('hidden', '');
                    rightGroupEl.setAttribute('aria-hidden', 'true');
                }
                rankValueEl.textContent = '';
                if (rankTotalEl) rankTotalEl.textContent = '';
            } else {
                if (rightGroupEl) {
                    rightGroupEl.hidden = false;
                    rightGroupEl.removeAttribute('hidden');
                    rightGroupEl.removeAttribute('aria-hidden');
                }
                const rankText = rankDisplay.text || '';
                if (rankText.startsWith('#')) {
                    rankValueEl.innerHTML = `<span class="rank-hash">#</span><span class="rank-num">${rankText.slice(1)}</span>`;
                } else {
                    rankValueEl.textContent = rankText;
                }
                
                const totalRaw = Number(scoreboardSnapshot?.totalCount);
                const totalVal = Number.isFinite(totalRaw) && totalRaw > 0 ? Math.trunc(totalRaw) : 0;
                if (rankTotalEl) {
                    if (totalVal > 0) {
                        rankTotalEl.textContent = `of ${totalVal.toLocaleString()}`;
                        rankTotalEl.hidden = false;
                        rankTotalEl.removeAttribute('hidden');
                    } else {
                        rankTotalEl.textContent = '';
                        rankTotalEl.hidden = true;
                        rankTotalEl.setAttribute('hidden', '');
                    }
                }
            }
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

    updateModalRunSummary({
        bestTime = undefined,
        currentTime = undefined,
        lapTimesArray = undefined
    } = {}) {
        if (!this._modalRunsPayload) return;
        this._modalRunsPayload = buildModalRunsPayload(this._modalRunsPayload, {
            updates: { bestTime, currentTime, lapTimesArray }
        });

        if (bestTime !== undefined) {
            const primaryValue = this.modalStatsRow?.querySelector('.modal-stat-stack:not([data-modal-rank-stat]) .modal-stat-value');
            if (primaryValue && Number.isFinite(bestTime)) {
                primaryValue.textContent = `${bestTime.toFixed(2)}s`;
            }
        }

        if (!this.modalLapTimes) return;

        if (this.modalRunsView?.classList.contains('active-view')) {
            this.showRunsModal(
                this._modalRunsPayload.lapTimesArray,
                this._modalRunsPayload.bestTime,
                this._modalRunsPayload.currentTime,
                this._runsViewMode,
                buildModalRunsViewOptions(this._modalRunsPayload)
            );
            return;
        }

        if (!this.modalMainView?.classList.contains('active-view')) return;

        this.modalLapTimes.replaceChildren();
        if (this._modalRunsPayload.lapTimesArray !== undefined && this._modalRunsPayload.lapTimesArray !== null) {
            this.content.renderLapTimesList(
                this.modalLapTimes,
                this._modalRunsPayload.lapTimesArray,
                this._modalRunsPayload.bestTime,
                this._modalRunsPayload.currentTime
            );
        }
    }

    showModalLeaderboardPayload() {
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

    showModalRunsPayload() {
        if (!this._modalRunsPayload) return;

        this.showRunsModal(
            this._modalRunsPayload.lapTimesArray,
            this._modalRunsPayload.bestTime,
            this._modalRunsPayload.currentTime,
            'back',
            buildModalRunsViewOptions(this._modalRunsPayload)
        );
    }

    renderLeaderboardStandaloneIntro() {
        if (!this.modalLapTimes) return;

        const payload = this._modalRunsPayload;
        const hasPersonalBestList = Array.isArray(payload?.lapTimesArray);
        const isLeaderboardOnly = Boolean(payload?.showGlobalLeaderboard) && !hasPersonalBestList;
        const isDailyChallengeLeaderboard = Boolean(payload?.scoreboardChallengeId)
            || Array.isArray(payload?.leaderboardDayOptions);
        if (!isLeaderboardOnly || !isDailyChallengeLeaderboard) return;

        const trackName = payload?.scoreboardTrackKey && TRACKS[payload.scoreboardTrackKey]
            ? TRACKS[payload.scoreboardTrackKey].name
            : 'This track';
        const rankDisplay = buildScoreboardRankDisplay(
            payload?.scoreboardSnapshot,
            { fallbackText: '—' }
        );
        const isRefreshing = Boolean(payload?.scoreboardSnapshot?.isRefreshing)
            && !rankDisplay.isLoading;
        this.modalLapTimes.querySelector('.leaderboard-day-rail')?.remove();
        if (
            Array.isArray(payload?.leaderboardDayOptions)
            && payload.leaderboardDayOptions.length > 1
        ) {
            const rail = document.createElement('div');
            rail.className = 'leaderboard-day-rail';
            rail.setAttribute('role', 'tablist');
            rail.setAttribute('aria-label', 'Leaderboard days');

            for (const option of payload.leaderboardDayOptions) {
                const button = document.createElement('button');
                const isSelected = option?.challengeId === payload?.selectedLeaderboardDayId;
                button.className = `leaderboard-day-chip${isSelected ? ' is-selected' : ''}`;
                button.type = 'button';
                button.setAttribute('role', 'tab');
                button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
                button.setAttribute(
                    'aria-label',
                    `View leaderboard for ${option?.dayLabel || 'Day'} ${option?.dateLabel || ''}`.trim()
                );
                button.disabled = isSelected;
                button.addEventListener('click', () => {
                    this._leaderboardRailScrollLeft = rail.scrollLeft;
                    payload?.onSelectLeaderboardDay?.(option?.challengeId);
                });

                const dayLabel = document.createElement('span');
                dayLabel.className = 'leaderboard-day-chip__day';
                dayLabel.textContent = option?.dayLabel === 'Today'
                    ? 'Today'
                    : option?.dateLabel || '--';

                button.append(dayLabel);
                rail.appendChild(button);
            }

            this.modalLapTimes.appendChild(rail);
            if (typeof this._leaderboardRailScrollLeft === 'number') {
                rail.scrollLeft = this._leaderboardRailScrollLeft;
            }
        }

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

    _leaderboardShareBestOption() {
        const payload = this._modalRunsPayload;
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

            const nextIndex = deltaX < 0 ? selectedIndex + 1 : selectedIndex - 1;
            const nextChallengeId = currentOptions[nextIndex]?.challengeId;
            if (!nextChallengeId) return;
            payload?.onSelectLeaderboardDay?.(nextChallengeId);
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
        const trackName = payload?.scoreboardTrackKey && TRACKS[payload.scoreboardTrackKey]
            ? TRACKS[payload.scoreboardTrackKey].name
            : null;
        const playerBestTime = Number(payload?.scoreboardSnapshot?.currentPlayerRow?.bestTime);
        const playerTimeLabel = Number.isFinite(playerBestTime)
            ? this.content.formatTime(playerBestTime)
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
