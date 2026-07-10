import { TRACK_MODE_DAILY_GP } from '../config.js';
import { TRACKS } from '../track/tracks.js';
import { isLocalEnvironment } from '../track/environment.js';
import {
    API_ROUTES,
    clampRequestLimit,
    getGuestPlayerToken,
    getOrCreatePlayerId,
} from './api-client.js';
import {
    createEmptyScoreboardSnapshot,
    normalizeScoreboardSnapshot,
} from './snapshot.js';

const MAX_SCOREBOARD_LIMIT = 100;
const DEFAULT_SCOREBOARD_PREVIEW_LIMIT = 10;

/** Same-key concurrent callers share one network round-trip. */
const inflightScoreboardSnapshots = new Map();

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

    const response = await fetch(url.toString(), { method: 'GET' });
    if (!response.ok) {
        const err = new Error(`Scoreboard proxy failed: ${response.status}`);
        err.status = response.status;
        throw err;
    }
    return response.json();
}

export async function getScoreboardSnapshot({ trackKey, limit = DEFAULT_SCOREBOARD_PREVIEW_LIMIT } = {}) {
    const config = API_ROUTES;
    if (!config || typeof fetch !== 'function') {
        return createEmptyScoreboardSnapshot();
    }
    if (!TRACKS[trackKey]) {
        return createEmptyScoreboardSnapshot();
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
            return normalizeScoreboardSnapshot(raw);
        } catch (error) {
            if (isLocalEnvironment()) {
                console.warn('Scoreboard snapshot fetch failed, falling back to empty:', error);
            } else {
                console.error('Scoreboard snapshot fetch failed:', error);
            }
            return createEmptyScoreboardSnapshot();
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
