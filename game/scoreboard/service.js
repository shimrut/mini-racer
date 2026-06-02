import { TRACK_MODE_DAILY_GP } from '../config.js?v=2.09';
import { TRACKS } from '../track/tracks.js?v=2.09';
import { isLocalEnvironment } from '../track/environment.js?v=2.09';
import {
    buildServiceHeaders,
    clampRequestLimit,
    getBaseApiConfig,
    getOrCreatePlayerId,
} from './api-client.js?v=2.09';
import {
    getConstructedLeaderboardName,
} from '../shared/leaderboard-identity.js';
import {
    getLeaderboardIdentityPreference,
} from './display-preference.js?v=2.09';

const MIN_SCOREBOARD_TIME = 2.0;
const MAX_SCOREBOARD_TIME = 60 * 60;
const MAX_SCOREBOARD_LIMIT = 100;
const DEFAULT_SCOREBOARD_PREVIEW_LIMIT = 10;

/** Same-key concurrent callers share one network round-trip. */
const inflightScoreboardSnapshots = new Map();

function getScoreboardConfig() {
    return getBaseApiConfig();
}

function isValidScoreboardBestTime(bestTime) {
    return Number.isFinite(bestTime)
        && bestTime >= MIN_SCOREBOARD_TIME
        && bestTime <= MAX_SCOREBOARD_TIME;
}

export function getLeaderboardPlayerName(playerId) {
    return getConstructedLeaderboardName(playerId);
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
    url.searchParams.set('leaderboardIdentity', getLeaderboardIdentityPreference());
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

export async function submitScoreboardBestTime({ trackKey, bestTime, replay } = {}) {
    const config = getScoreboardConfig();
    if (!config || typeof fetch !== 'function') return null;
    if (
        !TRACKS[trackKey]
        || !isValidScoreboardBestTime(bestTime)
        || !replay
    ) {
        return null;
    }

    if (isLocalEnvironment()) {
        return {
            ok: false,
            status: 403,
            body: { error: 'Writing to the scoreboard is prohibited from localhost.' }
        };
    }

    const response = await fetch(config.scoreboardSubmitUrl, {
        method: 'POST',
        headers: {
            ...buildServiceHeaders(config),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            playerId: getOrCreatePlayerId('scoreboard'),
            trackKey,
            mode: TRACK_MODE_DAILY_GP,
            leaderboardIdentity: getLeaderboardIdentityPreference(),
            bestTime,
            replay
        })
    });

    return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => null)
    };
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
        if (isLocalEnvironment()) {
            return emptySnapshot();
        }
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
            console.error('Scoreboard snapshot fetch failed:', error);
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
