import { API_ROUTES } from './api-client.js';
import {
    getGuestPlayerToken,
    getOrCreatePlayerId,
    setGuestPlayerToken,
} from './player-identity.js';
import { isLocalEnvironment } from '../track/environment.js';

function normalizeMode(value) {
    return value === 'daily' || value === 'campaign' ? value : null;
}
function normalizeRowSelection(entry) {
    const rank = Number(entry?.rank);
    const bestTimeMs = Number(entry?.bestTimeMs);
    const displayName = typeof entry?.displayName === 'string'
        ? entry.displayName.trim()
        : '';
    const updatedAt = typeof entry?.updatedAt === 'string'
        ? entry.updatedAt
        : '';
    if (
        !Number.isSafeInteger(rank)
        || rank < 1
        || !Number.isSafeInteger(bestTimeMs)
        || bestTimeMs <= 0
        || !displayName
        || !updatedAt
    ) {
        return null;
    }
    return {
        kind: 'row',
        rank,
        displayName,
        bestTimeMs,
        updatedAt,
    };
}

function normalizeNextSelection(benchmarkTimeMs) {
    const normalizedBenchmark = Number(benchmarkTimeMs);
    return {
        kind: 'next-faster',
        ...(Number.isSafeInteger(normalizedBenchmark) && normalizedBenchmark > 0
            ? { benchmarkTimeMs: normalizedBenchmark }
            : {}),
    };
}

export async function prepareLeaderboardOpponentRace({
    mode,
    competitionId,
    entry = null,
    nextFasterThanMs = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const normalizedMode = normalizeMode(mode);
    const normalizedCompetitionId = typeof competitionId === 'string'
        ? competitionId.trim()
        : '';
    const selection = entry
        ? normalizeRowSelection(entry)
        : normalizeNextSelection(nextFasterThanMs);
    if (
        !normalizedMode
        || !normalizedCompetitionId
        || !selection
        || typeof fetchImpl !== 'function'
    ) {
        return {
            ok: false,
            status: 400,
            body: { error: 'Invalid opponent race request.' },
        };
    }
    if (isLocalEnvironment()) {
        return {
            ok: false,
            status: 403,
            body: { error: 'Opponent race preparation is unavailable from localhost.' },
        };
    }

    const body = {
        mode: normalizedMode,
        ...(normalizedMode === 'daily'
            ? {
                challengeId: normalizedCompetitionId,
                playerId: getOrCreatePlayerId('leaderboard opponent race'),
                guestToken: getGuestPlayerToken(),
            }
            : { raceId: normalizedCompetitionId }),
        selection,
    };
    const response = await fetchImpl(API_ROUTES.leaderboardRacePrepareUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (normalizedMode === 'daily' && payload?.guestToken) {
        setGuestPlayerToken(payload.guestToken);
    }
    return {
        ok: response.ok,
        status: response.status,
        body: payload,
    };
}
