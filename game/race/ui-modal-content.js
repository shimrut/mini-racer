import { getTrackName } from '../track/catalog.js';
import {
    applyCombinedRankValue,
    buildChallengeRankSnapshot,
    buildModalDeltaDisplay,
} from '../race/result-flow.js';
import { renderWinCombinedMedalOverlay } from '../medals/medals.js';
import { formatSplitTimeDeltaSec } from '../race/lap-speed.js';

const LEADERBOARD_SHARE_ICON_PATH = 'M307.8 18.4c-12 5-19.8 16.6-19.8 29.6l0 80-112 0c-97.2 0-176 78.8-176 176 0 113.3 81.5 163.9 100.2 174.1 2.5 1.4 5.3 1.9 8.1 1.9 10.9 0 19.7-8.9 19.7-19.7 0-7.5-4.3-14.4-9.8-19.5-9.4-8.8-22.2-26.4-22.2-56.7 0-53 43-96 96-96l96 0 0 80c0 12.9 7.8 24.6 19.8 29.6s25.7 2.2 34.9-6.9l160-160c12.5-12.5 12.5-32.8 0-45.3l-160-160c-9.2-9.2-22.9-11.9-34.9-6.9z';
// Font Awesome Free v7.3.1 ghost icon — https://fontawesome.com/license/free
const LEADERBOARD_RACE_ICON_PATH = 'M40.1 467.1l-11.2 9C25.7 478.6 21.8 480 17.8 480 8 480 0 472 0 462.2L0 192C0 86 86 0 192 0S384 86 384 192l0 270.2c0 9.8-8 17.8-17.8 17.8-4 0-7.9-1.4-11.1-3.9l-11.2-9c-13.4-10.7-32.8-9-44.1 3.9L269.3 506c-3.3 3.8-8.2 6-13.3 6s-9.9-2.2-13.3-6l-26.6-30.5c-12.7-14.6-35.4-14.6-48.2 0L141.3 506c-3.3 3.8-8.2 6-13.3 6s-9.9-2.2-13.3-6L84.2 471c-11.3-12.9-30.7-14.6-44.1-3.9zM160 192a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zm96 32a32 32 0 1 0 0-64 32 32 0 1 0 0 64z';

function appendLeaderboardRowAction(item, {
    shareable = false,
    raceable = false,
} = {}) {
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
    } else if (raceable) {
        const raceIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        raceIcon.classList.add('leaderboard-row__race', 'leaderboard-row__race-icon');
        raceIcon.setAttribute('viewBox', '0 0 384 512');
        raceIcon.setAttribute('fill', 'currentColor');
        raceIcon.setAttribute('aria-hidden', 'true');
        raceIcon.setAttribute('focusable', 'false');
        const raceIconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        raceIconPath.setAttribute('d', LEADERBOARD_RACE_ICON_PATH);
        raceIcon.appendChild(raceIconPath);
        action.appendChild(raceIcon);
    }
    item.appendChild(action);
}

const LEADERBOARD_ROW_ACTION_SHARE = 'share';
const LEADERBOARD_ROW_ACTION_RACE = 'race';
const LEADERBOARD_ROW_ACTION_NONE = 'none';

function buildLeaderboardRowKey(prefix, rank, usedKeys) {
    const base = `${prefix}:${rank ?? ''}`;
    let key = base;
    let suffix = 2;
    while (usedKeys.has(key)) {
        key = `${base}#${suffix}`;
        suffix += 1;
    }
    usedKeys.add(key);
    return key;
}

function setLeaderboardText(element, text) {
    if (element.textContent === text) return;
    element.textContent = text;
}

function ensureLeaderboardRowCell(item, className, tagName) {
    const existing = item.querySelector(`.${className}`);
    if (existing) return existing;

    const cell = document.createElement(tagName);
    cell.className = className;
    item.appendChild(cell);
    return cell;
}

function syncLeaderboardRowAction(item, actionState) {
    const existing = item.querySelector('.leaderboard-row__action');
    if (!actionState) {
        existing?.remove();
        return;
    }
    if (existing?.dataset.actionState === actionState) return;

    existing?.remove();
    appendLeaderboardRowAction(item, {
        shareable: actionState === LEADERBOARD_ROW_ACTION_SHARE,
        raceable: actionState === LEADERBOARD_ROW_ACTION_RACE,
    });
    const action = item.querySelector('.leaderboard-row__action');
    if (action) {
        action.dataset.actionState = actionState;
    }
}

function applyLeaderboardRowSpec(item, spec) {
    if (item.className !== spec.rowClass) {
        item.className = spec.rowClass;
    }

    if (spec.role) {
        item.setAttribute('role', spec.role);
    } else {
        item.removeAttribute('role');
    }

    if (spec.ariaHidden) {
        item.setAttribute('aria-hidden', 'true');
    } else {
        item.removeAttribute('aria-hidden');
    }

    if (spec.ariaLive) {
        item.setAttribute('aria-live', spec.ariaLive);
    } else {
        item.removeAttribute('aria-live');
    }

    if (spec.interactive) {
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', spec.ariaLabel);
    } else {
        item.removeAttribute('tabindex');
        item.removeAttribute('aria-label');
        item.onclick = null;
        item.onkeydown = null;
    }

    if (spec.opponentEntry) {
        item._opponentRaceEntry = spec.opponentEntry;
    } else {
        delete item._opponentRaceEntry;
    }

    if (!spec.hasCells) {
        setLeaderboardText(item, spec.text || '');
        return;
    }

    const rankCell = ensureLeaderboardRowCell(item, 'combined-row-rank', 'div');
    if (spec.hasRankData) {
        rankCell.dataset.rank = spec.rank;
    } else {
        delete rankCell.dataset.rank;
    }
    setLeaderboardText(rankCell, spec.rankText);
    setLeaderboardText(ensureLeaderboardRowCell(item, 'combined-row-name', 'span'), spec.nameText);
    setLeaderboardText(ensureLeaderboardRowCell(item, 'combined-row-time', 'span'), spec.timeText);

    syncLeaderboardRowAction(item, spec.actionState);
}

function syncLeaderboardRows(list, rowSpecs) {
    const kindByKey = new Map(rowSpecs.map((spec) => [spec.key, spec.kind]));
    const existingByKey = new Map();
    for (const child of Array.from(list.children)) {
        const key = child.dataset?.rowKey;
        if (key && kindByKey.get(key) === child.dataset.rowKind && !existingByKey.has(key)) {
            existingByKey.set(key, child);
        } else {
            child.remove();
        }
    }

    let cursor = list.firstChild;

    for (const spec of rowSpecs) {
        let item = existingByKey.get(spec.key);

        if (item && item === cursor) {
            cursor = cursor.nextSibling;
        } else {
            if (!item) {
                item = document.createElement('div');
                item.dataset.rowKey = spec.key;
                item.dataset.rowKind = spec.kind;
            }
            list.insertBefore(item, cursor);
        }

        applyLeaderboardRowSpec(item, spec);
    }
}

function syncLeaderboardHeaderRow(section, subheadText) {
    const existing = section.querySelector('.leaderboard-header-row');
    if (subheadText === null) {
        existing?.remove();
        return;
    }
    if (existing) {
        setLeaderboardText(existing.querySelector('.leaderboard-subhead'), subheadText);
        return;
    }

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
    subhead.textContent = subheadText;
    headerStack.appendChild(subhead);

    headerRow.appendChild(headerStack);
    section.insertBefore(headerRow, section.firstChild);
}

function syncLeaderboardEmptyState(section, { isLoading, text }) {
    section.querySelector('.leaderboard-list')?.remove();

    const existing = section.querySelector('.combined-empty-msg');
    const emptyState = existing || document.createElement('div');
    emptyState.className = `combined-empty-msg${isLoading ? ' leaderboard-loading-state' : ''}`;
    emptyState.replaceChildren();
    if (isLoading) {
        const spinner = document.createElement('span');
        spinner.className = 'modal-rank-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        emptyState.appendChild(spinner);
        emptyState.appendChild(document.createTextNode(text));
    } else {
        emptyState.textContent = text;
    }
    if (!existing) {
        section.appendChild(emptyState);
    }
}

function getFinitePositiveRank(value) {
    const rank = Number(value);
    return Number.isFinite(rank) && rank > 0
        ? rank
        : null;
}

export function bindCombinedStatButton(element, {
    interactiveClass = '',
    ariaLabel = '',
    onActivate = null,
} = {}) {
    if (!element) return;
    if (typeof onActivate !== 'function') {
        if (interactiveClass) element.classList.remove(interactiveClass);
        element.removeAttribute('role');
        element.removeAttribute('tabindex');
        element.removeAttribute('aria-label');
        element.onclick = null;
        element.onkeydown = null;
        return;
    }
    if (interactiveClass) element.classList.add(interactiveClass);
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    if (ariaLabel) element.setAttribute('aria-label', ariaLabel);
    else element.removeAttribute('aria-label');
    element.onclick = onActivate;
    element.onkeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onActivate();
    };
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

    get modalLapTimes() { return document.getElementById('modal-lap-times'); }
    renderCombinedMedalOverlay(heroMedalEl, options = {}) {
        if (!heroMedalEl) return;
        heroMedalEl.replaceChildren();
        renderWinCombinedMedalOverlay(heroMedalEl, options);
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
    shareBest = null,
    raceOpponentEnabled = false,
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
    // Only racers with a posted time are listed; `totalCount` is a fallback for older payloads, never a row count.
    const rawEntry = scoreboardSnapshot?.leaderboardEntryCount;
    const leaderboardEntryCount = rawEntry != null && Number.isFinite(Number(rawEntry))
        ? Math.max(0, Math.trunc(Number(rawEntry)))
        : Math.max(0, Math.trunc(Number(scoreboardSnapshot?.totalCount)));
    const hasRowActions = Boolean(shareBest)
        || (
            raceOpponentEnabled
            && (
                topRows.some((entry) => !entry?.isCurrentPlayer && entry?.opponentRaceAvailable === true)
                || nearbyRows.some((entry) => !entry?.isCurrentPlayer && entry?.opponentRaceAvailable === true)
            )
        );

    const trackName = getTrackName(trackKey, null);

    // Reuse the standings already on screen — rebuilding replays every row's entrance animation.
    const existingSection = container.querySelector('.leaderboard-section');
    const section = existingSection || document.createElement('section');
    const leaderboardOnly = container.childElementCount - (existingSection ? 1 : 0) === 0;
    section.className = `leaderboard-section${leaderboardOnly ? ' leaderboard-section--solo' : ''}`;
    section.setAttribute('role', 'region');
    section.setAttribute(
        'aria-label',
        trackName ? `Leaderboard for ${trackName}` : 'Global leaderboard'
    );

    syncLeaderboardHeaderRow(section, showHeader ? (trackName || 'This track') : null);

    const hasScoredRow = topRows.length > 0
        || nearbyRows.length > 0
        || (currentPlayerRow && (Number.isFinite(currentPlayerRow.rank) || currentPlayerRow.rankLabel));

    if (!hasScoredRow && (!leaderboardEntryCount || isLoading)) {
        syncLeaderboardEmptyState(section, {
            isLoading,
            text: isLoading ? 'Loading leaderboard...' : 'No scores recorded yet.',
        });
        if (!existingSection) container.appendChild(section);
        return;
    }

    section.querySelector('.combined-empty-msg')?.remove();

    const rowSpecs = [];
    const usedKeys = new Set();

    const pushScoreboardRowSpec = (entry) => {
        const canShareRow = Boolean(shareBest)
            && entry.isCurrentPlayer
            && Number.isFinite(Number(shareBest.bestTime));
        const canRaceRow = raceOpponentEnabled
            && !entry.isCurrentPlayer
            && entry.opponentRaceAvailable === true
            && Number.isFinite(Number(entry.bestTime));
        const opponentName = typeof entry.displayName === 'string' && entry.displayName.trim()
            ? entry.displayName.trim()
            : 'Anonymous Racer';

        let rowClass = `combined-row leaderboard-row${entry.isCurrentPlayer ? ' is-player current' : ''}`;
        if (canShareRow) rowClass += ' is-shareable';
        else if (canRaceRow) rowClass += ' is-raceable';

        rowSpecs.push({
            key: buildLeaderboardRowKey(
                'score',
                Number.isFinite(entry.rank) ? entry.rank : entry.rankLabel,
                usedKeys,
            ),
            kind: 'score',
            hasCells: true,
            rowClass,
            role: canShareRow || canRaceRow ? 'button' : null,
            interactive: canShareRow || canRaceRow,
            ariaLabel: canShareRow
                ? 'Share your best time for this day'
                : `Race ${opponentName}'s ghost`,
            opponentEntry: canRaceRow ? entry : null,
            hasRankData: true,
            rank: entry.rank,
            rankText: String(Number.isFinite(entry.rank)
                ? entry.rank
                : (entry.rankLabel || '—')),
            nameText: typeof entry.displayName === 'string' && entry.displayName.trim()
                ? entry.displayName
                : 'Anonymous Racer',
            timeText: entry.bestTime != null && Number.isFinite(entry.bestTime)
                ? this.formatLeaderboardTime(entry.bestTime)
                : '--',
            actionState: hasRowActions
                ? (canShareRow
                    ? LEADERBOARD_ROW_ACTION_SHARE
                    : (canRaceRow ? LEADERBOARD_ROW_ACTION_RACE : LEADERBOARD_ROW_ACTION_NONE))
                : null,
        });
    };

    topRows.forEach((entry) => pushScoreboardRowSpec(entry));

    if (!isPaginated && nearbyRows.length) {
        if (topRows.length > 0 && nearbyRows[0]?.rank > (topRows[topRows.length - 1]?.rank || 0) + 1) {
            rowSpecs.push({
                key: buildLeaderboardRowKey('gap', null, usedKeys),
                kind: 'gap',
                hasCells: false,
                rowClass: 'leaderboard-gap-row',
                role: null,
                interactive: false,
                ariaHidden: true,
                opponentEntry: null,
                text: '· · ·',
            });
        }
        nearbyRows.forEach((entry) => pushScoreboardRowSpec(entry));
    } else if (!isPaginated && (
        currentPlayerRow
        && (Number.isFinite(currentPlayerRow.rank) || currentPlayerRow.rankLabel)
        && !topRows.some((entry) => entry.isCurrentPlayer)
    )) {
        pushScoreboardRowSpec(currentPlayerRow);
    }

    if (hasMore) {
        rowSpecs.push({
            key: buildLeaderboardRowKey('pagination', null, usedKeys),
            kind: 'pagination',
            hasCells: false,
            rowClass: 'leaderboard-pagination-state',
            role: 'status',
            interactive: false,
            ariaLive: 'polite',
            opponentEntry: null,
            text: '',
        });
    }

    let list = section.querySelector('.leaderboard-list');
    if (!list) {
        list = document.createElement('div');
        list.className = 'lap-times-list leaderboard-list';
        section.appendChild(list);
    }
    syncLeaderboardRows(list, rowSpecs);

    if (!existingSection) container.appendChild(section);
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
        lapMedal = null,
        challengeFinish = false,
        challengeConfirmPhase = null,
        challengeConfirmStatus = null,
        challengeConfirmError = null,
        challengeViewerAvatarUrl = null,
        challengeVerdict = null,
        challengeBestUpdate = null,
        challengeViewerBest = null,
        previousPersonalBestSec = undefined,
        deltaToPersonalBest = undefined,
        previousTrackMedal = null,
        trackKey = null,
        lapCount = 1,
        lapCheckpointTimes = null,
        pbCheckpointTimes = null,
        pbFinishSec = null,
        raceComparisonTarget = null,
        comparisonOutcome = null,
        deltaToComparison = null
    } = {}) {
        if (!container) return;

        const heroMedalEl = container.querySelector('#combined-hero-medal');
        const rightGroupEl = container.querySelector('#combined-stats-right-group');
        const rankValueEl = container.querySelector('#combined-rank-value');
        const rankTotalEl = container.querySelector('#combined-rank-total');
        const timeEl = container.querySelector('#combined-time');
        const bestLapEl = container.querySelector('#combined-best-lap');
        const label2El = container.querySelector('#combined-stat-label-2');
        const nextMedalStatEl = container.querySelector('#combined-next-medal-stat');
        const nextMedalIconSlot = container.querySelector('#combined-next-medal-icon-slot');
        const nextMedalTimeEl = container.querySelector('#combined-next-medal-time');

        this.renderCombinedMedalOverlay(heroMedalEl, {
            trackKey,
            lapTimeSec: time,
            lapMedal,
            challengeFinish,
            challengeConfirmPhase,
            challengeConfirmStatus,
            challengeConfirmError,
            challengeViewerAvatarUrl,
            challengeVerdict,
            previousPersonalBestSec,
            previousTrackMedal,
            lapCount,
        });
        
        // A challenge run is a real run on the stage or Daily it was minted from, so its sheet reports
        // the same two numbers an ordinary finish reports: the gap to the best held before it, and the
        // rank already held there. That rank number only changes when this run is a personal best.
        const isChallengeHero = Boolean(
            challengeFinish || challengeConfirmPhase || lapMedal === 'challenge',
        );
        // Daily, Campaign, and Head to Head share the lockup sheet. Head to Head
        // still owns YOU WON / YOU LOST; ordinary finishes paint FINISH and keep medals.
        container.classList?.toggle?.('is-challenge-finish', true);
        container.classList?.toggle?.('is-standard-finish', !isChallengeHero);
        this.applyChallengeOpponentStat(container, isChallengeHero ? challengeVerdict : null);
        if (label2El) {
            label2El.hidden = false;
            label2El.removeAttribute('hidden');
            label2El.removeAttribute('aria-hidden');
            // The slot below this label is always a signed gap to the personal
            // best, never a lap time, so the label reads as a comparison in the
            // same shape as the ghost's "VS #1".
            label2El.textContent = isChallengeHero ? 'VS. YOUR PB' : 'VS PB';
        }
        const challengeRankSnapshot = isChallengeHero
            ? buildChallengeRankSnapshot(challengeBestUpdate, challengeViewerBest)
            : null;
        applyCombinedRankValue({
            rankValueEl,
            rankTotalEl,
            rightGroupEl,
            scoreboardSnapshot: isChallengeHero
                ? challengeRankSnapshot
                : scoreboardSnapshot,
        });
        this.bindChallengeTrackLockedRank(container, Boolean(challengeRankSnapshot?.trackLocked));
        if (timeEl) {
            timeEl.innerHTML = Number.isFinite(time)
                ? `<span class="time-num">${time.toFixed(3)}</span><span class="time-unit">s</span>`
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
                                        ? `${splitSec.toFixed(3)}s`
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
                                    `${time.toFixed(3)}s`,
                                    deltaFinish,
                                );
                            }
                        },
                    });
                };

                bindCombinedStatButton(timeEl, {
                    interactiveClass: 'combined-stat-value--interactive',
                    ariaLabel: 'View checkpoint split times',
                    onActivate: openSplitsPopover,
                });
            } else {
                bindCombinedStatButton(timeEl, {
                    interactiveClass: 'combined-stat-value--interactive',
                });
            }
        }
        if (bestLapEl) {
            if (raceComparisonTarget && comparisonOutcome) {
                if (label2El) {
                    label2El.textContent = Number.isFinite(raceComparisonTarget.rank)
                        ? `VS #${raceComparisonTarget.rank}`
                        : 'VS';
                }
                const deltaDisplay = buildModalDeltaDisplay({
                    deltaToBest: Number.isFinite(deltaToComparison) ? deltaToComparison : null,
                });
                bestLapEl.textContent = deltaDisplay.text;
                bestLapEl.classList.remove('is-gain', 'is-loss', 'combined-stat-value--placeholder');
                bestLapEl.classList.add('combined-stat-value--pb-delta');
                if (deltaDisplay.valueClass === 'modal-stat-value--delta-negative') {
                    bestLapEl.classList.add('is-gain');
                } else if (deltaDisplay.valueClass === 'modal-stat-value--delta-positive') {
                    bestLapEl.classList.add('is-loss');
                }
            } else {
                this._applyCombinedWinPbDelta(
                    bestLapEl,
                    time,
                    previousPersonalBestSec,
                    // On a challenge `bestLap` is the opponent's target, never the player's own best,
                    // so it is no fallback for a personal best that is not there.
                    isChallengeHero ? null : bestLap,
                    deltaToPersonalBest,
                );
            }
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

    /** The gap to the opponent only exists on a challenge, so its row is hidden everywhere else. */
    applyChallengeOpponentStat(container, verdict) {
        const statEl = container.querySelector('#combined-opponent-stat');
        const valueEl = container.querySelector('#combined-opponent-delta');
        if (!statEl || !valueEl) return;

        const deltaSec = Number(verdict?.deltaSec);
        if (!verdict || !Number.isFinite(deltaSec)) {
            statEl.hidden = true;
            statEl.setAttribute('hidden', '');
            statEl.setAttribute('aria-hidden', 'true');
            return;
        }

        statEl.hidden = false;
        statEl.removeAttribute('hidden');
        statEl.removeAttribute('aria-hidden');
        const deltaDisplay = buildModalDeltaDisplay({ deltaToBest: deltaSec });
        valueEl.textContent = deltaDisplay.text;
        valueEl.classList.remove('is-gain', 'is-loss');
        if (deltaDisplay.valueClass === 'modal-stat-value--delta-negative') {
            valueEl.classList.add('is-gain');
        } else if (deltaDisplay.valueClass === 'modal-stat-value--delta-positive') {
            valueEl.classList.add('is-loss');
        }
    }

    /**
     * A personal-best submit can replace the rank already on the row. Locked Campaign tracks stay
     * locked. Only the rank slot is repainted, so the hero stays put.
     */
    applyChallengeRankStat(container, bestUpdate, viewerBest = null) {
        if (!container) return;
        const snapshot = buildChallengeRankSnapshot(bestUpdate, viewerBest);
        applyCombinedRankValue({
            rankValueEl: container.querySelector('#combined-rank-value'),
            rankTotalEl: container.querySelector('#combined-rank-total'),
            rightGroupEl: container.querySelector('#combined-stats-right-group'),
            scoreboardSnapshot: snapshot,
        });
        this.bindChallengeTrackLockedRank(container, Boolean(snapshot?.trackLocked));
    }

    bindChallengeTrackLockedRank(container, trackLocked) {
        bindCombinedStatButton(
            container?.querySelector('#combined-stats-right-group'),
            trackLocked
                ? {
                    interactiveClass: 'combined-stats-right-group--interactive',
                    ariaLabel: 'Track locked. Open explanation.',
                    onActivate: () => this.openChallengeTrackLockedPopover(container),
                }
                : { interactiveClass: 'combined-stats-right-group--interactive' },
        );
    }

    openChallengeTrackLockedPopover(container) {
        mountCombinedPopoverOverlay(container, {
            title: 'TRACK LOCKED',
            overlayClass: 'combined-track-locked-overlay',
            buildRows: (listEl) => {
                const row = document.createElement('div');
                row.className = 'combined-medal-times-row';
                const label = document.createElement('span');
                label.className = 'combined-medal-times-label';
                label.textContent = "You haven't unlocked this track in Campaign, so you can't rank for it.";
                row.appendChild(label);
                listEl.appendChild(row);
            },
        });
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '--';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
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
