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

const PENDING_RESULTS_KEY = `MiniRacerCampaignPending:${CAMPAIGN_ID}`;

function readPendingResults(root = globalThis) {
    try {
        const raw = root?.localStorage?.getItem(PENDING_RESULTS_KEY);
        return raw ? normalizeResults(JSON.parse(raw)) : emptyResults();
    } catch {
        return emptyResults();
    }
}

function writePendingResults(results, root = globalThis) {
    try {
        root?.localStorage?.setItem(PENDING_RESULTS_KEY, JSON.stringify(results));
    } catch {
    }
}

export function recordPendingCampaignResult(raceId, { bestTimeMs, medal }, root = globalThis) {
    const results = readPendingResults(root);
    const previous = results[raceId];
    if (previous && Number(previous.bestTimeMs) <= Number(bestTimeMs)) return results;
    const next = {
        ...results,
        [raceId]: { raceId, bestTimeMs, medal, updatedAt: new Date().toISOString() },
    };
    writePendingResults(next, root);
    return next;
}

export function clearPendingCampaignResult(raceId, root = globalThis) {
    const results = readPendingResults(root);
    if (!results[raceId]) return results;
    const { [raceId]: _settled, ...rest } = results;
    writePendingResults(rest, root);
    return rest;
}

export function getPendingCampaignResults(root = globalThis) {
    return readPendingResults(root);
}

export function mergePendingCampaignResults(serverResults, pendingResults) {
    const merged = { ...normalizeResults(serverResults) };
    for (const [raceId, pending] of Object.entries(normalizeResults(pendingResults))) {
        const verified = merged[raceId];
        if (verified && Number(verified.bestTimeMs) <= Number(pending.bestTimeMs)) continue;
        merged[raceId] = pending;
    }
    return merged;
}

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

function unavailableCampaignBootstrap() {
    return {
        availability: 'unavailable',
        authoritative: false,
        campaignId: CAMPAIGN_ID,
        ranked: false,
        signedIn: false,
        stages: CAMPAIGN_STAGES,
        progress: deriveCampaignProgress(getPendingCampaignResults()),
        standingsByRaceId: normalizeCampaignStandings(null),
        carUnlocks: null,
    };
}

export async function getCampaignBootstrap() {
    if (typeof fetch !== 'function') return unavailableCampaignBootstrap();
    try {
        const response = await requestJson(campaignUrl(API_ROUTES.campaignBootstrapUrl).toString());
        if (!response.ok || !response.body) throw new Error(`Campaign bootstrap failed: ${response.status}`);
        const ranked = response.body.ranked === true;
        const authoritative = ranked
            && response.body.campaignProgressPromotionPending !== true;
        return {
            availability: authoritative ? 'available' : 'unavailable',
            authoritative,
            campaignId: CAMPAIGN_ID,
            ranked,
            signedIn: response.body.signedIn === true,
            stages: Array.isArray(response.body.stages) ? response.body.stages : CAMPAIGN_STAGES,
            progress: deriveCampaignProgress(
                mergePendingCampaignResults(
                    response.body.progress?.resultsByRaceId,
                    getPendingCampaignResults(),
                ),
                response.body.progress?.startedAt ?? response.body.progress?.updatedAt,
            ),
            standingsByRaceId: normalizeCampaignStandings(response.body.standingsByRaceId),
            carUnlocks: response.body.carUnlocks ?? null,
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
