import {
    API_ROUTES,
    getGuestPlayerToken,
    getOrCreatePlayerId,
} from '../scoreboard/api-client.js';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    getCampaignUnlockedRaceIds,
} from './manifest.js';

export const CAMPAIGN_REQUEST_TIMEOUT_MS = 20_000;

function emptyResults() {
    return Object.create(null);
}

function normalizeResults(value) {
    const source = value && typeof value === 'object' ? value : {};
    const results = emptyResults();
    for (const stage of CAMPAIGN_STAGES) {
        const raw = source[stage.raceId];
        if (!raw || typeof raw !== 'object') continue;
        const bestTimeMs = Number(raw.bestTimeMs);
        if (!Number.isSafeInteger(bestTimeMs) || bestTimeMs <= 0) continue;
        results[stage.raceId] = {
            raceId: stage.raceId,
            bestTimeMs,
            bestTime: bestTimeMs / 1000,
            medal: ['author', 'gold', 'silver', 'bronze'].includes(raw.medal)
                ? raw.medal
                : null,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
        };
    }
    return results;
}

export function deriveCampaignProgress(resultsByRaceId = {}, startedAt = null) {
    const normalized = normalizeResults(resultsByRaceId);
    const unlockedRaceIds = getCampaignUnlockedRaceIds(normalized);
    const continueStage = CAMPAIGN_STAGES.find((stage) => (
        unlockedRaceIds.includes(stage.raceId)
        && !['gold', 'author'].includes(normalized[stage.raceId]?.medal)
    )) ?? null;
    return {
        campaignId: CAMPAIGN_ID,
        startedAt: typeof startedAt === 'string' ? startedAt : null,
        resultsByRaceId: normalized,
        unlockedRaceIds,
        complete: CAMPAIGN_STAGES.every((stage) => (
            ['gold', 'author'].includes(normalized[stage.raceId]?.medal)
        )),
        continueRaceId: continueStage?.raceId ?? null,
    };
}

async function requestJson(url, options = {}) {
    const controller = typeof AbortController === 'function' && !options.signal
        ? new AbortController()
        : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), CAMPAIGN_REQUEST_TIMEOUT_MS)
        : null;
    try {
        const response = await fetch(url, controller
            ? { ...options, signal: controller.signal }
            : options);
        const body = await response.json().catch(() => null);
        return { ok: response.ok, status: response.status, body };
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
    }
}

/**
 * Campaign ranks guests the same way Daily does, so every request carries the
 * player identity. A signed-in request has its username attached server-side
 * and ignores these.
 */
function withPlayerIdentity(url) {
    url.searchParams.set('playerId', getOrCreatePlayerId('campaign'));
    const guestToken = getGuestPlayerToken();
    if (guestToken) url.searchParams.set('guestToken', guestToken);
    return url;
}

function playerIdentityBody(extra = {}) {
    return {
        ...extra,
        playerId: getOrCreatePlayerId('campaign'),
        guestToken: getGuestPlayerToken(),
    };
}

function campaignUrl(route) {
    return withPlayerIdentity(
        new URL(route, globalThis.location?.origin ?? 'http://localhost'),
    );
}

/** Rank and field size per stage, as the bootstrap reports them. */
export function normalizeCampaignStandings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const standings = Object.create(null);
    for (const stage of CAMPAIGN_STAGES) {
        const raw = source[stage.raceId];
        if (!raw || typeof raw !== 'object') continue;
        const rank = Number(raw.rank);
        const totalCount = Number(raw.totalCount);
        standings[stage.raceId] = {
            rank: Number.isInteger(rank) && rank > 0 ? rank : null,
            totalCount: Number.isInteger(totalCount) && totalCount > 0 ? totalCount : 0,
        };
    }
    return standings;
}

/**
 * Progress is whatever the server says it is, for guests as much as for signed-in
 * players — both are ranked server-side. An unreachable server therefore reports
 * nothing rather than inventing a local ladder that would disagree with it.
 */
function unavailableCampaignBootstrap() {
    return {
        campaignId: CAMPAIGN_ID,
        ranked: false,
        signedIn: false,
        stages: CAMPAIGN_STAGES,
        progress: deriveCampaignProgress(),
        standingsByRaceId: normalizeCampaignStandings(null),
    };
}

export async function getCampaignBootstrap() {
    if (typeof fetch !== 'function') return unavailableCampaignBootstrap();
    try {
        const response = await requestJson(campaignUrl(API_ROUTES.campaignBootstrapUrl).toString());
        if (!response.ok || !response.body) throw new Error(`Campaign bootstrap failed: ${response.status}`);
        return {
            campaignId: CAMPAIGN_ID,
            ranked: response.body.ranked === true,
            signedIn: response.body.signedIn === true,
            stages: Array.isArray(response.body.stages) ? response.body.stages : CAMPAIGN_STAGES,
            progress: deriveCampaignProgress(
                response.body.progress?.resultsByRaceId,
                response.body.progress?.startedAt ?? response.body.progress?.updatedAt,
            ),
            standingsByRaceId: normalizeCampaignStandings(response.body.standingsByRaceId),
        };
    } catch {
        return unavailableCampaignBootstrap();
    }
}

export async function startServerCampaignRace(raceId) {
    return requestJson(API_ROUTES.campaignStartUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(playerIdentityBody({ raceId })),
    });
}

export async function getCampaignSnapshot(raceId, { limit = 50, offset = 0 } = {}) {
    const url = campaignUrl(API_ROUTES.campaignSnapshotUrl);
    url.searchParams.set('raceId', raceId);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    return requestJson(url.toString());
}

export async function submitCampaignRun({ raceId, trackKey, replay }) {
    return requestJson(API_ROUTES.campaignSubmitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(playerIdentityBody({ raceId, trackKey, replay })),
    });
}

export async function getCampaignPbGhost(raceId) {
    const url = campaignUrl(API_ROUTES.campaignPbGhostUrl);
    url.searchParams.set('raceId', raceId);
    return requestJson(url.toString());
}

export async function previewCampaignChallenge(input) {
    return requestJson(API_ROUTES.campaignChallengePreviewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
}

export async function createCampaignChallenge(challengeToken) {
    return requestJson(API_ROUTES.campaignChallengeCreateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken }),
    });
}

export async function getCampaignChallenge(challengeId) {
    const url = new URL(API_ROUTES.campaignChallengeUrl, globalThis.location?.origin ?? 'http://localhost');
    url.searchParams.set('challengeId', challengeId);
    return requestJson(url.toString());
}

export async function submitCampaignChallengeRun({ challengeId, replay }) {
    return requestJson(API_ROUTES.campaignChallengeSubmitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId, replay }),
    });
}

export async function previewCampaignChallengeBrag({ challengeId }) {
    return requestJson(API_ROUTES.campaignChallengeBragPreviewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId }),
    });
}

export async function confirmCampaignChallengeBrag(shareToken) {
    return requestJson(API_ROUTES.campaignChallengeBragConfirmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken }),
    });
}
