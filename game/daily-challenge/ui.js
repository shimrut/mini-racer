import {
    formatDailyChallengeBestLabel,
    formatDailyChallengePlaylistAvailabilityLabel,
    getCachedDailyChallengeSnapshot,
    getDailyChallengeBestDisplay,
    getDailyChallengeCopyLabels,
    getDailyChallengeTrackName
} from './service.js?v=1.94';
import { buildScoreboardRankDisplay } from '../race/result-flow.js?v=1.91';
import {
    getDailyChallengeVerificationEntry,
    getDailyChallengeVerificationState
} from '../scoreboard/verification-queue.js';
import { renderTrackPreviewCanvas } from '../track/preview-renderer.js';
import { TRACKS } from '../track/tracks.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from '../track/presentation.js';
import {
    setCarAssetImageWithFallbacks,
    STOCK_CAR_ASSET_NAME
} from '../car/sprite.js';
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';

export class DailyChallengeUi {
    constructor({
        previewQualityLevel = 0,
        previewFrameSkip = 0,
        onSummaryUpdated = null,
    } = {}) {
        this.previewQualityLevel = previewQualityLevel;
        this.previewFrameSkip = previewFrameSkip;
        this.onSummaryUpdated = onSummaryUpdated;
        this._dailyChallengeSummary = null;
        this._dailyChallengeCountdownInterval = null;
    }

    get dailyChallengeTitle() { return document.getElementById('daily-challenge-title'); }
    get dailyChallengeTrack() { return document.getElementById('daily-challenge-track'); }
    get dailyChallengeObjective() { return document.getElementById('daily-challenge-objective'); }
    get dailyChallengeModifiers() { return document.getElementById('daily-challenge-modifiers'); }
    get dailyChallengeBestLabel() { return document.getElementById('daily-challenge-best-label'); }
    get dailyChallengeBest() { return document.getElementById('daily-challenge-best'); }
    get dailyChallengeRankBtn() { return document.getElementById('daily-challenge-rank-btn'); }
    get dailyChallengeReset() { return document.getElementById('daily-challenge-reset'); }
    get dailyChallengeStartBtn() { return document.getElementById('daily-challenge-start-btn'); }
    get dailyChallengePlaylistModal() { return document.getElementById('daily-playlist-modal'); }
    get dailyChallengePlaylistList() { return document.getElementById('daily-playlist-list'); }
    get dailyChallengePlaylistCloseBtn() { return document.getElementById('daily-playlist-close-btn'); }
    get dailyChallengeCarName() { return document.getElementById('daily-challenge-car-name'); }
    get dailyChallengeCarLabel() { return document.getElementById('daily-challenge-car-label'); }
    get dailyChallengeCarImage() { return document.getElementById('daily-challenge-car-image'); }
    get dailyChallengeHudInline() { return document.getElementById('daily-challenge-hud-inline'); }
    get hudLapCluster() { return document.querySelector('.hud-lap-cluster'); }

    focus() {
        const start = this.dailyChallengeStartBtn;
        if (start && !start.disabled) {
            start.focus();
            return;
        }
        const rank = this.dailyChallengeRankBtn;
        if (rank && !rank.disabled) {
            rank.focus();
        }
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
        const copyLabels = getDailyChallengeCopyLabels({
            objectiveType: this._dailyChallengeSummary?.objectiveType
        });
        if (this.dailyChallengeTitle) {
            this.dailyChallengeTitle.textContent = hasChallenge
                ? (this._dailyChallengeSummary?.trackName || this._dailyChallengeSummary?.title || 'Daily challenge')
                : 'RACE';
        }
        if (this.dailyChallengeTrack) {
            this.dailyChallengeTrack.textContent = hasChallenge
                ? "Beat today's challenge and climb the leaderboard."
                : 'Check back at the next UTC reset.';
            this.dailyChallengeTrack.style.display = 'block';
        }
        if (this.dailyChallengeObjective) {
            this.dailyChallengeObjective.textContent = hasChallenge
                ? (this._dailyChallengeSummary?.objectiveLabel || '1 lap')
                : 'Challenge unavailable';
            this.dailyChallengeObjective.style.display = 'block';
        }
        if (this.dailyChallengeModifiers) {
            this.dailyChallengeModifiers.replaceChildren();
            const badgeTexts = hasChallenge
                ? (Array.isArray(this._dailyChallengeSummary.modifierBadges)
                    && this._dailyChallengeSummary.modifierBadges.length
                        ? this._dailyChallengeSummary.modifierBadges
                        : ['Verified runs', 'UTC reset'])
                : [];
            for (const text of badgeTexts) {
                const span = document.createElement('span');
                span.className = 'daily-challenge-chip';
                span.textContent = text;
                this.dailyChallengeModifiers.appendChild(span);
            }
            this.dailyChallengeModifiers.style.display = hasChallenge && badgeTexts.length ? 'flex' : 'none';
        }
        if (this.dailyChallengeBest) {
            const bestTime = this._dailyChallengeSummary?.bestTime;
            this.dailyChallengeBest.textContent = this._dailyChallengeSummary?.bestLabel
                || (Number.isFinite(bestTime) ? `${bestTime.toFixed(2)}s` : '--');
        }
        if (this.dailyChallengeBestLabel) {
            this.dailyChallengeBestLabel.textContent = copyLabels.bestSummaryLabel;
        }
        if (this.dailyChallengeCarName) {
            this.dailyChallengeCarName.textContent = hasChallenge
                ? (this._dailyChallengeSummary?.objectiveLabel || 'Daily challenge')
                : '--';
        }
        if (this.dailyChallengeCarLabel) {
            const carLabel = hasChallenge
                ? 'Challenge'
                : '--';
            this.dailyChallengeCarLabel.textContent = carLabel !== '--' ? `${carLabel.toUpperCase()} CAR` : 'CAR';
        }
        if (this.dailyChallengeCarImage) {
            setCarAssetImageWithFallbacks(this.dailyChallengeCarImage, STOCK_CAR_ASSET_NAME);
        }
        if (this.dailyChallengeRankBtn) {
            const trackName = this._dailyChallengeSummary?.trackName || "today's daily challenge";
            this.dailyChallengeRankBtn.disabled = !hasChallenge;
            delete this.dailyChallengeRankBtn.dataset.rank;
            this.dailyChallengeRankBtn.setAttribute(
                'aria-label',
                hasChallenge
                    ? `Open leaderboard for ${trackName}.`
                    : 'Daily challenge leaderboard unavailable.'
            );
        }
        if (this.dailyChallengeStartBtn) {
            this.dailyChallengeStartBtn.disabled = !hasChallenge || Boolean(this._dailyChallengeSummary?.loading);
        }

        this.updateDailyChallengeCountdown();
        this.onSummaryUpdated?.(this._dailyChallengeSummary);
        this.renderTrackPreview();

        if (this._dailyChallengeCountdownInterval !== null) {
            clearInterval(this._dailyChallengeCountdownInterval);
            this._dailyChallengeCountdownInterval = null;
        }
        if (hasChallenge && this._dailyChallengeSummary?.endsAt) {
            this._dailyChallengeCountdownInterval = window.setInterval(
                () => this.updateDailyChallengeCountdown(),
                1000
            );
        }
    }

    renderTrackPreview() {
        const canvas = document.getElementById('daily-challenge-track-preview');
        if (!canvas) return;

        const summary = this._dailyChallengeSummary;
        if (!summary?.available || !summary?.trackKey) {
            const ctx = canvas.getContext('2d');
            ctx?.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        const track = TRACKS[summary.trackKey];
        if (!track) return;

        const presentation = resolveTrackPresentation(summary.trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event: summary.skin ? { key: 'daily-challenge', trackKey: summary.trackKey, skin: summary.skin } : null
        });

        renderTrackPreviewCanvas(canvas, {
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

    openPlaylistModal(challenges = [], actions = null) {
        const modal = this.dailyChallengePlaylistModal;
        if (!modal) return;
        this.renderPlaylist(challenges, actions);
        openModalElement(modal, () => {
            modal.style.display = 'flex';
            modal.classList.add('active');
        });
        document.body.classList.add('modal-open');
        requestAnimationFrame(() => {
            const firstPlay = modal.querySelector('.daily-playlist-icon-btn--primary');
            if (firstPlay instanceof HTMLButtonElement) {
                firstPlay.focus();
            } else {
                this.dailyChallengePlaylistCloseBtn?.focus?.();
            }
        });
    }

    closePlaylistModal() {
        const modal = this.dailyChallengePlaylistModal;
        if (!modal) return;
        closeModalElement(modal, () => {
            modal.classList.remove('active');
            modal.style.display = '';
            document.body.classList.remove('modal-open');
        });
    }

    isPlaylistModalOpen() {
        return Boolean(this.dailyChallengePlaylistModal?.classList.contains('active'));
    }

    bindPlaylistModal() {
        configureReusableModal(this.dailyChallengePlaylistModal, {
            title: 'Tracks',
            subtitle: 'Playable daily tracks',
            closeLabel: 'Close',
        });
        bindReusableModal(this.dailyChallengePlaylistModal, () => this.closePlaylistModal());
    }

    renderPlaylist(challenges = [], actions = null) {
        const list = this.dailyChallengePlaylistList;
        if (!list) return;
        list.replaceChildren();
        const onPlay = typeof actions === 'function'
            ? actions
            : actions?.onPlay;
        const onLeaderboard = actions?.onLeaderboard;

        if (challenges === null) {
            const loading = document.createElement('div');
            loading.className = 'daily-playlist-empty';
            loading.textContent = 'Loading tracks...';
            list.appendChild(loading);
            return;
        }

        const playableChallenges = Array.isArray(challenges)
            ? challenges.filter((challenge) => challenge?.trackKey && TRACKS[challenge.trackKey])
            : [];
        if (!playableChallenges.length) {
            const empty = document.createElement('div');
            empty.className = 'daily-playlist-empty';
            empty.textContent = 'No tracks available';
            list.appendChild(empty);
            return;
        }

        for (const challenge of playableChallenges) {
            const row = document.createElement('div');
            row.className = 'daily-playlist-row';

            const canvas = document.createElement('canvas');
            canvas.className = 'daily-playlist-preview';
            canvas.width = 176;
            canvas.height = 108;
            canvas.setAttribute('aria-hidden', 'true');

            const copy = document.createElement('div');
            copy.className = 'daily-playlist-copy';
            const titleRow = document.createElement('div');
            titleRow.className = 'daily-playlist-title-row';
            const title = document.createElement('div');
            title.className = 'daily-playlist-title';
            title.textContent = getDailyChallengeTrackName(challenge);
            titleRow.append(title);

            const stats = document.createElement('div');
            stats.className = 'daily-playlist-metrics';
            const pendingEntry = getDailyChallengeVerificationEntry(challenge.id);
            const isPending = getDailyChallengeVerificationState(challenge.id) === 'pending'
                && pendingEntry;
            const bestLabel = isPending
                ? formatDailyChallengeBestLabel(
                    challenge.objectiveType,
                    pendingEntry.bestTime,
                    pendingEntry.completedLaps
                )
                : getDailyChallengeBestDisplay(challenge);
            const best = document.createElement('span');
            best.className = 'daily-playlist-metric daily-playlist-metric--best';
            best.textContent = bestLabel && bestLabel !== '--' ? bestLabel : '--';
            if (isPending) {
                best.setAttribute('aria-label', 'Pending best time verification');
            }
            stats.append(best);

            const rankBtn = document.createElement('button');
            rankBtn.className = 'daily-playlist-metric daily-playlist-rank-btn';
            rankBtn.type = 'button';
            this.applyPlaylistRankButton(rankBtn, challenge);
            rankBtn.addEventListener('click', () => {
                this.closePlaylistModal();
                onLeaderboard?.(challenge);
            });
            stats.append(rankBtn);

            const availabilityLabel = formatDailyChallengePlaylistAvailabilityLabel(challenge);
            if (availabilityLabel) {
                const availability = document.createElement('span');
                availability.className = 'daily-playlist-metric daily-playlist-metric--time';
                availability.textContent = availabilityLabel;
                stats.append(availability);
            }
            copy.append(titleRow, stats);

            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'daily-playlist-actions';

            const play = document.createElement('button');
            play.className = 'daily-playlist-icon-btn daily-playlist-icon-btn--primary';
            play.type = 'button';
            play.setAttribute('aria-label', `Play ${getDailyChallengeTrackName(challenge)}`);
            play.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" fill="currentColor" aria-hidden="true">
                    <path d="M187.2 100.9C174.8 94.1 159.8 94.4 147.6 101.6C135.4 108.8 128 121.9 128 136L128 504C128 518.1 135.5 531.2 147.6 538.4C159.7 545.6 174.8 545.9 187.2 539.1L523.2 355.1C536 348.1 544 334.6 544 320C544 305.4 536 291.9 523.2 284.9L187.2 100.9z"/>
                </svg>
            `;
            play.addEventListener('click', () => {
                this.closePlaylistModal();
                onPlay?.(challenge);
            });
            actionsWrap.append(play);

            row.append(canvas, copy, actionsWrap);
            list.appendChild(row);
            this.renderPlaylistPreview(canvas, challenge);
        }
    }

    resolvePlaylistRankSnapshot(challenge) {
        const cached = getCachedDailyChallengeSnapshot(challenge?.id);
        const pendingEntry = getDailyChallengeVerificationEntry(challenge?.id);
        const isPending = getDailyChallengeVerificationState(challenge?.id) === 'pending'
            && pendingEntry;
        if (!isPending) {
            return cached;
        }
        return {
            ...(cached || {}),
            playerRankLabel: null,
            isLoading: true,
            statusText: 'Pending verification',
        };
    }

    applyPlaylistRankButton(button, challenge) {
        const trackName = getDailyChallengeTrackName(challenge);
        const rankDisplay = buildScoreboardRankDisplay(
            this.resolvePlaylistRankSnapshot(challenge),
            { fallbackText: '--' }
        );
        button.replaceChildren();
        button.classList.toggle('daily-playlist-rank-btn--loading', rankDisplay.isLoading);

        if (rankDisplay.isLoading) {
            button.textContent = '--';
            button.setAttribute('aria-busy', 'true');
            button.setAttribute('aria-label', `Loading rank for ${trackName}. Open leaderboard.`);
            return;
        }

        button.removeAttribute('aria-busy');
        const rankText = rankDisplay.text || '--';
        if (rankText.startsWith('#')) {
            button.innerHTML = `<span class="rank-hash">#</span><span class="rank-num">${rankText.slice(1)}</span>`;
        } else {
            button.textContent = rankText;
        }
        button.setAttribute(
            'aria-label',
            rankText && rankText !== 'N/A'
                ? `Rank ${rankText} on ${trackName}. Open leaderboard.`
                : `No rank on ${trackName}. Open leaderboard.`
        );
    }

    renderPlaylistPreview(canvas, challenge) {
        const track = TRACKS[challenge.trackKey];
        if (!track) return;
        const presentation = resolveTrackPresentation(challenge.trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event: challenge.skin ? { key: 'daily-challenge', trackKey: challenge.trackKey, skin: challenge.skin } : null
        });
        renderTrackPreviewCanvas(canvas, {
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

    getDailyChallengeScoreboardSnapshot() {
        return this._dailyChallengeSummary?.scoreboardSnapshot || null;
    }

    refreshDailyChallengeVerificationState(challengeId = this._dailyChallengeSummary?.challengeId) {
        if (!challengeId || this._dailyChallengeSummary?.challengeId !== challengeId) return;

        const summary = this._dailyChallengeSummary;
        const verificationEntry = getDailyChallengeVerificationEntry(challengeId);
        const verificationState = getDailyChallengeVerificationState(challengeId);
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

        if (verificationState === 'pending' && verificationEntry) {
            nextSummary.bestTime = Number.isFinite(verificationEntry.bestTime)
                ? verificationEntry.bestTime
                : verifiedBestTime;
            nextSummary.bestLabel = formatDailyChallengeBestLabel(
                summary.objectiveType,
                verificationEntry.bestTime,
                verificationEntry.completedLaps
            );
            nextSummary.scoreboardSnapshot = {
                ...(verifiedScoreboardSnapshot || {}),
                playerRankLabel: null,
                isLoading: true,
                verificationState: 'pending',
                statusText: 'Pending verification'
            };
        } else if (verificationState === 'rejected') {
            nextSummary.scoreboardSnapshot = {
                ...(verifiedScoreboardSnapshot || {}),
                isLoading: false,
                verificationState: 'rejected',
                statusText: 'Rejected'
            };
        }

        this.setDailyChallengeSummary(nextSummary);
    }

    updateDailyChallengeCountdown() {
        if (!this.dailyChallengeReset) return;

        if (!this._dailyChallengeSummary?.available || !this._dailyChallengeSummary?.endsAt) {
            this.dailyChallengeReset.textContent = '--';
            return;
        }

        const remainingMs = Date.parse(this._dailyChallengeSummary.endsAt) - Date.now();
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
            this.dailyChallengeReset.textContent = 'soon';
            return;
        }

        const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const parts = [];
        if (hours > 0) parts.push(`${hours}h`);
        parts.push(`${minutes}m`);
        this.dailyChallengeReset.textContent = parts.join(' ');
    }

    setDailyChallengeHud(state = null) {
        const isVisible = Boolean(state?.visible);
        const progressText = isVisible ? (state?.progressText || '') : '';
        const typeText = isVisible ? (state?.typeText || 'Daily challenge') : '';
        
        if (this.dailyChallengeHudInline) {
            this.dailyChallengeHudInline.hidden = !isVisible;
            const progressSpan = this.dailyChallengeHudInline.querySelector('.daily-challenge-hud__progress');
            const typeSpan = this.dailyChallengeHudInline.querySelector('.daily-challenge-hud__type');
            if (typeSpan) typeSpan.textContent = typeText;
            if (progressSpan) progressSpan.textContent = progressText;
        }
        if (this.hudLapCluster) {
            this.hudLapCluster.classList.toggle('hud-lap-cluster--daily-active', isVisible);
        }
    }
}
