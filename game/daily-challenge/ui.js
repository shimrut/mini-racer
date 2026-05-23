import {
    formatDailyChallengeBestLabel,
    getDailyChallengeCopyLabels
} from './service.js?v=1.91';
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
