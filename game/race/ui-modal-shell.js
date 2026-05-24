import { TRACK_MODE_DAILY_GP, CONFIG } from '../config.js?v=1.91';
import { renderTrackPreviewCanvas } from '../track/preview-renderer.js?v=1.91';
import { TRACKS } from '../track/tracks.js?v=1.91';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from '../track/presentation.js?v=1.91';
import {
    getSkillPointDisplayValues,
    normalizeSkillPointAllocation,
    SKILL_POINT_DEFINITIONS,
    SKILL_POINT_TOTAL,
} from '../car/skill-points.js?v=1.91';
import {
    buildModalRunsPayload,
    buildModalStatsPlan,
    buildModalRunsViewOptions,
    buildScoreboardRankDisplay
} from './result-flow.js?v=1.91';
import {
    scheduleCombinedMedalEntranceAfterModal,
    shouldCelebrateMedalTier
} from '../medals/medals.js?v=2.04';

function isButtonElement(node) {
    return typeof HTMLButtonElement !== 'undefined' && node instanceof HTMLButtonElement;
}

function scheduleAfterModalPaint(callback) {
    requestAnimationFrame(() => {
        requestAnimationFrame(callback);
    });
}

export class ModalShell {
    constructor({
        content,
        getLeaderboards = () => null,
        getCurrentTrackKey = () => null,
        getDefaultPrimaryAction = () => null,
        cancelLeaderboardRequests = null,
        playUnlockSound = () => null,
        getSkillPointsUi = null,
    } = {}) {
        this.content = content;
        this.getLeaderboards = getLeaderboards;
        this.getCurrentTrackKey = getCurrentTrackKey;
        this.getDefaultPrimaryAction = getDefaultPrimaryAction;
        this.cancelLeaderboardRequests = cancelLeaderboardRequests;
        this.playUnlockSound = playUnlockSound;
        this.getSkillPointsUi = getSkillPointsUi;
        this._modalCloseFallbackTimer = null;
        this._modalCloseTransitionEndHandler = null;
        this._mainModalIsCrash = false;
        this._modalKind = null;
        this._modalPrimaryAction = null;
        this._modalSecondaryAction = null;
        this._modalRunsPayload = null;
        this._runsViewMode = 'close';
        this._focusBeforeModal = null;
        this._activeTrapModal = null;
        this._modalTrapKeydown = null;
    }

    _syncGarageButtonToPanelState() {
        const btn = this.combinedTuneBtn;
        if (!btn) return;
        const garageOpen = Boolean(this.getSkillPointsUi?.()?.isGarageOpen?.());
        btn.classList.toggle('combined-action-btn--active', garageOpen);
        btn.setAttribute('aria-expanded', garageOpen ? 'true' : 'false');
    }

    _openGarageModal() {
        const skillPointsUi = this.getSkillPointsUi?.();
        skillPointsUi?.setPanelVisible?.(true);
        this._syncGarageButtonToPanelState();
    }

    _bindCombinedGarageBtn(btn) {
        if (!btn) return;
        const newBtn = btn.cloneNode(true);
        btn.replaceWith(newBtn);
        let tapLocked = false;
        const onGarageActivate = (event) => {
            if (tapLocked) return;
            tapLocked = true;
            setTimeout(() => {
                tapLocked = false;
            }, 500);
            event?.preventDefault?.();
            event?.stopPropagation?.();
            this._openGarageModal();
        };
        if (typeof window !== 'undefined' && window.PointerEvent) {
            let activePointerId = null;
            newBtn.addEventListener('pointerdown', (event) => {
                if (event.pointerType === 'mouse' && event.button !== 0) return;
                activePointerId = event.pointerId;
            });
            newBtn.addEventListener('pointerup', (event) => {
                if (event.pointerType === 'mouse' && event.button !== 0) return;
                if (event.pointerId !== activePointerId) return;
                activePointerId = null;
                onGarageActivate(event);
            });
            newBtn.addEventListener('pointercancel', () => {
                activePointerId = null;
            });
            newBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
            }, true);
            return;
        }
        if (typeof window !== 'undefined' && navigator.maxTouchPoints > 0) {
            newBtn.addEventListener('touchend', onGarageActivate, { passive: false });
            newBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
            }, true);
            return;
        }
        newBtn.addEventListener('click', onGarageActivate);
    }

    _hidePauseTrackPreview() {
        const wrap = document.getElementById('modal-pause-track-preview-wrap');
        const canvas = document.getElementById('modal-pause-track-preview');
        const nameEl = document.getElementById('modal-pause-track-name');
        const raceStatsEl = document.getElementById('modal-pause-race-stats');
        const tuningEl = document.getElementById('modal-pause-tuning');
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
        if (tuningEl) {
            tuningEl.replaceChildren();
        }
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx?.clearRect(0, 0, canvas.width, canvas.height);
            canvas.setAttribute('aria-label', 'Track layout');
        }
    }

    _createPauseCombinedStat(label, value) {
        const stat = document.createElement('div');
        stat.className = 'combined-stat';
        const labelEl = document.createElement('span');
        labelEl.className = 'combined-stat-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'combined-stat-value';
        valueEl.textContent = value;
        stat.append(labelEl, valueEl);
        return stat;
    }

    _renderPauseRaceStats(lapData) {
        const raceStatsEl = document.getElementById('modal-pause-race-stats');
        if (!raceStatsEl) return;

        if (lapData?.variant !== 'daily-crash-budget-pause') {
            raceStatsEl.replaceChildren();
            raceStatsEl.hidden = true;
            raceStatsEl.setAttribute('aria-hidden', 'true');
            return;
        }

        const laps = `${Math.max(0, Math.trunc(lapData.completedLaps || 0))}`;
        const crashesLeft = `${Math.max(0, Math.trunc(lapData.crashesLeft || 0))}`;
        raceStatsEl.replaceChildren(
            this._createPauseCombinedStat('Laps', laps),
            this._createPauseCombinedStat('Crashes Left', crashesLeft)
        );
        raceStatsEl.hidden = false;
        raceStatsEl.setAttribute('aria-hidden', 'false');
    }

    _renderPauseTuningReadonly(container, allocation) {
        container.replaceChildren();
        if (!allocation || typeof allocation !== 'object') return;
        const alloc = normalizeSkillPointAllocation(allocation);
        const statValues = getSkillPointDisplayValues(CONFIG, alloc);
        for (const def of SKILL_POINT_DEFINITIONS) {
            const row = document.createElement('div');
            row.className = 'modal-pause-skill-row';
            const labelEl = document.createElement('div');
            labelEl.className = 'modal-pause-skill-label';
            labelEl.textContent = def.label;
            const value = Math.trunc(alloc[def.key] || 0);
            const meter = document.createElement('div');
            meter.className = 'modal-pause-meter';
            meter.setAttribute('aria-label', `${def.label}: ${value} of ${SKILL_POINT_TOTAL}`);
            for (let index = 0; index < SKILL_POINT_TOTAL; index += 1) {
                const segment = document.createElement('span');
                segment.className = 'modal-pause-meter__segment';
                segment.classList.toggle('is-filled', index < value);
                meter.appendChild(segment);
            }
            const effect = document.createElement('div');
            effect.className = 'modal-pause-skill-effect';
            if (def.key === 'accel') {
                effect.textContent = statValues.accelNumber || statValues.accel || '';
            } else if (def.key === 'speed') {
                effect.textContent = statValues.speedNumber || statValues.speed || '';
            } else {
                effect.textContent = statValues.handlingNumber || statValues.handling || '';
            }
            row.append(labelEl, meter, effect);
            container.appendChild(row);
        }
    }

    _syncPauseTrackPreview(payload) {
        const wrap = document.getElementById('modal-pause-track-preview-wrap');
        const canvas = document.getElementById('modal-pause-track-preview');
        if (!wrap || !canvas) return;
        if (!payload?.trackKey) {
            this._hidePauseTrackPreview();
            return;
        }
        const track = TRACKS[payload.trackKey];
        if (!track) {
            this._hidePauseTrackPreview();
            return;
        }

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

        const nameEl = document.getElementById('modal-pause-track-name');
        const labelName = (typeof payload.trackName === 'string' && payload.trackName.trim())
            ? payload.trackName.trim()
            : (track.name || payload.trackKey);
        if (nameEl) {
            nameEl.textContent = labelName;
        }

        const tuningEl = document.getElementById('modal-pause-tuning');
        if (tuningEl) {
            if (payload.skillAllocation && typeof payload.skillAllocation === 'object') {
                this._renderPauseTuningReadonly(tuningEl, payload.skillAllocation);
            } else {
                tuningEl.replaceChildren();
            }
        }

        canvas.setAttribute('aria-label', `Track layout: ${labelName}`);

        renderTrackPreviewCanvas(canvas, {
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
    get modalRunsView() { return document.getElementById('modal-runs-view'); }
    get modalResumeBtn() { return document.getElementById('modal-resume-btn'); }
    get modalRestartBtn() { return document.getElementById('modal-restart-btn'); }
    get modalMenuBtn() { return document.getElementById('modal-menu-btn'); }
    get modalCombinedView() { return document.getElementById('modal-combined-view'); }
    get modalPauseView() { return document.getElementById('modal-pause-view'); }
    get pauseSettingsBtn() { return document.getElementById('pause-settings-btn'); }
    get combinedMenuBtn() { return document.getElementById('combined-menu-btn'); }
    get combinedTuneBtn() { return document.getElementById('combined-tune-btn'); }
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

    showModal(title, msg, lapData, options = {}) {
        if (!this.modal || !this.modalTitle) return;

        this.cancelPendingModalClose();
        const modalKind = options.modalKind || null;
        if (modalKind !== 'pause') {
            this._hidePauseTrackPreview();
        }
        this.modalTitle.textContent = title;
        this._mainModalIsCrash = Boolean(lapData?.isCrash) || modalKind === 'crash';
        this._modalKind = modalKind;
        this.modal.classList.toggle('modal--crash', this._mainModalIsCrash);
        this.modal.classList.toggle('modal--win', this._modalKind === 'win');
        this.modal.classList.toggle('modal--pause', this._modalKind === 'pause' || this._modalKind === 'crash');
        this._modalPrimaryAction = options.primaryAction || this.getDefaultPrimaryAction();
        this._modalSecondaryAction = options.secondaryAction || null;
        this._modalRunsPayload = buildModalRunsPayload(lapData, {
            currentTrackKey: this.getCurrentTrackKey()
        });
        const usesCombinedResults = modalKind === 'win' || modalKind === 'crash';
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
                    } else if (statsPlan.kind === 'crash') {
                        this.content.setModalStatCenter(...statsPlan.args);
                    } else if (statsPlan.kind === 'daily-crash-budget') {
                        this.modalStatsRow.replaceChildren();
                        this.modalStatsRow.appendChild(this.content.createModalStat(
                            'Laps',
                            statsPlan.args[0],
                            'modal-stat-value--best'
                        ));
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

        if (this._modalKind === 'win' || this._modalKind === 'crash') {
            this.showCombinedResults(lapData, options);
            return;
        }

        if (this._modalKind === 'pause') {
            this.showPauseResults(lapData, options);
            return;
        }

        if (this.modalMainView && this.modalRunsView) {
            this.showMainModalView();
        }

        this.modal.classList.add('active');
        scheduleAfterModalPaint(() => this.activateModalFocusTrap(this.modal));
    }

    showPauseResults(lapData, options = {}) {
        if (!this.modal || !this.modalPauseView) return;

        this.cancelPendingModalClose();
        this._renderPauseRaceStats(lapData);

        this._bindClickAction(this.modalMenuBtn, options.secondaryAction);
        this._bindClickAction(this.pauseSettingsBtn, options.settingsAction);
        this._bindClickAction(this.modalRestartBtn, options.restartAction);
        this._bindClickAction(this.modalResumeBtn, options.primaryAction);

        this.modalMainView?.classList.remove('active-view');
        this.modalRunsView?.classList.remove('active-view');
        this.modalCombinedView?.classList.remove('active-view');
        this.modalPauseView.classList.add('active-view');

        this.modal.classList.add('active');
        scheduleAfterModalPaint(() => {
            this._syncPauseTrackPreview(options.pauseTrackPreview);
            this.activateModalFocusTrap(this.modal);
        });
    }

    showCombinedResults(lapData, options = {}) {
        if (!this.modal || !this.modalCombinedView) return;

        this.cancelPendingModalClose();
        const isCrash = this._modalKind === 'crash';

        this.content.renderCombinedResults(this.modalCombinedView, {
            time: lapData.lapTime,
            bestLap: lapData.bestTime,
            crashImpact: isCrash ? lapData.impact : null,
            crashElapsedSec: isCrash ? lapData.currentTime : null,
            scoreboardSnapshot: lapData.scoreboardSnapshot,
            title: isCrash ? 'CRASHED' : 'RACE COMPLETE',
            statLabels: isCrash ? ['IMPACT', 'RUN TIME'] : ['THIS LAP'],
            lapMedal: isCrash ? null : (lapData.lapMedal ?? null),
            previousPersonalBestSec: isCrash ? undefined : lapData.previousPersonalBestSec,
            deltaToPersonalBest: isCrash ? undefined : lapData.deltaToPersonalBest,
            previousTrackMedal: isCrash ? null : (lapData.previousTrackMedal ?? null),
            trackKey: lapData.trackKey || this.getCurrentTrackKey(),
            lapCheckpointTimes: isCrash ? null : lapData.lapCheckpointTimes,
            pbCheckpointTimes: isCrash ? null : lapData.pbCheckpointTimes,
            pbFinishSec: isCrash ? null : lapData.pbFinishSec,
            crashCombined: isCrash
        });

        const finishResultModal = (fn) => {
            if (!fn) return null;
            return () => fn();
        };

        if (this.combinedRestartBtn) {
            const labelSpan = this.combinedRestartBtn.querySelector('.combined-action-btn-label');
            if (labelSpan) labelSpan.textContent = isCrash ? 'RETRY' : 'IMPROVE';
            this.combinedRestartBtn.setAttribute(
                'aria-label',
                isCrash ? 'Restart race' : 'Improve time'
            );
        }

        this._bindClickAction(this.combinedMenuBtn, finishResultModal(options.secondaryAction));
        this._bindCombinedGarageBtn(this.combinedTuneBtn);
        this._bindClickAction(this.combinedRestartBtn, finishResultModal(options.restartAction || options.primaryAction));

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

        this.modalMainView?.classList.remove('active-view');
        this.modalRunsView?.classList.remove('active-view');
        this.modalPauseView?.classList.remove('active-view');
        this.modalCombinedView.classList.add('active-view');

        this.modal.classList.add('active');

        const heroMedalEl = this.modalCombinedView?.querySelector('#combined-hero-medal');
        const previousTrackMedal = isCrash ? null : (lapData.previousTrackMedal ?? null);
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

        scheduleAfterModalPaint(() => this.activateModalFocusTrap(this.modal));
    }

    showRunsModal(lapTimesArray, bestTime, currentTime = null, returnMode = 'close', {
        scoreboardSnapshot = null,
        scoreboardChallengeId = null,
        scoreboardTrackKey = null,
        scoreboardSubhead = null,
        showGlobalLeaderboard = true,
        allowLeaderboardOpen = true
    } = {}) {
        if (!this.modal || !this.modalTitle || !this.modalLapTimes || !this.modalRunsView || !this.modalMainView) return;

        this.cancelPendingModalClose();
        const wasActive = this.isModalActive();

        // Save previous view state before clearing
        const wasCombinedActive = this.modalCombinedView?.classList.contains('active-view');
        const wasMainActive = this.modalMainView?.classList.contains('active-view');
        if (wasCombinedActive) {
            this._runsReturnView = 'combined';
            this._savedModalKind = this._modalKind;
            this._savedMainModalIsCrash = this._mainModalIsCrash;
        } else if (wasMainActive) {
            this._runsReturnView = 'main';
            this._savedModalKind = null;
            this._savedMainModalIsCrash = false;
        } else if (!this._runsReturnView) {
            this._runsReturnView = 'main';
            this._savedModalKind = null;
            this._savedMainModalIsCrash = false;
        }

        this.modal.classList.remove('modal--crash', 'modal--win', 'modal--pause');
        this._modalKind = null;
        this._mainModalIsCrash = false;
        this._hidePauseTrackPreview();
        this.modalLapTimes.replaceChildren();
        this.content.renderLapTimesList(this.modalLapTimes, lapTimesArray, bestTime, currentTime);
        this._modalRunsPayload = buildModalRunsPayload({
            lapTimesArray,
            bestTime,
            currentTime,
            scoreboardChallengeId,
            scoreboardTrackKey,
            scoreboardSnapshot,
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardSubhead,
            showGlobalLeaderboard,
            allowLeaderboardOpen
        }, {
            currentTrackKey: this.getCurrentTrackKey()
        });
        if (this._modalRunsPayload.showGlobalLeaderboard) {
            this.content.renderScoreboardList(
                this.modalLapTimes,
                this._modalRunsPayload.scoreboardSnapshot,
                TRACK_MODE_DAILY_GP,
                this._modalRunsPayload.scoreboardTrackKey,
                this._modalRunsPayload.scoreboardSubhead
            );
        }
        this._runsViewMode = returnMode === 'back' ? 'back' : 'close';
        if (this.backToMainBtn) {
            const labelText = this._runsViewMode === 'back' ? 'Back' : 'Close';
            const labelSpan = this.backToMainBtn.querySelector('.combined-action-btn-label');
            if (labelSpan) labelSpan.textContent = labelText;
            else this.backToMainBtn.textContent = labelText;
            this.backToMainBtn.setAttribute('aria-label', labelText);
        }
        this.modalMainView.classList.remove('active-view');
        if (this.modalCombinedView) this.modalCombinedView.classList.remove('active-view');
        if (this.modalPauseView) this.modalPauseView.classList.remove('active-view');
        this.modalRunsView.classList.add('active-view');
        this.modal.classList.add('active');
        if (wasActive) {
            scheduleAfterModalPaint(() => {
                this.content.centerLeaderboardCurrentRow();
                if (this.backToMainBtn) this.backToMainBtn.focus();
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

        const modal = this.modal;
        modal.classList.remove('active');
        this.cancelLeaderboardRequests?.();

        this.cancelPendingModalClose();

        const cleanupAfterClose = () => {
            this._modalCloseTransitionEndHandler = null;
            modal.classList.remove('modal--crash');
            modal.classList.remove('modal--pause');
            modal.classList.remove('modal--win');
            this._hidePauseTrackPreview();
            if (this.modalCombinedView) this.modalCombinedView.classList.remove('active-view');
            if (this.modalPauseView) this.modalPauseView.classList.remove('active-view');
            if (this.modalMainView) this.modalMainView.classList.remove('active-view');
            if (this.modalRunsView) this.modalRunsView.classList.remove('active-view');
            this._modalKind = null;
            this._modalPrimaryAction = this.getDefaultPrimaryAction();
            this._modalSecondaryAction = null;
            this._modalRunsPayload = null;
            this._runsReturnView = null;
            this._savedModalKind = null;
            this._savedMainModalIsCrash = false;
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

    showMainModalView() {
        this._runsViewMode = 'back';
        if (this.backToMainBtn) {
            const labelSpan = this.backToMainBtn.querySelector('.combined-action-btn-label');
            if (labelSpan) labelSpan.textContent = 'Back';
            else this.backToMainBtn.textContent = 'Back';
            this.backToMainBtn.setAttribute('aria-label', 'Back');
        }

        const isCombinedViewReturn = this._runsReturnView === 'combined'
            || this._savedModalKind === 'win'
            || this._savedModalKind === 'crash'
            || this._modalKind === 'win'
            || this._modalKind === 'crash';

        if (isCombinedViewReturn) {
            this._modalKind = this._savedModalKind || this._modalKind || 'win';
            this._mainModalIsCrash = this._savedMainModalIsCrash || this._modalKind === 'crash';
            if (this.modal) {
                this.modal.classList.toggle('modal--crash', this._mainModalIsCrash);
                this.modal.classList.toggle('modal--win', this._modalKind === 'win');
                this.modal.classList.toggle('modal--pause', this._modalKind === 'pause' || this._modalKind === 'crash');
            }
            if (this.modalRunsView) this.modalRunsView.classList.remove('active-view');
            if (this.modalPauseView) this.modalPauseView.classList.remove('active-view');
            if (this.modalMainView) this.modalMainView.classList.remove('active-view');
            if (this.modalCombinedView) this.modalCombinedView.classList.add('active-view');
        } else {
            if (this.modal) this.modal.classList.toggle('modal--crash', this._mainModalIsCrash);
            if (this.modalRunsView) this.modalRunsView.classList.remove('active-view');
            if (this.modalCombinedView) this.modalCombinedView.classList.remove('active-view');
            if (this.modalPauseView) this.modalPauseView.classList.remove('active-view');
            if (this.modalMainView) this.modalMainView.classList.add('active-view');
        }
    }

    isStandaloneRunsViewActive() {
        return this.isModalActive() && this._runsViewMode === 'close' && Boolean(this.modalRunsView?.classList.contains('active-view'));
    }

    isPauseModalActive() {
        return this.isModalActive() && this._modalKind === 'pause';
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
            (this._modalKind === 'crash' || this._modalKind === 'win')
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

        this._focusBeforeModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this._activeTrapModal = modalEl;
        const focusables = this.getFocusables(modalEl);
        const preferredFocus = modalEl === this.modal
            ? this.getModalPreferredFocusTarget()
            : null;
        if (preferredFocus) preferredFocus.focus();
        else if (focusables.length) focusables[0].focus();
        this._modalTrapKeydown = (event) => this.handleModalTrapKeydown(event);
        document.addEventListener('keydown', this._modalTrapKeydown, true);
    }

    releaseModalFocusTrap(modalEl) {
        if (this._activeTrapModal !== modalEl) return;
        document.removeEventListener('keydown', this._modalTrapKeydown, true);
        this._activeTrapModal = null;
        this._modalTrapKeydown = null;
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
            if (trapRoot.id === 'achievements-modal') {
                event.preventDefault();
                document.getElementById('achievements-back-btn')?.click();
                return;
            }
            if (trapRoot.id === 'garage-modal') {
                event.preventDefault();
                document.getElementById('skill-points-close-btn')?.click();
                return;
            }
            if (
                trapRoot?.id === 'modal'
                && this.modalRunsView?.classList.contains('active-view')
            ) {
                event.preventDefault();
                if (this._runsViewMode === 'close') {
                    this.closeModal();
                } else {
                    this.showMainModalView();
                    requestAnimationFrame(() => this.activateModalFocusTrap(this.modal));
                }
                return;
            }
        }

        const isDesktopModalNav = window.matchMedia('(min-width: 769px)').matches;
        const actionButtons = isDesktopModalNav
            ? Array.from(this._activeTrapModal.querySelectorAll('.modal-action-row > button'))
                .filter((button) => !button.hidden && button.offsetParent !== null)
            : [];

        if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && actionButtons.length > 1) {
            const activeIndex = actionButtons.indexOf(document.activeElement);
            if (activeIndex !== -1) {
                event.preventDefault();
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                const nextIndex = (activeIndex + direction + actionButtons.length) % actionButtons.length;
                actionButtons[nextIndex].focus();
            }
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

        value.replaceChildren();
        value.toggleAttribute('aria-busy', rankDisplay.isLoading);
        value.textContent = rankDisplay.text;
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

        if (this.modalCombinedView?.classList.contains('active-view')) {
            const rightGroupEl = this.modalCombinedView.querySelector('#combined-stats-right-group');
            const rankValueEl = this.modalCombinedView.querySelector('#combined-rank-value');
            const rankTotalEl = this.modalCombinedView.querySelector('#combined-rank-total');
            const isCrash = this._modalKind === 'crash';

            if (isCrash || !rankValueEl) {
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
            if (rankDisplay.isLoading) {
                if (rightGroupEl) {
                    rightGroupEl.hidden = false;
                    rightGroupEl.removeAttribute('hidden');
                    rightGroupEl.removeAttribute('aria-hidden');
                }
                rankValueEl.textContent = '--';
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
            void this.getLeaderboards()?.openDailyChallengeLeaderboard('back');
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

    matchesModalScoreboardContext({ challengeId = null, trackKey = null } = {}) {
        if (!this.isModalActive() || !this._modalRunsPayload) return false;

        if (challengeId) {
            return this._modalRunsPayload.scoreboardChallengeId === challengeId;
        }

        if (!trackKey) return false;
        if (this._modalRunsPayload.scoreboardChallengeId) return false;

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
