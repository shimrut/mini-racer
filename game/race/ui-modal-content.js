import { TRACKS } from '../track/tracks.js?v=2.09';
import { getLeaderboardPlayerName } from '../scoreboard/service.js?v=2.09';
import { buildModalDeltaDisplay, buildScoreboardRankDisplay } from '../race/result-flow.js?v=2.09';
import { createCrashMedalHeroIcon, createMedalIconSvg } from '../medals/medal-icon.js?v=2.09';
import { renderWinCombinedMedalOverlay } from '../medals/medals.js?v=2.09';
import { formatSplitTimeDeltaSec } from '../race/lap-speed.js?v=2.09';

const MAX_COMMUNITY_PLACEHOLDER_LEADERBOARD_ROWS = 150;

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

    createModalActionIcon(iconName) {
    if (!iconName) return null;

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('modal-action-icon');

    const addPath = (d) => {
        const path = document.createElementNS(svgNs, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    };

    const addRect = (x, y, width, height, rx) => {
        const rect = document.createElementNS(svgNs, 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', width);
        rect.setAttribute('height', height);
        rect.setAttribute('rx', rx);
        svg.appendChild(rect);
    };

    const addCircle = (cx, cy, r) => {
        const circle = document.createElementNS(svgNs, 'circle');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', r);
        svg.appendChild(circle);
    };

    const addLine = (x1, y1, x2, y2) => {
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        svg.appendChild(line);
    };

    const addPolyline = (points) => {
        const polyline = document.createElementNS(svgNs, 'polyline');
        polyline.setAttribute('points', points);
        svg.appendChild(polyline);
    };

    switch (iconName) {
        case 'play':
            svg.setAttribute('fill', 'currentColor');
            svg.setAttribute('stroke', 'none');
            addPath('M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z');
            break;
        case 'quit':
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            addPath('M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z');
            addPath('m15 9-6 6');
            addPath('m9 9 6 6');
            break;
        case 'done':
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            addPath('M21.801 10A10 10 0 1 1 17 3.335');
            addPath('m9 11 3 3L22 4');
            break;
        case 'retry':
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            addPath('M10 2h4');
            addPath('M12 14v-4');
            addPath('M4 13a8 8 0 0 1 8-7 8 8 0 1 1-5.3 14L4 17.6');
            addPath('M9 17H4v5');
            break;
        case 'save':
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            addPolyline('14.5 17.5 3 6 3 3 6 3 17.5 14.5');
            addLine('13', '19', '19', '13');
            addLine('16', '16', '20', '20');
            addLine('19', '21', '21', '19');
            addPolyline('14.5 6.5 18 3 21 3 21 6 17.5 9.5');
            addLine('5', '14', '9', '18');
            addLine('7', '17', '4', '20');
            addLine('3', '19', '5', '21');
            break;
        default:
            return null;
    }

    return svg;
}

    setModalActionButtonContent(button, label, { shortcutLabel = null, iconName = null } = {}) {
    if (!button) return;

    button.replaceChildren();
    const icon = this.createModalActionIcon(iconName);
    if (icon) button.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'modal-action-label';
    text.textContent = label;
    button.appendChild(text);

    if (!shortcutLabel) return;

    const kbd = document.createElement('kbd');
    kbd.className = 'modal-btn-kbd';
    kbd.textContent = shortcutLabel;
    button.appendChild(document.createTextNode(' '));
    button.appendChild(kbd);
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
    showHeader = true
} = {}) {
    if (!container) return;
    const isLoading = Boolean(scoreboardSnapshot?.isLoading);
    const topRows = Array.isArray(scoreboardSnapshot?.topRows)
        ? scoreboardSnapshot.topRows
        : [];
    const nearbyRows = Array.isArray(scoreboardSnapshot?.nearbyRows)
        ? scoreboardSnapshot.nearbyRows
        : [];
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

    const trackMeta = trackKey && TRACKS[trackKey] ? TRACKS[trackKey] : null;
    const trackName = trackMeta?.name || null;

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
        item.className = `combined-row${entry.isCurrentPlayer ? ' is-player' : ''}`;

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
            : getLeaderboardPlayerName(entry.playerId);
        item.appendChild(rowLabel);

        const runTime = document.createElement('span');
        runTime.className = 'combined-row-time';
        if (entry.bestTime != null && Number.isFinite(entry.bestTime)) {
            runTime.textContent = this.formatTime(entry.bestTime);
        } else {
            runTime.textContent = '--';
        }
        item.appendChild(runTime);

        list.appendChild(item);
    };

    const appendCommunityOpenRow = (rank) => {
        const item = document.createElement('div');
        item.className = 'combined-row combined-row--community-open';

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

        list.appendChild(item);
    };

    topRows.forEach((entry) => appendScoreboardRow(entry));

    if (nearbyRows.length) {
        if (topRows.length > 0 && nearbyRows[0]?.rank > (topRows[topRows.length - 1]?.rank || 0) + 1) {
            const gapRow = document.createElement('div');
            gapRow.className = 'leaderboard-gap-row';
            gapRow.setAttribute('aria-hidden', 'true');
            gapRow.textContent = '· · ·';
            list.appendChild(gapRow);
        }
        nearbyRows.forEach((entry) => appendScoreboardRow(entry));
    } else if (
        currentPlayerRow
        && (Number.isFinite(currentPlayerRow.rank) || currentPlayerRow.rankLabel)
        && !topRows.some((entry) => entry.playerId === currentPlayerRow.playerId)
    ) {
        appendScoreboardRow(currentPlayerRow);
    }

    if (openCommunitySlots > 0) {
        const firstRank = leaderboardEntryCount + 1;
        let shown = 0;
        for (let rank = firstRank; rank <= poolTotal && shown < MAX_COMMUNITY_PLACEHOLDER_LEADERBOARD_ROWS; rank += 1) {
            appendCommunityOpenRow(rank);
            shown += 1;
        }
        const remaining = openCommunitySlots - shown;
        if (remaining > 0) {
            const summary = document.createElement('div');
            summary.className = 'combined-row combined-row--community-open combined-row--community-summary';
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
        if (rankValueEl) {
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
        }
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
