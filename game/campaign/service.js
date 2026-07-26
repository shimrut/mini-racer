import { getMedalForRaceTime } from '../medals/medal-timing.js';
import { API_ROUTES } from '../scoreboard/api-client.js';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
} from './manifest.js';

const LOCAL_PROGRESS_KEY = `MiniRacerCampaignProgress:${CAMPAIGN_ID}`;
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
            // Kept so a guest result can be re-validated by the server if the
            // player signs in later. Guest medals themselves are never trusted.
            replay: raw.replay && typeof raw.replay === 'object' ? raw.replay : null,
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

export function readLocalCampaignProgress(root = globalThis) {
    try {
        const raw = root?.localStorage?.getItem(LOCAL_PROGRESS_KEY);
        if (!raw) return deriveCampaignProgress();
        const parsed = JSON.parse(raw);
        return deriveCampaignProgress(parsed?.resultsByRaceId, parsed?.startedAt);
    } catch {
        return deriveCampaignProgress();
    }
}

function writeLocalCampaignProgress(progress, root = globalThis) {
    try {
        root?.localStorage?.setItem(LOCAL_PROGRESS_KEY, JSON.stringify(progress));
    } catch {
        // Guest Campaign progress is best-effort browser state.
    }
    return progress;
}

export function startLocalCampaign(root = globalThis) {
    const current = readLocalCampaignProgress(root);
    if (current.startedAt) return current;
    return writeLocalCampaignProgress({
        ...current,
        startedAt: new Date().toISOString(),
    }, root);
}

export function saveLocalCampaignFinish(raceId, timeSec, {
    replay = null,
    root = globalThis,
} = {}) {
    const stage = getCampaignStage(raceId);
    const bestTimeMs = Math.round(Number(timeSec) * 1000);
    if (!stage || !Number.isSafeInteger(bestTimeMs) || bestTimeMs <= 0) {
        return readLocalCampaignProgress(root);
    }
    const current = startLocalCampaign(root);
    const previous = current.resultsByRaceId[raceId];
    if (previous && previous.bestTimeMs <= bestTimeMs) return current;
    const medal = getMedalForRaceTime(stage.trackKey, bestTimeMs / 1000, stage.lapCount);
    return writeLocalCampaignProgress(deriveCampaignProgress({
        ...current.resultsByRaceId,
        [raceId]: {
            raceId,
            bestTimeMs,
            medal,
            updatedAt: new Date().toISOString(),
            replay: replay && typeof replay === 'object' ? replay : null,
        },
    }, current.startedAt), root);
}

/**
 * Guest results that still carry a replay, in stage order.
 *
 * Order matters: the server refuses a locked stage, so a claim has to walk the
 * ladder from the bottom and let each accepted result unlock the next.
 */
export function getClaimableCampaignResults(progress) {
    const results = progress?.resultsByRaceId || {};
    return CAMPAIGN_STAGES
        .map((stage) => results[stage.raceId])
        .filter((result) => result?.replay && Number.isSafeInteger(result.bestTimeMs));
}

export function clearLocalCampaignProgress(root = globalThis) {
    try {
        root?.localStorage?.removeItem(LOCAL_PROGRESS_KEY);
    } catch {
        // Clearing claimed guest progress is best-effort browser state.
    }
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

export async function getCampaignBootstrap() {
    if (typeof fetch !== 'function') {
        return {
            campaignId: CAMPAIGN_ID,
            signedIn: false,
            stages: CAMPAIGN_STAGES,
            progress: readLocalCampaignProgress(),
        };
    }
    try {
        const response = await requestJson(API_ROUTES.campaignBootstrapUrl);
        if (!response.ok || !response.body) throw new Error(`Campaign bootstrap failed: ${response.status}`);
        return {
            campaignId: CAMPAIGN_ID,
            signedIn: response.body.signedIn === true,
            stages: Array.isArray(response.body.stages) ? response.body.stages : CAMPAIGN_STAGES,
            progress: response.body.signedIn === true
                ? deriveCampaignProgress(
                    response.body.progress?.resultsByRaceId,
                    response.body.progress?.startedAt ?? response.body.progress?.updatedAt,
                )
                : readLocalCampaignProgress(),
        };
    } catch {
        return {
            campaignId: CAMPAIGN_ID,
            signedIn: false,
            stages: CAMPAIGN_STAGES,
            progress: readLocalCampaignProgress(),
        };
    }
}

export async function startServerCampaignRace(raceId) {
    return requestJson(API_ROUTES.campaignStartUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId }),
    });
}

export async function getCampaignSnapshot(raceId, { limit = 50, offset = 0 } = {}) {
    const url = new URL(API_ROUTES.campaignSnapshotUrl, globalThis.location?.origin ?? 'http://localhost');
    url.searchParams.set('raceId', raceId);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    return requestJson(url.toString());
}

export async function submitCampaignRun({ raceId, trackKey, replay }) {
    return requestJson(API_ROUTES.campaignSubmitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId, trackKey, replay }),
    });
}

export async function getCampaignPbGhost(raceId) {
    const url = new URL(API_ROUTES.campaignPbGhostUrl, globalThis.location?.origin ?? 'http://localhost');
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

export { LOCAL_PROGRESS_KEY };
