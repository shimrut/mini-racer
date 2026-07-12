function normalizeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeCount(value, fallback = 0) {
    const count = normalizeNumber(value);
    return count === null ? fallback : Math.max(0, Math.trunc(count));
}

function normalizeBestTimeSec(row) {
    if (!row || typeof row !== 'object') return null;
    const bestTime = normalizeNumber(row.bestTime);
    if (bestTime !== null) return bestTime;
    const bestTimeSec = normalizeNumber(row.bestTimeSec);
    if (bestTimeSec !== null) return bestTimeSec;
    const bestTimeMs = normalizeNumber(row.bestTimeMs);
    return bestTimeMs !== null ? bestTimeMs / 1000 : null;
}

function normalizeCompletedLaps(value) {
    const laps = normalizeNumber(value);
    return laps === null ? null : Math.max(0, Math.trunc(laps));
}

function normalizeSnapshotRow(row) {
    if (!row || typeof row !== 'object') return null;
    const normalized = { ...row };
    const bestTime = normalizeBestTimeSec(row);
    if (bestTime !== null) {
        normalized.bestTime = bestTime;
    }
    const completedLaps = normalizeCompletedLaps(row.completedLaps);
    if (completedLaps !== null) {
        normalized.completedLaps = completedLaps;
    }
    return normalized;
}

function cloneSnapshotRow(row) {
    if (!row || typeof row !== 'object') return null;
    return {
        ...row,
        checkpointTimesSec: Array.isArray(row.checkpointTimesSec)
            ? row.checkpointTimesSec.slice()
            : row.checkpointTimesSec,
    };
}

export function createEmptyScoreboardSnapshot({ objectiveType = null } = {}) {
    return {
        topRows: [],
        nearbyRows: [],
        currentPlayerRow: null,
        totalCount: 0,
        leaderboardEntryCount: 0,
        objectiveType,
        playerRank: null,
        playerRankLabel: null,
        pageOffset: 0,
        pageLimit: 0,
        hasMore: false,
        nextOffset: null,
    };
}

export function normalizeScoreboardSnapshot(raw) {
    if (!raw || typeof raw !== 'object') {
        return createEmptyScoreboardSnapshot();
    }

    const totalCount = normalizeCount(raw.totalCount);
    const leaderboardEntryCount = raw.leaderboardEntryCount == null
        ? totalCount
        : normalizeCount(raw.leaderboardEntryCount, totalCount);

    return {
        topRows: Array.isArray(raw.topRows)
            ? raw.topRows.map(normalizeSnapshotRow).filter(Boolean)
            : [],
        nearbyRows: Array.isArray(raw.nearbyRows)
            ? raw.nearbyRows.map(normalizeSnapshotRow).filter(Boolean)
            : [],
        currentPlayerRow: normalizeSnapshotRow(raw.currentPlayerRow),
        totalCount,
        leaderboardEntryCount,
        objectiveType: typeof raw.objectiveType === 'string' ? raw.objectiveType : null,
        playerRank: raw.playerRank != null ? normalizeNumber(raw.playerRank) : null,
        playerRankLabel: raw.playerRankLabel != null ? String(raw.playerRankLabel) : null,
        pageOffset: normalizeCount(raw.pageOffset),
        pageLimit: normalizeCount(raw.pageLimit),
        hasMore: raw.hasMore === true,
        nextOffset: raw.nextOffset != null ? normalizeCount(raw.nextOffset) : null,
    };
}

export function cloneScoreboardSnapshot(snapshot) {
    const normalized = normalizeScoreboardSnapshot(snapshot);
    return {
        ...normalized,
        topRows: normalized.topRows.map(cloneSnapshotRow),
        nearbyRows: normalized.nearbyRows.map(cloneSnapshotRow),
        currentPlayerRow: cloneSnapshotRow(normalized.currentPlayerRow),
    };
}
