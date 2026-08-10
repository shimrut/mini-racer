import { TRACK_MODE_DAILY_GP } from '../config.js';
import { hasTrack } from '../track/catalog.js';
import {
    API_ROUTES,
    clampRequestLimit,
} from './api-client.js';
import {
    getGuestPlayerToken,
    getOrCreatePlayerId,
} from './player-identity.js';
import {
    createEmptyScoreboardSnapshot,
    normalizeScoreboardSnapshot,
} from './snapshot.js';

const MAX_SCOREBOARD_LIMIT = 100;
const DEFAULT_SCOREBOARD_LIMIT = 10;

const inflightScoreboardSnapshots = new Map();

async function fetchScoreboardSnapshotViaProxy(config, trackKey, playerId, safeLimit, safeOffset) {
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
    url.searchParams.set('offset', safeOffset.toString());

    const response = await fetch(url.toString(), { method: 'GET' });
    if (!response.ok) {
        const err = new Error(`Scoreboard proxy failed: ${response.status}`);
        err.status = response.status;
        throw err;
    }
    return response.json();
}

export async function getScoreboardSnapshot({
    trackKey,
    limit = DEFAULT_SCOREBOARD_LIMIT,
    offset = 0,
} = {}) {
    const config = API_ROUTES;
    if (!config || typeof fetch !== 'function') {
        return createEmptyScoreboardSnapshot();
    }
    if (!hasTrack(trackKey)) {
        return createEmptyScoreboardSnapshot();
    }

    const safeLimit = clampRequestLimit(limit, {
        defaultLimit: DEFAULT_SCOREBOARD_LIMIT,
        maxLimit: MAX_SCOREBOARD_LIMIT
    });
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const dedupeKey = `${trackKey}\u0000${TRACK_MODE_DAILY_GP}\u0000${safeOffset}\u0000${safeLimit}`;
    const inflight = inflightScoreboardSnapshots.get(dedupeKey);
    if (inflight) return inflight;

    const promise = (async () => {
        const currentPlayerId = getOrCreatePlayerId('scoreboard');
        const raw = await fetchScoreboardSnapshotViaProxy(
            config,
            trackKey,
            currentPlayerId,
            safeLimit,
            safeOffset
        );
        return normalizeScoreboardSnapshot(raw);
    })();

    inflightScoreboardSnapshots.set(dedupeKey, promise);
    const clearInflight = () => {
        if (inflightScoreboardSnapshots.get(dedupeKey) === promise) {
            inflightScoreboardSnapshots.delete(dedupeKey);
        }
    };
    void promise.then(clearInflight, clearInflight);
    return promise;
}
