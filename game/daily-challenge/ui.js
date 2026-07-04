import {
    formatDailyChallengeBestLabel,
    getDailyChallengeBestResult,
    getDailyChallengeCopyLabels,
    getDailyChallengeTrackName
} from './service.js?v=2.09';
import { buildScoreboardRankDisplay } from '../race/result-flow.js?v=2.09';
import {
    getDailyChallengeVerificationEntry,
    getVerificationSnapshotFromQueueEntry
} from '../scoreboard/verification-queue.js';
import { renderCachedTrackPreviewCanvas } from '../track/preview-renderer.js';
import { TRACKS } from '../track/tracks.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from '../track/presentation.js';
import {
    setCarAssetImageWithFallbacks,
    STOCK_CAR_ASSET_NAME
} from '../car/sprite.js';
import { closeModalElement, openModalElement } from '../ui/modal-handoff.js';
import { bindReusableModal, configureReusableModal } from '../ui/reusable-modal.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';
import { getMedalForLapTime } from '../medals/medals.js?v=2.09';

function scheduleAfterModalPaint(callback) {
    requestAnimationFrame(() => {
        requestAnimationFrame(callback);
    });
}

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
        this._playlistModalMode = null;
        this._dailyPreviewKey = '';
    }

    get dailyChallengeTitle() { return document.getElementById('daily-challenge-title'); }
    get dailyChallengeTrack() { return document.getElementById('daily-challenge-track'); }
    get dailyChallengeObjective() { return document.getElementById('daily-challenge-objective'); }
    get dailyChallengeModifiers() { return document.getElementById('daily-challenge-modifiers'); }
    get dailyChallengeBestLabel() { return document.getElementById('daily-challenge-best-label'); }
    get dailyChallengeBest() { return document.getElementById('daily-challenge-best'); }
    get dailyChallengeRankBtn() { return document.getElementById('daily-challenge-rank-btn'); }
    get dailyChallengeRankStatus() { return document.getElementById('daily-challenge-rank-status'); }
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
            this.dailyChallengeRankBtn.disabled = false;
            delete this.dailyChallengeRankBtn.dataset.rank;
            this.dailyChallengeRankBtn.setAttribute(
                'aria-label',
                'Open standings for all tracks.'
            );
            this.dailyChallengeRankBtn.classList.toggle(
                'main-menu__item--status-error',
                this._dailyChallengeSummary?.scoreboardSnapshot?.verificationState === 'error'
                    || this._dailyChallengeSummary?.scoreboardSnapshot?.verificationState === 'rejected'
            );
            if (this.dailyChallengeRankStatus) {
                this.dailyChallengeRankStatus.textContent = '';
                this.dailyChallengeRankStatus.hidden = true;
                this.dailyChallengeRankStatus.classList.remove(
                    'main-menu__detail--loading',
                    'main-menu__detail--error'
                );
            }
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
            this._dailyPreviewKey = '';
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
        const previewKey = `${summary.trackKey}:${summary.skin || 'default'}:${canvas.width}x${canvas.height}`;
        if (this._dailyPreviewKey === previewKey) return;
        this._dailyPreviewKey = previewKey;

        renderCachedTrackPreviewCanvas(canvas, {
            cacheKey: `daily-card:${summary.trackKey}:${summary.skin || 'default'}`,
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
        this._playlistModalMode = 'playlist';
        configureReusableModal(modal, {
            title: 'Tracks',
            closeLabel: 'Back',
        });
        this.renderPlaylist(challenges, actions);
        openModalElement(modal, () => modal.classList.add('active'));
        document.body.classList.add('modal-open');
        scheduleAfterModalPaint(() => {
            const firstPlay = modal.querySelector('.daily-playlist-entry--hero');
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
        this._playlistModalMode = null;
        closeModalElement(modal, () => {
            modal.classList.remove('active');
            document.body.classList.remove('modal-open');
        });
    }

    isPlaylistModalOpen() {
        return Boolean(this.dailyChallengePlaylistModal?.classList.contains('active'));
    }

    isLeaderboardTracksModalOpen() {
        return this._playlistModalMode === 'leaderboard' && this.isPlaylistModalOpen();
    }

    bindPlaylistModal() {
        configureReusableModal(this.dailyChallengePlaylistModal, {
            title: 'Tracks',
            closeLabel: 'Back',
        });
        bindReusableModal(this.dailyChallengePlaylistModal, () => this.closePlaylistModal());
    }

    getPlaylistEntryDateParts(challenge) {
        const source = typeof challenge?.startsAt === 'string' && challenge.startsAt
            ? challenge.startsAt
            : (typeof challenge?.challengeDate === 'string' && challenge.challengeDate
                ? `${challenge.challengeDate}T00:00:00.000Z`
                : '');
        const timeMs = Date.parse(source);
        if (!Number.isFinite(timeMs)) {
            return {
                weekday: '--',
                dateLabel: '--'
            };
        }

        const date = new Date(timeMs);
        return {
            weekday: new Intl.DateTimeFormat('en-US', {
                weekday: 'short',
                timeZone: 'UTC'
            }).format(date),
            dateLabel: new Intl.DateTimeFormat('en-US', {
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC'
            }).format(date)
        };
    }

    getPlaylistEntryAvailabilityProgress(challenge) {
        const startMs = Date.parse(challenge?.startsAt || '');
        const endMs = Date.parse(challenge?.availableUntil || '');
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            return null;
        }

        const remaining = Math.max(0, endMs - Date.now());
        const total = endMs - startMs;
        return Math.max(0, Math.min(1, remaining / total));
    }

    renderPlaylist(challenges = [], actions = null) {
        const list = this.dailyChallengePlaylistList;
        if (!list) return;
        list.replaceChildren();
        const onPlay = typeof actions === 'function'
            ? actions
            : actions?.onPlay;

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
            const dateParts = this.getPlaylistEntryDateParts(challenge);
            const isCurrentTrack = challenge.id === this._dailyChallengeSummary?.challengeId;
            const trackName = getDailyChallengeTrackName(challenge);
            const bestResult = getDailyChallengeBestResult(challenge);
            const bestMedal = getMedalForLapTime(challenge.trackKey, Number(bestResult?.bestTime));

            const row = document.createElement('button');
            row.className = `daily-playlist-entry--hero${isCurrentTrack ? ' current' : ''}`;
            row.type = 'button';
            row.setAttribute(
                'aria-label',
                `Race ${trackName} from ${dateParts.weekday} ${dateParts.dateLabel}`
            );
            row.addEventListener('click', () => {
                this.closePlaylistModal();
                onPlay?.(challenge);
            });

            const preview = document.createElement('div');
            preview.className = 'daily-playlist-hero-preview';

            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 160;
            preview.appendChild(canvas);
            this.renderPlaylistPreview(canvas, challenge);

            const content = document.createElement('div');
            content.className = 'daily-playlist-hero-content';

            const info = document.createElement('div');
            info.className = 'daily-playlist-hero-info';

            const day = document.createElement('span');
            day.className = 'daily-playlist-hero-day';
            day.textContent = isCurrentTrack ? 'Today' : dateParts.dateLabel;

            const title = document.createElement('span');
            title.className = 'daily-playlist-hero-title';
            title.textContent = trackName;

            info.append(day, title);

            const medal = document.createElement('div');
            medal.className = 'daily-playlist-hero-medal';
            medal.setAttribute('aria-hidden', 'true');
            medal.appendChild(createMedalIconSvg(
                bestMedal || 'white',
                {
                    className: 'medal-svg--hero',
                    outline: !bestMedal,
                    rowPlaceholder: !bestMedal
                }
            ));

            content.append(info, medal);
            row.append(preview, content);

            list.appendChild(row);
        }
    }

    openLeaderboardTracksModal(trackRows = [], actions = null) {
        const modal = this.dailyChallengePlaylistModal;
        if (!modal) return;
        this._playlistModalMode = 'leaderboard';
        configureReusableModal(modal, {
            title: 'Standings',
            closeLabel: 'Back',
        });
        this.renderLeaderboardTracks(trackRows, actions);
        openModalElement(modal, () => modal.classList.add('active'));
        document.body.classList.add('modal-open');
        scheduleAfterModalPaint(() => {
            const firstTrack = modal.querySelector('.daily-playlist-entry--hero');
            if (firstTrack instanceof HTMLButtonElement) {
                firstTrack.focus();
            } else {
                this.dailyChallengePlaylistCloseBtn?.focus?.();
            }
        });
    }

    renderLeaderboardTracks(trackRows = [], actions = null) {
        const list = this.dailyChallengePlaylistList;
        if (!list) return;
        list.replaceChildren();
        const onTrack = actions?.onTrack;

        if (trackRows === null) {
            const loading = document.createElement('div');
            loading.className = 'daily-playlist-empty';
            loading.textContent = 'Loading days...';
            list.appendChild(loading);
            return;
        }

        const rows = Array.isArray(trackRows)
            ? trackRows.filter((row) => row?.trackKey && TRACKS[row.trackKey])
            : [];
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'daily-playlist-empty';
            empty.textContent = 'No days available';
            list.appendChild(empty);
            return;
        }

        for (const rowData of rows) {
            const challenge = rowData.challenge || rowData;
            const track = TRACKS[rowData.trackKey];
            const dateParts = this.getPlaylistEntryDateParts(challenge);
            const isCurrentTrack = challenge.id === this._dailyChallengeSummary?.challengeId;
            const trackName = getDailyChallengeTrackName(challenge);

            const row = document.createElement('button');
            row.className = `daily-playlist-entry--hero${isCurrentTrack ? ' current' : ''}`;
            row.type = 'button';
            row.setAttribute(
                'aria-label',
                `Open leaderboard for ${trackName} from ${dateParts.weekday} ${dateParts.dateLabel}`
            );
            row.addEventListener('click', () => {
                this.closePlaylistModal();
                onTrack?.(challenge);
            });

            const preview = document.createElement('div');
            preview.className = 'daily-playlist-hero-preview';

            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 160;
            preview.appendChild(canvas);
            this.renderPlaylistPreview(canvas, challenge);

            const content = document.createElement('div');
            content.className = 'daily-playlist-hero-content';

            const info = document.createElement('div');
            info.className = 'daily-playlist-hero-info';

            const day = document.createElement('span');
            day.className = 'daily-playlist-hero-day';
            day.textContent = isCurrentTrack ? 'Today' : dateParts.dateLabel;

            const title = document.createElement('span');
            title.className = 'daily-playlist-hero-title';
            title.textContent = trackName;

            info.append(day, title);

            const standing = document.createElement('div');
            standing.className = 'daily-leaderboard-standing';

            const standingMain = document.createElement('span');
            standingMain.className = 'daily-playlist-rank-btn daily-leaderboard-standing-main';

            const standingSub = document.createElement('span');
            standingSub.className = 'daily-leaderboard-standing-sub';

            this.applyLeaderboardTrackStanding(standingMain, standingSub, rowData);
            standing.append(standingMain, standingSub);

            content.append(info, standing);
            row.append(preview, content);

            list.appendChild(row);
        }
    }

    applyLeaderboardTrackStanding(mainElement, subElement, rowData) {
        const rankDisplay = buildScoreboardRankDisplay(
            rowData?.scoreboardSnapshot,
            { fallbackText: '--' }
        );
        const totalCount = Math.max(0, Math.trunc(Number(rowData?.scoreboardSnapshot?.totalCount)));
        mainElement.replaceChildren();
        mainElement.classList.toggle('daily-playlist-rank-btn--loading', rankDisplay.isLoading);
        mainElement.toggleAttribute('aria-busy', rankDisplay.isLoading);

        if (rankDisplay.isLoading) {
            mainElement.textContent = '--';
            subElement.textContent = 'Loading';
            return;
        }

        const rankText = rankDisplay.text || '--';
        if (rankText.startsWith('#')) {
            mainElement.innerHTML = `<span class="rank-hash">#</span><span class="rank-num">${rankText.slice(1)}</span>`;
            subElement.textContent = totalCount > 0 ? `of ${totalCount}` : 'Placed';
        } else {
            mainElement.textContent = rankText;
            subElement.textContent = totalCount > 0 ? 'No time' : 'Open';
        }
    }

    renderPlaylistPreview(canvas, challenge) {
        const track = TRACKS[challenge.trackKey];
        if (!track) return;
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

    getDailyChallengeScoreboardSnapshot() {
        return this._dailyChallengeSummary?.scoreboardSnapshot || null;
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
                ...verificationSnapshot,
                playerRankLabel: null,
                playerRank: null,
                currentPlayerRow: null
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
