import { TRACK_MODE_DAILY_GP } from '../config.js?v=2.09';
import { TRACKS } from '../track/tracks.js?v=2.09';
import { isLocalEnvironment } from '../track/environment.js?v=2.09';
import {
    buildServiceHeaders,
    clampRequestLimit,
    getBaseApiConfig,
    getGuestPlayerToken,
    getOrCreatePlayerId,
} from './api-client.js?v=2.09';

const MAX_SCOREBOARD_LIMIT = 100;
const DEFAULT_SCOREBOARD_PREVIEW_LIMIT = 10;

/** Same-key concurrent callers share one network round-trip. */
const inflightScoreboardSnapshots = new Map();

function getScoreboardConfig() {
    return getBaseApiConfig();
}

function normalizeScoreboardRpcPayload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const normalizeRow = (row) => {
        if (!row || typeof row !== 'object') return null;
        const bestTime = Number(row.bestTime);
        const bestTimeSec = Number(row.bestTimeSec);
        const bestTimeMs = Number(row.bestTimeMs);
        return {
            ...row,
            bestTime: Number.isFinite(bestTime)
                ? bestTime
                : Number.isFinite(bestTimeSec)
                    ? bestTimeSec
                    : Number.isFinite(bestTimeMs)
                        ? bestTimeMs / 1000
                        : row.bestTime,
        };
    };
    return {
        topRows: Array.isArray(raw.topRows) ? raw.topRows.map(normalizeRow).filter(Boolean) : [],
        nearbyRows: Array.isArray(raw.nearbyRows) ? raw.nearbyRows.map(normalizeRow).filter(Boolean) : [],
        currentPlayerRow: raw.currentPlayerRow && typeof raw.currentPlayerRow === 'object'
            ? normalizeRow(raw.currentPlayerRow)
            : null,
        totalCount: Number(raw.totalCount) || 0,
        leaderboardEntryCount: raw.leaderboardEntryCount != null && Number.isFinite(Number(raw.leaderboardEntryCount))
            ? Math.max(0, Math.trunc(Number(raw.leaderboardEntryCount)))
            : (Number(raw.totalCount) || 0),
        playerRank: raw.playerRank != null && Number.isFinite(Number(raw.playerRank))
            ? Number(raw.playerRank)
            : null,
        playerRankLabel: raw.playerRankLabel != null ? String(raw.playerRankLabel) : null
    };
}

async function fetchScoreboardSnapshotViaProxy(config, trackKey, playerId, safeLimit) {
    const origin = typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost';
    const url = new URL(config.scoreboardSnapshotUrl, origin);
    url.searchParams.set('trackKey', trackKey);
    url.searchParams.set('playerId', playerId);
    const guestToken = getGuestPlayerToken();
    if (guestToken) {
        url.searchParams.set('guestToken', guestToken);
    }
    url.searchParams.set('limit', safeLimit.toString());

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: buildServiceHeaders(config)
    });
    if (!response.ok) {
        const err = new Error(`Scoreboard proxy failed: ${response.status}`);
        err.status = response.status;
        throw err;
    }
    return response.json();
}

export async function getScoreboardSnapshot({ trackKey, limit = DEFAULT_SCOREBOARD_PREVIEW_LIMIT } = {}) {
    const emptySnapshot = () => ({
        topRows: [],
        nearbyRows: [],
        currentPlayerRow: null,
        totalCount: 0,
        leaderboardEntryCount: 0,
        playerRank: null,
        playerRankLabel: null
    });

    const config = getScoreboardConfig();
    if (!config || typeof fetch !== 'function') {
        return emptySnapshot();
    }
    if (!TRACKS[trackKey]) {
        return emptySnapshot();
    }

    const safeLimit = clampRequestLimit(limit, {
        defaultLimit: DEFAULT_SCOREBOARD_PREVIEW_LIMIT,
        maxLimit: MAX_SCOREBOARD_LIMIT
    });
    const dedupeKey = `${trackKey}\u0000${TRACK_MODE_DAILY_GP}\u0000${safeLimit}`;
    const inflight = inflightScoreboardSnapshots.get(dedupeKey);
    if (inflight) return inflight;

    const promise = (async () => {
        const currentPlayerId = getOrCreatePlayerId('scoreboard');

        try {
            const raw = await fetchScoreboardSnapshotViaProxy(
                config,
                trackKey,
                currentPlayerId,
                safeLimit
            );
            return normalizeScoreboardRpcPayload(raw) || emptySnapshot();
        } catch (error) {
            if (isLocalEnvironment()) {
                console.warn('Scoreboard snapshot fetch failed, falling back to empty:', error);
            } else {
                console.error('Scoreboard snapshot fetch failed:', error);
            }
            return emptySnapshot();
        }
    })();

    inflightScoreboardSnapshots.set(dedupeKey, promise);
    promise.finally(() => {
        if (inflightScoreboardSnapshots.get(dedupeKey) === promise) {
            inflightScoreboardSnapshots.delete(dedupeKey);
        }
    });
    return promise;
}
