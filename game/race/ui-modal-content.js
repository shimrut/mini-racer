import { getTrackName } from '../track/catalog.js';
import { applyCombinedRankValue, buildModalDeltaDisplay } from '../race/result-flow.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';
import { renderWinCombinedMedalOverlay } from '../medals/medals.js';
import { formatSplitTimeDeltaSec } from '../race/lap-speed.js';

const MAX_COMMUNITY_PLACEHOLDER_LEADERBOARD_ROWS = 150;

const LEADERBOARD_SHARE_ICON_PATH = 'M307.8 18.4c-12 5-19.8 16.6-19.8 29.6l0 80-112 0c-97.2 0-176 78.8-176 176 0 113.3 81.5 163.9 100.2 174.1 2.5 1.4 5.3 1.9 8.1 1.9 10.9 0 19.7-8.9 19.7-19.7 0-7.5-4.3-14.4-9.8-19.5-9.4-8.8-22.2-26.4-22.2-56.7 0-53 43-96 96-96l96 0 0 80c0 12.9 7.8 24.6 19.8 29.6s25.7 2.2 34.9-6.9l160-160c12.5-12.5 12.5-32.8 0-45.3l-160-160c-9.2-9.2-22.9-11.9-34.9-6.9z';

function appendLeaderboardRowAction(item, { shareable = false } = {}) {
    const action = document.createElement('span');
    action.className = 'leaderboard-row__action';
    if (shareable) {
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'leaderboard-row__share';
        shareBtn.setAttribute('aria-hidden', 'true');
        shareBtn.setAttribute('tabindex', '-1');
        shareBtn.disabled = false;

        const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        glyph.classList.add('leaderboard-row__share-icon');
        glyph.setAttribute('viewBox', '0 0 512 512');
        glyph.setAttribute('fill', 'currentColor');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.setAttribute('focusable', 'false');
        const glyphPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        glyphPath.setAttribute('d', LEADERBOARD_SHARE_ICON_PATH);
        glyph.appendChild(glyphPath);

        const shareLabel = document.createElement('span');
        shareLabel.className = 'combined-action-btn-label';
        shareLabel.textContent = 'Share Best';
        shareLabel.hidden = true;

        shareBtn.append(glyph, shareLabel);
        action.appendChild(shareBtn);
    }
    item.appendChild(action);
}

function getFinitePositiveRank(value) {
    const rank = Number(value);
    return Number.isFinite(rank) && rank > 0
        ? rank
        : null;
}

export function bindPopoverOverlayEscapeDismiss(onDismiss) {
    if (typeof document === 'undefined') return () => {};

    const onKeydown = (event) => {
        if (event.key !== 'Escape' && event.code !== 'Escape') return;
        event.preventDefault?.();
        event.stopPropagation?.();
        document.removeEventListener('keydown', onKeydown, true);
        onDismiss();
    };
    document.addEventListener('keydown', onKeydown, true);
    return () => document.removeEventListener('keydown', onKeydown, true);
}

/**
 * @param {HTMLElement} container
 * @param {{ title: string, overlayClass?: string, buildRows: (listEl: HTMLElement) => void }} options
 */
export function mountCombinedPopoverOverlay(container, { title, overlayClass = '', buildRows }) {
    const existing = container.querySelector('.combined-medal-times-overlay');
    if (existing) return;

    const overlay = document.createElement('div');
    overlay.className = `combined-medal-times-overlay${overlayClass ? ` ${overlayClass}` : ''}`;

    const modalContainer = document.createElement('div');
    modalContainer.className = 'combined-medal-times-modal';

    const headerEl = document.createElement('div');
    headerEl.className = 'combined-medal-times-header';

    const titleEl = document.createElement('h3');
    titleEl.className = 'combined-medal-times-title';
    titleEl.textContent = title;
    headerEl.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'combined-medal-times-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 384 512" fill="currentColor">
            <path d="M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z"/>
        </svg>
    `;
    headerEl.appendChild(closeBtn);
    modalContainer.appendChild(headerEl);

    const listEl = document.createElement('div');
    listEl.className = 'combined-medal-times-list';
    buildRows(listEl);
    modalContainer.appendChild(listEl);

    overlay.appendChild(modalContainer);
    container.appendChild(overlay);

    let unbindEscape = () => {};
    const dismiss = () => {
        unbindEscape();
        unbindEscape = () => {};
        overlay.classList.remove('is-active');
        overlay.addEventListener('transitionend', () => {
            overlay.remove();
        }, { once: true });
    };

    unbindEscape = bindPopoverOverlayEscapeDismiss(dismiss);

    overlay.onclick = (e) => {
        if (e.target === overlay) dismiss();
    };
    closeBtn.onclick = () => dismiss();

    requestAnimationFrame(() => {
        overlay.classList.add('is-active');
    });
}

export class ModalContentUi {
    constructor() {}

    get modalStatsRow() { return document.getElementById('modal-stats-row'); }
    get modalLapTimes() { return document.getElementById('modal-lap-times'); }



    setModalStatCenter(labelText, valueText, valueClass) {
    if (!this.modalStatsRow) return;
    this.modalStatsRow.replaceChildren();
    const center = document.createElement('span');
    center.className = 'modal-stat-center';
    if (labelText) {
        const label = document.createElement('span');
        label.className = 'modal-stat-label';
        label.textContent = labelText;
        center.appendChild(label);
    }
    const value = document.createElement('span');
    value.className = `modal-stat-value${valueClass ? ` ${valueClass}` : ''}`;
    value.textContent = valueText;
    center.appendChild(value);
    this.modalStatsRow.appendChild(center);
}

    setModalStatLeftRight(lapText, deltaText, bestText, { leftLabel = 'Lap', rightLabel = 'Best' } = {}) {
    if (!this.modalStatsRow) return;
    this.modalStatsRow.replaceChildren();

    const left = document.createElement('span');
    left.className = 'modal-stat-left';
    const lapLabel = document.createElement('span');
    lapLabel.className = 'modal-stat-label';
    lapLabel.textContent = leftLabel;
    left.appendChild(lapLabel);
    const lapVal = document.createElement('span');
    lapVal.className = 'modal-stat-value';
    lapVal.textContent = lapText;
    if (deltaText) {
        const deltaSpan = document.createElement('span');
        deltaSpan.className = 'modal-stat-delta';
        deltaSpan.textContent = deltaText;
        lapVal.appendChild(document.createTextNode(' '));
        lapVal.appendChild(deltaSpan);
    }
    left.appendChild(lapVal);
    this.modalStatsRow.appendChild(left);

    const right = document.createElement('span');
    right.className = 'modal-stat-right';
    const bestLabel = document.createElement('span');
    bestLabel.className = 'modal-stat-label';
    bestLabel.textContent = rightLabel;
    right.appendChild(bestLabel);
    const bestVal = document.createElement('span');
    bestVal.className = 'modal-stat-value modal-stat-value--best';
    bestVal.textContent = bestText;
    right.appendChild(bestVal);
    this.modalStatsRow.appendChild(right);
}

    setPauseProgressStats(lapTime, deltaToBest, bestTime, primaryLabel = 'Lap Time') {
    if (!this.modalStatsRow) return;
    const lapText = lapTime === null || lapTime === undefined
        ? '--'
        : `${lapTime.toFixed(2)}s`;
    const bestText = bestTime === null || bestTime === undefined
        ? '--'
        : `${bestTime.toFixed(2)}s`;
    const deltaDisplay = buildModalDeltaDisplay({
        deltaToBest,
        emptyText: '--'
    });

    this.setModalStatLeftRight(lapText, deltaDisplay.text, bestText, {
        leftLabel: primaryLabel,
        rightLabel: 'Best'
    });
}

    setWinStats(lapTime, deltaToBest, primaryLabel = 'Lap Time', { showDelta = true, lapMedal = null } = {}) {
    if (!this.modalStatsRow) return;
    this.modalStatsRow.replaceChildren();

    const lapText = lapTime !== null && lapTime !== undefined
        ? `${lapTime.toFixed(2)}s`
        : '--';
    const deltaDisplay = buildModalDeltaDisplay({
        deltaToBest,
        emptyText: 'New PB',
        emptyValueClass: 'modal-stat-value--delta-negative'
    });

    this.modalStatsRow.appendChild(this.createModalStat(primaryLabel, lapText));
    if (!showDelta) {
        if (lapMedal) {
            this.modalStatsRow.appendChild(this.createModalMedalStat(lapMedal));
        }
        return;
    }

    this.modalStatsRow.appendChild(this.createModalStat('Delta', deltaDisplay.text, deltaDisplay.valueClass));
    if (lapMedal) {
        this.modalStatsRow.appendChild(this.createModalMedalStat(lapMedal));
    }
}

    createModalMedalStat(medal) {
        const stat = document.createElement('span');
        stat.className = 'modal-stat-stack';
        const label = document.createElement('span');
        label.className = 'modal-stat-label';
        label.textContent = 'Medal';
        const value = document.createElement('span');
        value.className = 'modal-stat-value modal-stat-value--compact modal-stat-medal-value';
        value.appendChild(createMedalIconSvg(medal, { className: 'medal-svg--modal' }));
        stat.append(label, value);
        return stat;
    }

    createModalStat(labelText, valueText, valueClass = '', onClick = null) {
    const stat = onClick ? document.createElement('button') : document.createElement('span');
    stat.className = `modal-stat-stack${onClick ? ' modal-stat-button' : ''}`;
    if (onClick) {
        stat.type = 'button';
        stat.addEventListener('click', onClick);
    }

    const label = document.createElement('span');
    label.className = 'modal-stat-label';
    label.textContent = labelText;
    stat.appendChild(label);

    const value = document.createElement('span');
    value.className = `modal-stat-value modal-stat-value--compact${valueClass ? ` ${valueClass}` : ''}`;
    value.textContent = valueText;
    stat.appendChild(value);

    return stat;
}

    renderLapTimesList(container, lapTimesArray, bestTime, currentTime) {
    if (!container || !Array.isArray(lapTimesArray)) return;
    const headerRow = document.createElement('div');
    headerRow.className = 'runs-header-row';
    const headerTitle = document.createElement('span');
    headerTitle.className = 'runs-header-title';
    headerTitle.textContent = 'Your 5 PBs';
    headerRow.appendChild(headerTitle);
    container.appendChild(headerRow);

    const list = document.createElement('div');
    list.className = 'lap-times-list';
    lapTimesArray.forEach((time, index) => {
        const isBest = index === 0;
        const isCurrent = Math.abs(time - currentTime) < 0.001;
        const delta = time - bestTime;

        const item = document.createElement('div');
        item.className = `combined-row${isCurrent ? ' is-player' : ''}`;

        const runIndex = document.createElement('div');
        runIndex.className = 'combined-row-rank';
        if (isBest) {
            runIndex.dataset.rank = '1';
        } else {
            delete runIndex.dataset.rank;
        }
        runIndex.textContent = String(index + 1);
        item.appendChild(runIndex);

        const runName = document.createElement('span');
        runName.className = 'combined-row-name';
        runName.textContent = isBest ? 'PERSONAL BEST' : `RUN ${index + 1}`;
        item.appendChild(runName);

        const runTime = document.createElement('span');
        runTime.className = 'combined-row-time';
        runTime.textContent = this.formatTime(time);
        item.appendChild(runTime);

        list.appendChild(item);
    });

    container.appendChild(list);
}

    renderScoreboardList(container, scoreboardSnapshot, scoreboardMode, trackKey = null, scoreboardSubhead = null, {
    showHeader = true,
    shareBest = null
} = {}) {
    if (!container) return;
    const isLoading = Boolean(scoreboardSnapshot?.isLoading);
    const topRows = Array.isArray(scoreboardSnapshot?.topRows)
        ? scoreboardSnapshot.topRows
        : [];
    const nearbyRows = Array.isArray(scoreboardSnapshot?.nearbyRows)
        ? scoreboardSnapshot.nearbyRows
        : [];
    const isPaginated = Number(scoreboardSnapshot?.pageLimit) > 0;
    const hasMore = scoreboardSnapshot?.hasMore === true;
    const snapshotRank = getFinitePositiveRank(scoreboardSnapshot?.playerRank);
    const snapshotRankLabel = scoreboardSnapshot?.playerRankLabel != null
        ? String(scoreboardSnapshot.playerRankLabel)
        : null;
    const currentPlayerRow = scoreboardSnapshot?.currentPlayerRow
        ? {
            ...scoreboardSnapshot.currentPlayerRow,
            displayName: scoreboardSnapshot.currentPlayerRow.displayName
                || (scoreboardSnapshot.currentPlayerRow.isCurrentPlayer || snapshotRank !== null || snapshotRankLabel
                    ? 'You'
                    : scoreboardSnapshot.currentPlayerRow.displayName),
            rank: Number.isFinite(scoreboardSnapshot.currentPlayerRow.rank)
                ? scoreboardSnapshot.currentPlayerRow.rank
                : (snapshotRank !== null ? snapshotRank : scoreboardSnapshot.currentPlayerRow.rank),
            rankLabel: scoreboardSnapshot.currentPlayerRow.rankLabel || snapshotRankLabel,
        }
        : (snapshotRank !== null || snapshotRankLabel
            ? {
                isCurrentPlayer: true,
                rank: snapshotRank,
                rankLabel: snapshotRankLabel,
                displayName: 'You',
            }
            : null);
    const objectiveType = typeof scoreboardSnapshot?.objectiveType === 'string'
        ? scoreboardSnapshot.objectiveType
        : null;
    const poolTotal = Math.max(0, Math.trunc(Number(scoreboardSnapshot?.totalCount)));
    const rawEntry = scoreboardSnapshot?.leaderboardEntryCount;
    const leaderboardEntryCount = rawEntry != null && Number.isFinite(Number(rawEntry))
        ? Math.max(0, Math.trunc(Number(rawEntry)))
        : poolTotal;
    const openCommunitySlots = Math.max(0, poolTotal - leaderboardEntryCount);

    const trackName = getTrackName(trackKey, null);

    const section = document.createElement('section');
    const leaderboardOnly = container.childElementCount === 0;
    section.className = `leaderboard-section${leaderboardOnly ? ' leaderboard-section--solo' : ''}`;
    section.setAttribute('role', 'region');
    section.setAttribute(
        'aria-label',
        trackName ? `Leaderboard for ${trackName}` : 'Global leaderboard'
    );

    if (showHeader) {
        const headerRow = document.createElement('div');
        headerRow.className = 'runs-header-row leaderboard-header-row';

        const headerStack = document.createElement('div');
        headerStack.className = 'leaderboard-header-stack';

        const trackLine = document.createElement('span');
        trackLine.className = 'leaderboard-hero-track';
        trackLine.textContent = 'Leaderboard';
        headerStack.appendChild(trackLine);

        const subhead = document.createElement('span');
        subhead.className = 'leaderboard-subhead';
        subhead.textContent = trackName || 'This track';
        headerStack.appendChild(subhead);
        headerRow.appendChild(headerStack);
        section.appendChild(headerRow);
    }

    const hasScoredRow = topRows.length > 0
        || nearbyRows.length > 0
        || (currentPlayerRow && (Number.isFinite(currentPlayerRow.rank) || currentPlayerRow.rankLabel));

    if (!hasScoredRow && !poolTotal) {
        const emptyState = document.createElement('div');
        emptyState.className = 'combined-empty-msg';
        if (isLoading) {
            emptyState.classList.add('leaderboard-loading-state');
            const spinner = document.createElement('span');
            spinner.className = 'modal-rank-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            emptyState.appendChild(spinner);
            emptyState.appendChild(document.createTextNode('Loading leaderboard...'));
        } else {
            emptyState.textContent = 'No scores recorded yet.';
        }
        section.appendChild(emptyState);
        container.appendChild(section);
        return;
    }

    if (!hasScoredRow && isLoading) {
        const emptyState = document.createElement('div');
        emptyState.className = 'combined-empty-msg leaderboard-loading-state';
        const spinner = document.createElement('span');
        spinner.className = 'modal-rank-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        emptyState.appendChild(spinner);
        emptyState.appendChild(document.createTextNode('Loading leaderboard...'));
        section.appendChild(emptyState);
        container.appendChild(section);
        return;
    }

    const list = document.createElement('div');
    list.className = 'lap-times-list leaderboard-list';

    const appendScoreboardRow = (entry) => {
        const item = document.createElement('div');
        item.className = `combined-row leaderboard-row${entry.isCurrentPlayer ? ' is-player current' : ''}`;

        const canShareRow = Boolean(shareBest)
            && entry.isCurrentPlayer
            && Number.isFinite(Number(shareBest.bestTime));
        if (canShareRow) {
            item.classList.add('is-shareable');
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', '0');
            item.setAttribute('aria-label', 'Share your best time for this day');
        }

        const runIndex = document.createElement('div');
        runIndex.className = 'combined-row-rank';
        runIndex.dataset.rank = entry.rank;
        runIndex.textContent = Number.isFinite(entry.rank)
            ? entry.rank
            : (entry.rankLabel || '—');
        item.appendChild(runIndex);

        const rowLabel = document.createElement('span');
        rowLabel.className = 'combined-row-name';
        rowLabel.textContent = typeof entry.displayName === 'string' && entry.displayName.trim()
            ? entry.displayName
            : 'Anonymous Racer';
        item.appendChild(rowLabel);

        const runTime = document.createElement('span');
        runTime.className = 'combined-row-time';
        if (entry.bestTime != null && Number.isFinite(entry.bestTime)) {
            runTime.textContent = this.formatLeaderboardTime(entry.bestTime);
        } else {
            runTime.textContent = '--';
        }
        item.appendChild(runTime);

        if (shareBest) {
            appendLeaderboardRowAction(item, { shareable: canShareRow });
        }

        list.appendChild(item);
    };

    const appendCommunityOpenRow = (rank) => {
        const item = document.createElement('div');
        item.className = 'combined-row leaderboard-row combined-row--community-open';

        const runIndex = document.createElement('div');
        runIndex.className = 'combined-row-rank';
        runIndex.dataset.rank = String(rank);
        runIndex.textContent = String(rank);
        item.appendChild(runIndex);

        const rowLabel = document.createElement('span');
        rowLabel.className = 'combined-row-name';
        rowLabel.textContent = 'No time yet';
        item.appendChild(rowLabel);

        const runTime = document.createElement('span');
        runTime.className = 'combined-row-time';
        runTime.textContent = '—';
        item.appendChild(runTime);

        if (shareBest) {
            appendLeaderboardRowAction(item);
        }

        list.appendChild(item);
    };

    topRows.forEach((entry) => appendScoreboardRow(entry));

    if (!isPaginated && nearbyRows.length) {
        if (topRows.length > 0 && nearbyRows[0]?.rank > (topRows[topRows.length - 1]?.rank || 0) + 1) {
            const gapRow = document.createElement('div');
            gapRow.className = 'leaderboard-gap-row';
            gapRow.setAttribute('aria-hidden', 'true');
            gapRow.textContent = '· · ·';
            list.appendChild(gapRow);
        }
        nearbyRows.forEach((entry) => appendScoreboardRow(entry));
    } else if (!isPaginated && (
        currentPlayerRow
        && (Number.isFinite(currentPlayerRow.rank) || currentPlayerRow.rankLabel)
        && !topRows.some((entry) => entry.isCurrentPlayer)
    )) {
        appendScoreboardRow(currentPlayerRow);
    }

    if (openCommunitySlots > 0 && !hasMore) {
        const firstRank = leaderboardEntryCount + 1;
        let shown = 0;
        for (let rank = firstRank; rank <= poolTotal && shown < MAX_COMMUNITY_PLACEHOLDER_LEADERBOARD_ROWS; rank += 1) {
            appendCommunityOpenRow(rank);
            shown += 1;
        }
        const remaining = openCommunitySlots - shown;
        if (remaining > 0) {
            const summary = document.createElement('div');
            summary.className = 'combined-row leaderboard-row combined-row--community-open combined-row--community-summary';
            summary.setAttribute('role', 'note');
            const runIndex = document.createElement('div');
            runIndex.className = 'combined-row-rank';
            runIndex.textContent = '…';
            summary.appendChild(runIndex);
            const rowLabel = document.createElement('span');
            rowLabel.className = 'combined-row-name';
            rowLabel.textContent = `${remaining} more in this community — no time yet`;
            summary.appendChild(rowLabel);
            const runTime = document.createElement('span');
            runTime.className = 'combined-row-time';
            runTime.textContent = '';
            summary.appendChild(runTime);
            list.appendChild(summary);
        }
    }

    if (hasMore) {
        const paginationState = document.createElement('div');
        paginationState.className = 'leaderboard-pagination-state';
        paginationState.setAttribute('role', 'status');
        paginationState.setAttribute('aria-live', 'polite');
        list.appendChild(paginationState);
    }

    section.appendChild(list);
    container.appendChild(section);
}

    centerLeaderboardCurrentRow() {
    const list = this.modalLapTimes?.querySelector('.leaderboard-list');
    const currentRow = list?.querySelector('.leaderboard-row.current');
    if (!list || !currentRow || list.scrollHeight <= list.clientHeight) return;

    const targetScrollTop = currentRow.offsetTop - (list.clientHeight / 2) + (currentRow.offsetHeight / 2);
    const maxScrollTop = list.scrollHeight - list.clientHeight;
    list.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
}

    renderCombinedResults(container, {
        time,
        bestLap,
        scoreboardSnapshot,
        title = 'RACE COMPLETE',
        statLabels = ['THIS LAP', 'BEST LAP'],
        lapMedal = null,
        previousPersonalBestSec = undefined,
        deltaToPersonalBest = undefined,
        previousTrackMedal = null,
        trackKey = null,
        lapCheckpointTimes = null,
        pbCheckpointTimes = null,
        pbFinishSec = null
    } = {}) {
        if (!container) return;

        const heroMedalEl = container.querySelector('#combined-hero-medal');
        const rightGroupEl = container.querySelector('#combined-stats-right-group');
        const rankValueEl = container.querySelector('#combined-rank-value');
        const rankTotalEl = container.querySelector('#combined-rank-total');
        const timeEl = container.querySelector('#combined-time');
        const bestLapEl = container.querySelector('#combined-best-lap');
        const label1El = container.querySelector('#combined-stat-label-1');
        const label2El = container.querySelector('#combined-stat-label-2');
        const nextMedalStatEl = container.querySelector('#combined-next-medal-stat');
        const nextMedalIconSlot = container.querySelector('#combined-next-medal-icon-slot');
        const nextMedalTimeEl = container.querySelector('#combined-next-medal-time');

        if (heroMedalEl) {
            heroMedalEl.replaceChildren();
            renderWinCombinedMedalOverlay(heroMedalEl, {
                trackKey,
                lapTimeSec: time,
                lapMedal,
                previousPersonalBestSec,
                previousTrackMedal,
            });
        }
        
        if (label2El) {
            label2El.hidden = false;
            label2El.removeAttribute('hidden');
            label2El.removeAttribute('aria-hidden');
            label2El.textContent = 'BEST LAP';
        }
        applyCombinedRankValue({
            rankValueEl,
            rankTotalEl,
            rightGroupEl,
            scoreboardSnapshot,
        });
        if (timeEl) {
            timeEl.innerHTML = Number.isFinite(time)
                ? `<span class="time-num">${time.toFixed(2)}</span><span class="time-unit">s</span>`
                : '--';
            timeEl.classList.remove('combined-stat-value--impact');

            const checkpointTimes = Array.isArray(lapCheckpointTimes)
                ? lapCheckpointTimes
                : [];
            const pbCheckpoints = Array.isArray(pbCheckpointTimes)
                ? pbCheckpointTimes
                : [];
            const hasSplits =
                checkpointTimes.length > 0 || Number.isFinite(time);
            if (hasSplits) {
                timeEl.classList.add('combined-stat-value--interactive');
                timeEl.setAttribute('role', 'button');
                timeEl.setAttribute('tabindex', '0');
                timeEl.setAttribute('aria-label', 'View checkpoint split times');

                const openSplitsPopover = () => {
                    mountCombinedPopoverOverlay(container, {
                        title: 'SPLIT TIMES',
                        overlayClass: 'combined-lap-splits-overlay',
                        buildRows: (listEl) => {
                            const addSplitRow = (labelText, valueText, deltaSec) => {
                                const row = document.createElement('div');
                                row.className = 'combined-medal-times-row combined-medal-times-row--split';

                                const label = document.createElement('span');
                                label.className = 'combined-medal-times-label';
                                label.textContent = labelText;

                                const valueEl = document.createElement('span');
                                valueEl.className = 'combined-medal-times-time';
                                valueEl.textContent = valueText;

                                const deltaEl = document.createElement('span');
                                deltaEl.className = 'combined-lap-speed-delta';
                                const deltaDisplay = formatSplitTimeDeltaSec(deltaSec);
                                if (deltaDisplay) {
                                    deltaEl.textContent = deltaDisplay.text;
                                    if (deltaDisplay.isGain) deltaEl.classList.add('is-gain');
                                    if (deltaDisplay.isLoss) deltaEl.classList.add('is-loss');
                                } else {
                                    deltaEl.textContent = '—';
                                    deltaEl.classList.add('combined-lap-speed-delta--empty');
                                }

                                row.appendChild(label);
                                row.appendChild(valueEl);
                                row.appendChild(deltaEl);
                                listEl.appendChild(row);
                            };

                            checkpointTimes.forEach((splitSec, index) => {
                                const pbSec = pbCheckpoints[index];
                                const deltaSec =
                                    Number.isFinite(splitSec) && Number.isFinite(pbSec)
                                        ? splitSec - pbSec
                                        : null;
                                addSplitRow(
                                    `CP ${index + 1}`,
                                    Number.isFinite(splitSec)
                                        ? `${splitSec.toFixed(2)}s`
                                        : '--',
                                    deltaSec,
                                );
                            });

                            if (Number.isFinite(time)) {
                                const deltaFinish =
                                    Number.isFinite(pbFinishSec)
                                        ? time - pbFinishSec
                                        : null;
                                addSplitRow(
                                    'FINISH',
                                    `${time.toFixed(2)}s`,
                                    deltaFinish,
                                );
                            }
                        },
                    });
                };

                timeEl.onclick = openSplitsPopover;
                timeEl.onkeydown = (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openSplitsPopover();
                };
            } else {
                timeEl.classList.remove('combined-stat-value--interactive');
                timeEl.removeAttribute('role');
                timeEl.removeAttribute('tabindex');
                timeEl.removeAttribute('aria-label');
                timeEl.onclick = null;
                timeEl.onkeydown = null;
            }
        }
        if (bestLapEl) {
            this._applyCombinedWinPbDelta(
                bestLapEl,
                time,
                previousPersonalBestSec,
                bestLap,
                deltaToPersonalBest,
            );
            bestLapEl.classList.remove('combined-stat-value--impact');
        }

        if (nextMedalStatEl) {
            nextMedalStatEl.hidden = true;
            nextMedalStatEl.setAttribute('hidden', '');
            nextMedalStatEl.setAttribute('aria-hidden', 'true');
            nextMedalStatEl.removeAttribute('aria-label');
            if (nextMedalIconSlot) nextMedalIconSlot.replaceChildren();
            if (nextMedalTimeEl) nextMedalTimeEl.textContent = '';
        }
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '--';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
    }

    formatLeaderboardTime(seconds) {
        if (!Number.isFinite(seconds)) return '--';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
    }

    _resolveWinPriorPersonalBest(previousPersonalBestSec, fallbackPersonalBestSec) {
        const priorCandidates = [
            previousPersonalBestSec,
            fallbackPersonalBestSec,
        ];
        for (const candidate of priorCandidates) {
            if (candidate === null || candidate === undefined) continue;
            const prior = Number(candidate);
            if (!Number.isFinite(prior)) continue;
            return prior;
        }
        return null;
    }

    _resolveWinDeltaToPersonalBest(
        lapTimeSec,
        previousPersonalBestSec,
        fallbackPersonalBestSec,
        deltaToPersonalBest,
    ) {
        if (previousPersonalBestSec === undefined && deltaToPersonalBest === undefined) {
            return undefined;
        }
        if (Number.isFinite(deltaToPersonalBest)) return deltaToPersonalBest;
        if (!Number.isFinite(lapTimeSec)) return null;

        const prior = this._resolveWinPriorPersonalBest(previousPersonalBestSec, fallbackPersonalBestSec);
        if (Number.isFinite(prior)) return lapTimeSec - prior;
        return null;
    }

    _applyCombinedWinPbDelta(
        el,
        lapTimeSec,
        previousPersonalBestSec,
        fallbackPersonalBestSec,
        deltaToPersonalBest,
    ) {
        if (!el) return;

        const statRow = el.closest('.combined-stat--pb-delta');
        const deltaToPb = this._resolveWinDeltaToPersonalBest(
            lapTimeSec,
            previousPersonalBestSec,
            fallbackPersonalBestSec,
            deltaToPersonalBest,
        );

        if (deltaToPb === undefined || deltaToPb === null) {
            if (statRow) {
                statRow.hidden = false;
                statRow.removeAttribute('hidden');
                statRow.removeAttribute('aria-hidden');
            }
            el.textContent = 'No lap times yet';
            el.classList.remove(
                'combined-stat-value--pb-delta',
                'is-gain',
                'is-loss',
            );
            el.classList.add('combined-stat-value--placeholder');
            return;
        }

        el.classList.remove('combined-stat-value--placeholder');

        if (statRow) {
            statRow.hidden = false;
            statRow.removeAttribute('hidden');
            statRow.removeAttribute('aria-hidden');
        }

        const deltaDisplay = buildModalDeltaDisplay({
            deltaToBest: deltaToPb,
        });
        el.classList.add('combined-stat-value--pb-delta');
        el.classList.remove('is-gain', 'is-loss');
        el.textContent = deltaDisplay.text;
        if (deltaDisplay.valueClass === 'modal-stat-value--delta-negative') {
            el.classList.add('is-gain');
        } else if (deltaDisplay.valueClass === 'modal-stat-value--delta-positive') {
            el.classList.add('is-loss');
        }
    }


}
