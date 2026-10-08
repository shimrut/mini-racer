import { API_ROUTES } from '../scoreboard/api-client.js';
import { ensureStoredTracks, registerStoredTracksFromPayload } from '../track/stored-track-service.js';
import { markStoredSeriesLoaded, registerStoredSeries } from './stored-series.js';
import {
    CAMPAIGN_ID,
    getCampaignSeriesStages,
    getCampaignUnlockedRaceIds,
    isCampaignSeriesId,
} from './manifest.js';
import {
    clearCampaignVerification,
    getCampaignVerificationEntries,
} from '../scoreboard/verification-queue.js';
import { playerIdentityBody, playerRequestUrl, requestJsonWithTimeout } from '../scoreboard/player-request.js';

export const CAMPAIGN_REQUEST_TIMEOUT_MS = 20_000;

function requestJson(url, options = {}) {
    return requestJsonWithTimeout(url, options, CAMPAIGN_REQUEST_TIMEOUT_MS);
}

const LEGACY_PENDING_RESULTS_KEY = `MiniRacerCampaignPending:${CAMPAIGN_ID}`;
// The series this device showed last. Only a convenience: the server keeps no choice.
const SELECTED_SERIES_KEY = 'MiniRacerCampaignSeries:v1';

export function readSelectedCampaignSeriesId() {
    try {
        const value = globalThis.localStorage?.getItem(SELECTED_SERIES_KEY);
        return isCampaignSeriesId(value) ? value : CAMPAIGN_ID;
    } catch {
        return CAMPAIGN_ID;
    }
}

export function writeSelectedCampaignSeriesId(seriesId) {
    if (!isCampaignSeriesId(seriesId)) return;
    try {
        globalThis.localStorage?.setItem(SELECTED_SERIES_KEY, seriesId);
    } catch {}
}

function emptyResults() {
    return Object.create(null);
}

function normalizeSeriesId(value) {
    return isCampaignSeriesId(value) ? value : CAMPAIGN_ID;
}

function normalizeResults(value, seriesId) {
    const source = value && typeof value === 'object' ? value : {};
    const results = emptyResults();
    for (const stage of getCampaignSeriesStages(seriesId)) {
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

// The progress of one series. Each series counts only its own medals.
export function deriveCampaignProgress(resultsByRaceId = {}, startedAt = null, seriesId = CAMPAIGN_ID) {
    const series = normalizeSeriesId(seriesId);
    const stages = getCampaignSeriesStages(series);
    const seriesRaceIds = new Set(stages.map((stage) => stage.raceId));
    const normalized = normalizeResults(resultsByRaceId, series);
    const unlockedRaceIds = getCampaignUnlockedRaceIds(normalized)
        .filter((raceId) => seriesRaceIds.has(raceId));
    return {
        campaignId: series,
        startedAt: typeof startedAt === 'string' ? startedAt : null,
        resultsByRaceId: normalized,
        unlockedRaceIds,
        complete: stages.every((stage) => (
            ['gold', 'author'].includes(normalized[stage.raceId]?.medal)
        )),
    };
}

export function normalizeCampaignStandings(value, seriesId = CAMPAIGN_ID) {
    const source = value && typeof value === 'object' ? value : {};
    const standings = Object.create(null);
    for (const stage of getCampaignSeriesStages(normalizeSeriesId(seriesId))) {
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

function unavailableCampaignBootstrap(seriesId = CAMPAIGN_ID) {
    return {
        availability: 'unavailable',
        authoritative: false,
        campaignId: seriesId,
        ranked: false,
        signedIn: false,
        stages: getCampaignSeriesStages(seriesId),
        progress: deriveCampaignProgress({}, null, seriesId),
        standingsByRaceId: normalizeCampaignStandings(null, seriesId),
        carUnlocks: null,
    };
}

function clearLegacyPendingCampaignResults() {
    try {
        globalThis.localStorage?.removeItem(LEGACY_PENDING_RESULTS_KEY);
    } catch {}
}

export async function getCampaignBootstrap({ seriesId = CAMPAIGN_ID } = {}) {
    clearLegacyPendingCampaignResults();
    // A post can name a Creator series before its catalog reaches this client.
    const requestedSeriesId = typeof seriesId === 'string' && seriesId.trim()
        ? seriesId.trim() : CAMPAIGN_ID;
    if (typeof fetch !== 'function') return unavailableCampaignBootstrap(requestedSeriesId);
    try {
        const url = playerRequestUrl(API_ROUTES.campaignBootstrapUrl);
        if (requestedSeriesId !== CAMPAIGN_ID) url.searchParams.set('seriesId', requestedSeriesId);
        const response = await requestJson(url.toString());
        if (!response.ok || !response.body) throw new Error(`Campaign bootstrap failed: ${response.status}`);
        if (Array.isArray(response.body.storedSeries)) registerStoredSeries(response.body.storedSeries);
        if ((response.body.campaignId ?? CAMPAIGN_ID) !== requestedSeriesId) {
            throw new Error('The requested Campaign is unavailable.');
        }
        // A good answer always carries the whole list; stage tracks can still fail to load.
        markStoredSeriesLoaded();
        const trackKeys = (Array.isArray(response.body.stages)
            ? response.body.stages
            : getCampaignSeriesStages(normalizeSeriesId(response.body.campaignId)))
            .map((stage) => stage.trackKey);
        registerStoredTracksFromPayload(response.body.storedTracks, { confirmedTrackKeys: trackKeys });
        await ensureStoredTracks(trackKeys, { requireConfirmation: true });
        const ranked = response.body.ranked === true;
        const authoritative = ranked
            && response.body.campaignProgressPromotionPending !== true;
        const seriesId = normalizeSeriesId(response.body.campaignId);
        const progress = deriveCampaignProgress(
            response.body.progress?.resultsByRaceId,
            response.body.progress?.startedAt ?? response.body.progress?.updatedAt,
            seriesId,
        );
        clearSettledCampaignVerificationMarkers(progress.resultsByRaceId);
        return {
            availability: authoritative ? 'available' : 'unavailable',
            authoritative,
            campaignId: seriesId,
            ranked,
            signedIn: response.body.signedIn === true,
            stages: Array.isArray(response.body.stages) ? response.body.stages : getCampaignSeriesStages(seriesId),
            series: Array.isArray(response.body.series) ? response.body.series : [],
            progress,
            standingsByRaceId: normalizeCampaignStandings(response.body.standingsByRaceId, seriesId),
            carUnlocks: response.body.carUnlocks ?? null,
        };
    } catch {
        return unavailableCampaignBootstrap(requestedSeriesId);
    }
}

function clearSettledCampaignVerificationMarkers(resultsByRaceId) {
    const entries = getCampaignVerificationEntries();
    for (const [raceId, entry] of Object.entries(entries)) {
        if (entry?.verificationState !== 'error') continue;
        const verifiedBestTimeMs = Number(resultsByRaceId?.[raceId]?.bestTimeMs);
        const queuedBestTimeMs = Math.round(Number(entry.bestTime) * 1000);
        if (
            Number.isSafeInteger(verifiedBestTimeMs)
            && verifiedBestTimeMs > 0
            && Number.isSafeInteger(queuedBestTimeMs)
            && queuedBestTimeMs > 0
            && verifiedBestTimeMs <= queuedBestTimeMs
        ) {
            clearCampaignVerification(raceId);
        }
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
    const url = playerRequestUrl(API_ROUTES.campaignSnapshotUrl);
    url.searchParams.set('raceId', raceId);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    return requestJson(url.toString());
}

export async function getCampaignAggregate(seriesId, { limit = 50, offset = 0 } = {}) {
    const url = playerRequestUrl(API_ROUTES.campaignAggregateUrl);
    url.searchParams.set('seriesId', seriesId);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    return requestJson(url.toString());
}

export async function submitCampaignRun({ raceId, trackKey, replay, submissionOwnerId = null }) {
    return requestJson(API_ROUTES.campaignSubmitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(playerIdentityBody({ raceId, trackKey, replay, submissionOwnerId })),
    });
}

export async function previewCampaignResultsShare({ seriesId }) {
    return requestJson(API_ROUTES.campaignSharePreviewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId }),
    });
}

export async function confirmCampaignResultsShare(shareToken) {
    return requestJson(API_ROUTES.campaignShareConfirmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken }),
    });
}

export async function getCampaignPbGhost(raceId) {
    const url = playerRequestUrl(API_ROUTES.campaignPbGhostUrl);
    url.searchParams.set('raceId', raceId);
    return requestJson(url.toString());
}
