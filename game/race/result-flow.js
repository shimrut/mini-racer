function hasFiniteValue(value) {
    return value !== null && value !== undefined && Number.isFinite(value);
}

function hasOwnValue(source, key) {
    return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);
}

export function buildLapRecord(lapNumber, lapTime, previousBestTime = null) {
    return {
        lapNumber,
        time: lapTime,
        deltaVsBest: hasFiniteValue(previousBestTime)
            ? lapTime - previousBestTime
            : null
    };
}

export function pushRecentLap(recentLaps, lapRecord, maxLength = 10) {
    recentLaps.push(lapRecord);
    if (recentLaps.length > maxLength) {
        recentLaps.splice(0, recentLaps.length - maxLength);
    }
    return recentLaps;
}

export function isNewBestResult(policy, candidate, previous) {
    if (!candidate || !policy) return false;

    const candidateTime = hasFiniteValue(candidate.bestTime) ? Number(candidate.bestTime) : null;
    const previousTime = hasFiniteValue(previous?.bestTime) ? Number(previous.bestTime) : null;

    if (candidateTime === null) return false;
    return previousTime === null || candidateTime < previousTime;
}

export function createModalActions({
    modalKind,
    primaryActionLabel,
    primaryAction,
    restartAction = null,
    secondaryActionLabel,
    secondaryAction
} = {}) {
    return {
        modalKind,
        primaryActionLabel,
        primaryAction,
        restartAction,
        secondaryActionLabel,
        secondaryAction
    };
}

export function buildModalDeltaDisplay({
    deltaToBest = null,
    emptyText = '--',
    emptyValueClass = ''
} = {}) {
    if (deltaToBest !== null && deltaToBest !== undefined) {
        if (deltaToBest > 0.0005) {
            return {
                text: `+${deltaToBest.toFixed(3)}s`,
                valueClass: 'modal-stat-value--delta-positive'
            };
        }
        if (deltaToBest < -0.0005) {
            return {
                text: `${deltaToBest.toFixed(3)}s`,
                valueClass: 'modal-stat-value--delta-negative'
            };
        }
        return {
            text: '0.000s',
            valueClass: ''
        };
    }

    return {
        text: emptyText,
        valueClass: emptyValueClass
    };
}

export function buildScoreboardRankDisplay(scoreboardSnapshot, { fallbackText = 'N/A' } = {}) {
    const hasRank = Boolean(scoreboardSnapshot?.playerRankLabel);
    const isLoading = Boolean(scoreboardSnapshot?.isLoading);
    const verificationState = typeof scoreboardSnapshot?.verificationState === 'string'
        ? scoreboardSnapshot.verificationState.trim().toLowerCase()
        : '';
    const submissionStage = typeof scoreboardSnapshot?.submissionStage === 'string'
        ? scoreboardSnapshot.submissionStage.trim().toLowerCase()
        : '';
    const rawStatusText = typeof scoreboardSnapshot?.statusText === 'string'
        ? scoreboardSnapshot.statusText.trim()
        : '';
    const normalizedStatusText = rawStatusText.toLowerCase().replace(/\.+$/, '');
    let labelText = 'Rank';

    if (verificationState === 'error' || submissionStage === 'error') {
        labelText = 'Rank error';
    } else if (verificationState === 'rejected' || submissionStage === 'rejected' || normalizedStatusText === 'rejected') {
        labelText = 'Rank rejected';
    } else if (submissionStage === 'verifying' || normalizedStatusText === 'verifying') {
        labelText = 'Verifying rank';
    } else if (submissionStage === 'submitting' || normalizedStatusText === 'submitting') {
        labelText = 'Submitting rank';
    } else if (submissionStage === 'pending' || normalizedStatusText === 'pending' || normalizedStatusText === 'pending verification') {
        labelText = 'Rank pending';
    } else if (submissionStage === 'retrying' || normalizedStatusText === 'retrying' || normalizedStatusText === 'queued for retry' || normalizedStatusText === 'retrying soon') {
        labelText = 'Retrying rank';
    } else if (isLoading) {
        labelText = 'Loading rank';
    }

    return {
        labelText,
        text: hasRank ? scoreboardSnapshot.playerRankLabel : (isLoading ? '' : fallbackText),
        isLoading,
        statusText: rawStatusText || null
    };
}

const CHALLENGE_RANK_UNRANKED = '—';
const CHALLENGE_RANK_LOCKED = 'TRACK LOCKED';

function toPositiveRank(value) {
    const rank = Number(value);
    return Number.isInteger(rank) && rank > 0 ? rank : null;
}

/**
 * Challenge finishes always show a rank row. The number updates only when this run is a personal
 * best and the submit returns a rank. Until then the row keeps the rank already held on that
 * board, or an empty mark. A Campaign stage the player has not unlocked reads as TRACK LOCKED.
 */
export function buildChallengeRankSnapshot(bestUpdate, viewerBest) {
    if (viewerBest?.trackLocked) {
        return {
            playerRankLabel: CHALLENGE_RANK_LOCKED,
            statusText: CHALLENGE_RANK_LOCKED,
            trackLocked: true,
        };
    }
    const pbRank = toPositiveRank(bestUpdate?.rank);
    if (pbRank) return { playerRankLabel: `#${pbRank}` };
    const heldRank = toPositiveRank(viewerBest?.rank);
    if (heldRank) return { playerRankLabel: `#${heldRank}` };
    return { playerRankLabel: CHALLENGE_RANK_UNRANKED };
}

function setCombinedRankGroupVisible(rightGroupEl, visible) {
    if (!rightGroupEl) return;
    if (visible) {
        rightGroupEl.hidden = false;
        rightGroupEl.removeAttribute('hidden');
        rightGroupEl.removeAttribute('aria-hidden');
        return;
    }
    rightGroupEl.hidden = true;
    rightGroupEl.setAttribute('hidden', '');
    rightGroupEl.setAttribute('aria-hidden', 'true');
}

function clearCombinedRankTotal(rankTotalEl) {
    if (!rankTotalEl) return;
    rankTotalEl.textContent = '';
    rankTotalEl.hidden = true;
    rankTotalEl.setAttribute('hidden', '');
}

export function applyCombinedRankValue({
    rankValueEl,
    rankTotalEl = null,
    rightGroupEl = null,
    scoreboardSnapshot = null,
} = {}) {
    if (!rankValueEl) {
        setCombinedRankGroupVisible(rightGroupEl, false);
        clearCombinedRankTotal(rankTotalEl);
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
            || scoreboardSnapshot?.trackLocked
        );
    rankValueEl.classList.toggle('combined-rank-value--status', shouldShowStatusText);

    if (rankDisplay.isLoading) {
        setCombinedRankGroupVisible(rightGroupEl, true);
        rankValueEl.textContent = rankDisplay.statusText || '--';
        clearCombinedRankTotal(rankTotalEl);
        return;
    }

    if (shouldShowStatusText) {
        setCombinedRankGroupVisible(rightGroupEl, true);
        rankValueEl.textContent = rankDisplay.statusText || '';
        clearCombinedRankTotal(rankTotalEl);
        return;
    }

    if (!rankDisplay.text || rankDisplay.text === 'N/A') {
        setCombinedRankGroupVisible(rightGroupEl, false);
        rankValueEl.textContent = '';
        if (rankTotalEl) rankTotalEl.textContent = '';
        return;
    }

    setCombinedRankGroupVisible(rightGroupEl, true);
    const rankText = rankDisplay.text || '';
    if (rankText.startsWith('#')) {
        rankValueEl.innerHTML = `<span class="rank-hash">#</span><span class="rank-num">${rankText.slice(1)}</span>`;
    } else {
        rankValueEl.textContent = rankText;
    }

    // `??` keeps a real 0 meaning "no racers" while still reading older payloads that only sent `totalCount`.
    const totalRaw = Number(
        scoreboardSnapshot?.leaderboardEntryCount ?? scoreboardSnapshot?.totalCount,
    );
    const totalVal = Number.isFinite(totalRaw) && totalRaw > 0 ? Math.trunc(totalRaw) : 0;
    if (!rankTotalEl) return;
    if (totalVal > 0) {
        rankTotalEl.textContent = `of ${totalVal.toLocaleString()}`;
        rankTotalEl.hidden = false;
        rankTotalEl.removeAttribute('hidden');
        return;
    }
    clearCombinedRankTotal(rankTotalEl);
}

export function buildModalRunsPayload(source, {
    currentTrackKey = null,
    updates = null
} = {}) {
    if (!source || typeof source !== 'object') return null;

    const normalized = {
        lapTimesArray: source.listData ?? source.lapTimesArray ?? null,
        bestTime: source.bestTime ?? source.lapTime ?? null,
        currentTime: source.currentTime ?? source.lapTime ?? null,
        scoreboardChallengeId: source.scoreboardChallengeId || null,
        scoreboardTrackKey: source.scoreboardTrackKey || source.trackKey || currentTrackKey || null,
        scoreboardSnapshot: source.scoreboardSnapshot ?? null,
        scoreboardMode: source.scoreboardMode || 'daily',
        scoreboardTitle: source.scoreboardTitle || null,
        scoreboardSubhead: source.scoreboardSubhead || null,
        leaderboardDayOptions: Array.isArray(source.leaderboardDayOptions)
            ? source.leaderboardDayOptions
            : null,
        selectedLeaderboardDayId: source.selectedLeaderboardDayId || null,
        onSelectLeaderboardDay: typeof source.onSelectLeaderboardDay === 'function'
            ? source.onSelectLeaderboardDay
            : null,
        onLoadMoreLeaderboard: typeof source.onLoadMoreLeaderboard === 'function'
            ? source.onLoadMoreLeaderboard
            : null,
        onOpenStandings: typeof source.onOpenStandings === 'function'
            ? source.onOpenStandings
            : null,
        primaryActionLabel: source.primaryActionLabel || null,
        primaryAction: typeof source.primaryAction === 'function' ? source.primaryAction : null,
        showGlobalLeaderboard: source.showGlobalLeaderboard !== false,
        allowLeaderboardOpen: source.allowLeaderboardOpen !== false
    };
    if (typeof source.leaderboardRailLabel === 'string' && source.leaderboardRailLabel) {
        normalized.leaderboardRailLabel = source.leaderboardRailLabel;
    }
    if (typeof source.onRaceOpponent === 'function') {
        normalized.onRaceOpponent = source.onRaceOpponent;
    }

    if (!updates || typeof updates !== 'object') {
        return normalized;
    }

    if (hasOwnValue(updates, 'bestTime') && updates.bestTime !== undefined) {
        normalized.bestTime = updates.bestTime;
    }
    if (hasOwnValue(updates, 'currentTime') && updates.currentTime !== undefined) {
        normalized.currentTime = updates.currentTime;
    }
    if (hasOwnValue(updates, 'lapTimesArray') && updates.lapTimesArray !== undefined) {
        normalized.lapTimesArray = updates.lapTimesArray;
    }
    if (hasOwnValue(updates, 'scoreboardSnapshot') && updates.scoreboardSnapshot !== undefined) {
        normalized.scoreboardSnapshot = updates.scoreboardSnapshot || null;
    }
    if (hasOwnValue(updates, 'leaderboardDayOptions') && updates.leaderboardDayOptions !== undefined) {
        normalized.leaderboardDayOptions = Array.isArray(updates.leaderboardDayOptions)
            ? updates.leaderboardDayOptions
            : null;
    }
    if (hasOwnValue(updates, 'onSelectLeaderboardDay') && updates.onSelectLeaderboardDay !== undefined) {
        normalized.onSelectLeaderboardDay = typeof updates.onSelectLeaderboardDay === 'function'
            ? updates.onSelectLeaderboardDay
            : null;
    }

    return normalized;
}

export function buildModalRunsViewOptions(payload) {
    if (!payload || typeof payload !== 'object') return {};

    const options = {
        scoreboardChallengeId: payload.scoreboardChallengeId || null,
        scoreboardSnapshot: payload.scoreboardSnapshot || null,
        scoreboardMode: payload.scoreboardMode || 'daily',
        scoreboardTrackKey: payload.scoreboardTrackKey || null,
        scoreboardTitle: payload.scoreboardTitle || null,
        scoreboardSubhead: payload.scoreboardSubhead || null,
        leaderboardDayOptions: Array.isArray(payload.leaderboardDayOptions)
            ? payload.leaderboardDayOptions
            : null,
        selectedLeaderboardDayId: payload.selectedLeaderboardDayId || null,
        onSelectLeaderboardDay: typeof payload.onSelectLeaderboardDay === 'function'
            ? payload.onSelectLeaderboardDay
            : null,
        onLoadMoreLeaderboard: typeof payload.onLoadMoreLeaderboard === 'function'
            ? payload.onLoadMoreLeaderboard
            : null,
        onOpenStandings: typeof payload.onOpenStandings === 'function'
            ? payload.onOpenStandings
            : null,
        primaryActionLabel: payload.primaryActionLabel || null,
        primaryAction: typeof payload.primaryAction === 'function' ? payload.primaryAction : null,
        showGlobalLeaderboard: payload.showGlobalLeaderboard !== false,
        allowLeaderboardOpen: payload.allowLeaderboardOpen !== false
    };
    if (typeof payload.leaderboardRailLabel === 'string' && payload.leaderboardRailLabel) {
        options.leaderboardRailLabel = payload.leaderboardRailLabel;
    }
    if (typeof payload.onRaceOpponent === 'function') {
        options.onRaceOpponent = payload.onRaceOpponent;
    }
    return options;
}

