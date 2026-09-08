import {
    formatDailyChallengeBestLabel,
    getDailyChallengeCardStatus,
    getDailyChallengeRequiredLaps,
} from './labels.js';
import {
    getCachedDailyChallengeSnapshot,
    getDailyChallengeBestResult,
    getDailyChallengeTrackName
} from './service.js';
import {
    getDailyChallengeVerificationEntry,
    getVerificationSnapshotFromQueueEntry
} from '../scoreboard/verification-queue.js';
import { renderCachedTrackPreviewCanvas } from '../track/preview-renderer.js';
import { hasTrack } from '../track/catalog.js';
import { getLoadedClientTrack, loadClientTrack } from '../track/client-registry.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from '../track/presentation.js';
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';
import { formatCampaignStageLabel } from '../campaign/carousel-model.js';
import { formatLapsLabel } from '../shared/laps-label.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';
import { getMedalForRaceTime } from '../medals/medal-timing.js';

function scheduleAfterModalPaint(callback) {
    requestAnimationFrame(() => {
        requestAnimationFrame(callback);
    });
}

function renderPlaylistMessage(list, text) {
    const empty = document.createElement('div');
    empty.className = 'daily-playlist-empty';
    empty.textContent = text;
    list.appendChild(empty);
}

function formatTrackPreviewRankLabel(playerRank, playerRankLabel) {
    if (Number.isInteger(playerRank) && playerRank > 0) {
        return `#${playerRank}`;
    }
    if (typeof playerRankLabel !== 'string') return null;
    const label = playerRankLabel.trim();
    return /^#\d+$/.test(label) ? label : null;
}

function buildTracksTile({
    isCurrent = false,
    locked = false,
    ariaLabel,
    statusText = '',
    titleText,
    medalTier = null,
    rankLabel = null,
    onClick,
}) {
    const row = document.createElement('button');
    row.className = [
        'daily-playlist-entry--hero',
        isCurrent ? 'current' : '',
        locked ? 'is-locked' : '',
    ].filter(Boolean).join(' ');
    row.type = 'button';
    row.setAttribute('aria-label', ariaLabel);
    row.addEventListener('click', onClick);

    const preview = document.createElement('div');
    preview.className = 'daily-playlist-hero-preview';
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 160;
    preview.appendChild(canvas);

    if (medalTier) {
        const medal = document.createElement('div');
        medal.className = 'daily-playlist-hero-medal';
        medal.setAttribute('aria-hidden', 'true');
        medal.appendChild(createMedalIconSvg(medalTier, {
            className: 'medal-svg--hero',
        }));
        preview.appendChild(medal);
    }

    if (rankLabel) {
        const rank = document.createElement('span');
        rank.className = 'daily-playlist-hero-rank';
        rank.setAttribute('aria-hidden', 'true');
        rank.textContent = rankLabel;
        preview.appendChild(rank);
    }

    const title = document.createElement('span');
    title.className = 'daily-playlist-hero-title';
    title.textContent = titleText;

    const status = document.createElement('span');
    status.className = 'daily-playlist-hero-day';
    status.textContent = statusText || '';

    row.append(preview, title, status);
    return { row, canvas };
}

export class DailyChallengeUi {
    constructor({
        previewQualityLevel = 0,
        previewFrameSkip = 0,
        onSummaryUpdated = null,
        onTracksTabChange = null,
        getModalShell = () => null,
    } = {}) {
        this.previewQualityLevel = previewQualityLevel;
        this.previewFrameSkip = previewFrameSkip;
        this.onSummaryUpdated = onSummaryUpdated;
        this.onTracksTabChange = onTracksTabChange;
        this.getModalShell = getModalShell;
        this._dailyChallengeSummary = null;
        this._tracksModalKind = null;
        this._dailyTracksActions = null;
        this._campaignTracksActions = null;
        this._campaignTracksSelectedId = null;
    }

    get dailyChallengeStartBtn() { return document.getElementById('daily-challenge-start-btn'); }
    get dailyChallengePlaylistModal() { return document.getElementById('daily-playlist-modal'); }
    get dailyChallengePlaylistList() { return document.getElementById('daily-playlist-list'); }
    get campaignChallengePlaylistList() { return document.getElementById('campaign-playlist-list'); }
    get tracksTabDaily() { return document.getElementById('tracks-tab-daily'); }
    get tracksTabCampaign() { return document.getElementById('tracks-tab-campaign'); }
    get tracksPanelDaily() { return this.dailyChallengePlaylistList; }
    get tracksPanelCampaign() { return this.campaignChallengePlaylistList; }
    get dailyChallengePlaylistCloseBtn() { return document.getElementById('daily-playlist-close-btn'); }
    get dailyChallengeHudInline() { return document.getElementById('daily-challenge-hud-inline'); }

    focus() {
        const start = this.dailyChallengeStartBtn;
        if (start && !start.disabled) start.focus();
    }
    setDailyChallengeSummary(summary) {
        if (!summary || typeof summary !== 'object') {
            this._dailyChallengeSummary = null;
        } else {
            this._dailyChallengeSummary = {
                ...summary,
                verifiedBestTime: Object.prototype.hasOwnProperty.call(summary, 'verifiedBestTime')
                    ? summary.verifiedBestTime
                    : (Number.isFinite(summary.bestTime) ? summary.bestTime : null),
                verifiedBestLabel: Object.prototype.hasOwnProperty.call(summary, 'verifiedBestLabel')
                    ? summary.verifiedBestLabel
                    : (typeof summary.bestLabel === 'string' ? summary.bestLabel : '--'),
                verifiedRankLabel: Object.prototype.hasOwnProperty.call(summary, 'verifiedRankLabel')
                    ? summary.verifiedRankLabel
                    : (typeof summary.rankLabel === 'string' ? summary.rankLabel : '--'),
                verifiedScoreboardSnapshot: Object.prototype.hasOwnProperty.call(summary, 'verifiedScoreboardSnapshot')
                    ? (summary.verifiedScoreboardSnapshot && typeof summary.verifiedScoreboardSnapshot === 'object'
                        ? summary.verifiedScoreboardSnapshot
                        : null)
                    : (summary.scoreboardSnapshot && typeof summary.scoreboardSnapshot === 'object'
                        ? summary.scoreboardSnapshot
                        : null)
            };
        }

        const hasChallenge = Boolean(this._dailyChallengeSummary?.available);
        if (this.dailyChallengeStartBtn) {
            this.dailyChallengeStartBtn.disabled = !hasChallenge || Boolean(this._dailyChallengeSummary?.loading);
        }

        this.onSummaryUpdated?.(this._dailyChallengeSummary);
    }

    openPlaylistModal(challenges = [], actions = null) {
        const modal = this.dailyChallengePlaylistModal;
        if (!modal) return;
        const keepCurrentTab = this.isPlaylistModalOpen() && this._tracksModalKind !== 'daily';
        if (actions) this._dailyTracksActions = actions;
        if (keepCurrentTab) {
            this.renderPlaylist(challenges, actions);
            return;
        }
        this._tracksModalKind = 'daily';
        configureReusableModal(modal, {
            title: 'Tracks',
            subtitle: '',
            closeLabel: 'Back',
        });
        this.setTracksTab('daily', { focusTab: false, notify: false });
        this.renderPlaylist(challenges, actions);
        this.openTracksModal();
    }

    openCampaignTracksModal(stages = [], actions = null, { selectedStageId = null } = {}) {
        const modal = this.dailyChallengePlaylistModal;
        if (!modal) return;
        const keepCurrentTab = this.isPlaylistModalOpen() && this._tracksModalKind !== 'campaign';
        if (actions) this._campaignTracksActions = actions;
        if (keepCurrentTab) {
            this._campaignTracksSelectedId = selectedStageId;
            this.renderCampaignPlaylist(stages, actions, { selectedStageId });
            return;
        }
        this._tracksModalKind = 'campaign';
        this._campaignTracksSelectedId = selectedStageId;
        configureReusableModal(modal, {
            title: 'Tracks',
            subtitle: '',
            closeLabel: 'Back',
        });
        this.setTracksTab('campaign', { focusTab: false, notify: false });
        this.renderCampaignPlaylist(stages, actions, { selectedStageId });
        this.openTracksModal();
    }

    setTracksTab(tab, { focusTab = true, notify = true } = {}) {
        const nextTab = tab === 'campaign' ? 'campaign' : 'daily';
        const tabChanged = this._tracksModalKind !== nextTab;
        this._tracksModalKind = nextTab;

        const tabButtons = [
            ['daily', this.tracksTabDaily],
            ['campaign', this.tracksTabCampaign],
        ];
        for (const [id, element] of tabButtons) {
            const selected = id === nextTab;
            element?.setAttribute('aria-selected', selected ? 'true' : 'false');
            element?.classList.toggle('is-selected', selected);
        }

        if (this.tracksPanelDaily) this.tracksPanelDaily.hidden = nextTab !== 'daily';
        if (this.tracksPanelCampaign) this.tracksPanelCampaign.hidden = nextTab !== 'campaign';

        if (focusTab) {
            const focusEl = tabButtons.find(([id]) => id === nextTab)?.[1];
            focusEl?.focus?.();
        }
        if (notify) {
            this.getModalShell?.()?.onTracksTabChangedForKeyboardNav?.();
            if (tabChanged) this.onTracksTabChange?.(nextTab);
        }
    }

    openTracksModal() {
        const modal = this.dailyChallengePlaylistModal;
        if (!modal) return;
        openModalElement(modal, () => modal.classList.add('active'));
        document.body.classList.add('modal-open');
        scheduleAfterModalPaint(() => {
            const modalShell = this.getModalShell?.();
            modalShell?.activateModalFocusTrap?.(modal);
            modalShell?.resetTracksMenuKeyboardNav?.();
        });
    }

    closePlaylistModal() {
        const modal = this.dailyChallengePlaylistModal;
        if (!modal) return;
        const modalShell = this.getModalShell?.();
        modalShell?.releaseModalFocusTrap?.(modal);
        closeModalElement(modal, () => {
            modal.classList.remove('active');
            document.body.classList.remove('modal-open');
        });
        this._tracksModalKind = null;
        if (modalShell?.isModalActive?.()) {
            requestAnimationFrame(() => modalShell.activateModalFocusTrap?.(modalShell.modal));
        }
    }

    isPlaylistModalOpen() {
        return Boolean(this.dailyChallengePlaylistModal?.classList.contains('active'));
    }

    isCampaignTracksModalOpen() {
        return this._tracksModalKind === 'campaign' && this.isPlaylistModalOpen();
    }

    bindPlaylistModal() {
        configureReusableModal(this.dailyChallengePlaylistModal, {
            title: 'Tracks',
            closeLabel: 'Back',
        });
        bindReusableModal(this.dailyChallengePlaylistModal, () => this.closePlaylistModal());
        this.setTracksTab('daily', { focusTab: false, notify: false });
        this.tracksTabDaily?.addEventListener('click', () => this.setTracksTab('daily'));
        this.tracksTabCampaign?.addEventListener('click', () => this.setTracksTab('campaign'));
    }

    renderPlaylist(challenges = [], actions = null) {
        const list = this.dailyChallengePlaylistList;
        if (!list) return;
        if (actions) this._dailyTracksActions = actions;
        list.replaceChildren();
        const playlistActions = actions || this._dailyTracksActions;
        const onPlay = typeof playlistActions === 'function'
            ? playlistActions
            : playlistActions?.onPlay;

        if (challenges === null) {
            renderPlaylistMessage(list, 'Loading tracks...');
            return;
        }

        const playableChallenges = Array.isArray(challenges)
            ? challenges.filter((challenge) => challenge?.trackKey && hasTrack(challenge.trackKey))
            : [];
        if (!playableChallenges.length) {
            renderPlaylistMessage(list, 'No tracks available');
            return;
        }

        for (const challenge of playableChallenges) {
            const availability = getDailyChallengeCardStatus(challenge);
            const availabilityLabel = availability.key === 'featured' ? 'Today' : availability.label;
            const isCurrentTrack = challenge.id === this._dailyChallengeSummary?.challengeId;
            const trackName = getDailyChallengeTrackName(challenge);
            const bestResult = challenge.trackPersonalBest
                || getDailyChallengeBestResult(challenge);
            const requiredLaps = getDailyChallengeRequiredLaps(challenge);
            const lapsLabel = formatLapsLabel(requiredLaps);
            const bestMedal = getMedalForRaceTime(
                challenge.trackKey,
                Number(bestResult?.bestTime),
                requiredLaps,
            );
            const snapshot = getCachedDailyChallengeSnapshot(challenge.id);
            const rankLabel = formatTrackPreviewRankLabel(
                snapshot?.playerRank,
                snapshot?.playerRankLabel,
            );
            const { row, canvas } = buildTracksTile({
                isCurrent: isCurrentTrack,
                ariaLabel: rankLabel
                    ? `Race ${trackName}. ${lapsLabel}. ${availabilityLabel}. Rank ${rankLabel}`
                    : `Race ${trackName}. ${lapsLabel}. ${availabilityLabel}`,
                statusText: availability.key === 'featured' ? `Today · ${lapsLabel}` : lapsLabel,
                titleText: trackName,
                medalTier: bestMedal,
                rankLabel,
                onClick: () => {
                    this.closePlaylistModal();
                    onPlay?.(challenge);
                },
            });
            this.renderPlaylistPreview(canvas, challenge);
            list.appendChild(row);
        }
    }

    renderCampaignPlaylist(stages = [], actions = null, { selectedStageId = this._campaignTracksSelectedId } = {}) {
        const list = this.campaignChallengePlaylistList;
        if (!list) return;
        if (actions) this._campaignTracksActions = actions;
        if (selectedStageId !== undefined) this._campaignTracksSelectedId = selectedStageId;
        const onChoose = typeof this._campaignTracksActions === 'function'
            ? this._campaignTracksActions
            : this._campaignTracksActions?.onChoose;
        list.replaceChildren();

        if (stages === null) {
            renderPlaylistMessage(list, 'Loading tracks...');
            return;
        }

        const playableStages = Array.isArray(stages)
            ? stages.filter((stage) => stage?.trackKey && hasTrack(stage.trackKey))
            : [];
        if (!playableStages.length) {
            renderPlaylistMessage(list, 'No tracks available');
            return;
        }

        for (const stage of playableStages) {
            const locked = !stage.unlocked;
            const isCurrentTrack = stage.id === this._campaignTracksSelectedId;
            const stageLabel = formatCampaignStageLabel(stage);
            const lapsLabel = formatLapsLabel(stage.laps);
            const trackName = typeof stage.trackName === 'string' && stage.trackName.trim()
                ? stage.trackName.trim()
                : stage.trackKey;
            const bestMedal = stage.medal || getMedalForRaceTime(
                stage.trackKey,
                Number(stage.bestTimeMs) > 0 ? stage.bestTimeMs / 1000 : null,
                stage.laps,
            );
            const rankLabel = formatTrackPreviewRankLabel(
                stage.playerRank,
                stage.playerRankLabel,
            );

            const { row, canvas } = buildTracksTile({
                isCurrent: isCurrentTrack,
                locked,
                ariaLabel: locked
                    ? `Locked. ${trackName}. ${stageLabel}`
                    : rankLabel
                        ? `Race ${trackName}. ${lapsLabel}. ${stageLabel}. Rank ${rankLabel}`
                        : `Race ${trackName}. ${lapsLabel}. ${stageLabel}`,
                statusText: lapsLabel,
                titleText: trackName,
                medalTier: bestMedal,
                rankLabel,
                onClick: () => {
                    this.closePlaylistModal();
                    onChoose?.(stage);
                },
            });
            this.renderPlaylistPreview(canvas, stage);
            list.appendChild(row);
        }
    }

    renderPlaylistPreview(canvas, challenge) {
        const track = getLoadedClientTrack(challenge?.trackKey);
        if (!track) {
            void loadClientTrack(challenge?.trackKey).then((loaded) => {
                if (!loaded || canvas?.isConnected === false) return;
                this.renderPlaylistPreview(canvas, challenge);
            }).catch(() => {});
            return;
        }
        const presentation = resolveTrackPresentation(challenge.trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event: challenge.skin ? { key: 'daily-challenge', trackKey: challenge.trackKey, skin: challenge.skin } : null
        });
        renderCachedTrackPreviewCanvas(canvas, {
            cacheKey: `daily-row:${challenge.trackKey}:${challenge.skin || 'default'}`,
            trackGeometry: {
                outer: track.outer,
                inner: track.inner
            },
            presentation,
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle,
            transparentBackground: true,
            previewRenderMode: 'schematic'
        });
    }

    getSummary() {
        return this._dailyChallengeSummary;
    }

    refreshDailyChallengeVerificationState(challengeId = this._dailyChallengeSummary?.challengeId) {
        if (!challengeId || this._dailyChallengeSummary?.challengeId !== challengeId) return;

        const summary = this._dailyChallengeSummary;
        const verificationEntry = getDailyChallengeVerificationEntry(challengeId);
        const verificationSnapshot = getVerificationSnapshotFromQueueEntry(verificationEntry);
        const verifiedBestTime = Number.isFinite(summary?.verifiedBestTime) ? summary.verifiedBestTime : null;
        const verifiedBestLabel = typeof summary?.verifiedBestLabel === 'string' ? summary.verifiedBestLabel : '--';
        const verifiedRankLabel = typeof summary?.verifiedRankLabel === 'string' ? summary.verifiedRankLabel : '--';
        const verifiedScoreboardSnapshot = summary?.verifiedScoreboardSnapshot && typeof summary.verifiedScoreboardSnapshot === 'object'
            ? summary.verifiedScoreboardSnapshot
            : null;

        const nextSummary = {
            ...summary,
            bestTime: verifiedBestTime,
            bestLabel: verifiedBestLabel,
            rankLabel: verifiedRankLabel,
            scoreboardSnapshot: verifiedScoreboardSnapshot
        };

        if (verificationEntry && verificationSnapshot) {
            if (!summary.usesTrackPersonalBest) {
                nextSummary.bestTime = Number.isFinite(verificationEntry.bestTime)
                    ? verificationEntry.bestTime
                    : verifiedBestTime;
                nextSummary.bestLabel = formatDailyChallengeBestLabel(
                    summary.objectiveType,
                    verificationEntry.bestTime,
                    verificationEntry.completedLaps
                );
            }
            nextSummary.scoreboardSnapshot = {
                ...(verifiedScoreboardSnapshot || {}),
                ...verificationSnapshot,
                playerRankLabel: null,
                playerRank: null,
                currentPlayerRow: null
            };
        }

        this.setDailyChallengeSummary(nextSummary);
    }

    setDailyChallengeHud(state = null) {
        const isVisible = Boolean(state?.visible);
        const progressText = isVisible ? (state?.progressText || '') : '';

        if (this.dailyChallengeHudInline) {
            this.dailyChallengeHudInline.hidden = !isVisible;
            const progressSpan = this.dailyChallengeHudInline.querySelector('.daily-challenge-hud__progress');
            if (progressSpan) progressSpan.textContent = progressText;
        }
    }
}
